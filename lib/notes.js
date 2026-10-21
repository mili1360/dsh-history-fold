// ============================================================
//  notes.js -- dsh-history-fold 的第三个模块：把会话日志拆成可检索的记忆
// ============================================================
//  fold.js 只负责把老历史折成索引，archive 里只有"折过的"那部分；
//  recall.js 负责每轮把 archive + notes 搜一遍注入；
//  本模块负责把【整份会话日志】变成 notes/ 下的 markdown：
//    - day-YYYYMMDD.md   这一天每段对话的 诉求 / 结论 / 路径
//    - events-YYYY-MM.md 只留"定下来的事"（决定 规矩 安装 路径 根因 实测结论）
//  定时按日志 mtime 增量判断，日志没变就不干活。
//
//  为什么放在插件里而不是外部脚本：装完就该能用，不要求用户装 python。
//  多帧 zstd 自己扫帧头（node 的 zstdDecompress 只解第一帧）。
//
//  ASCII only on purpose -- this box runs a GBK code page.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// ---------------------------------------------------------------- defaults

export const NOTES_DEFAULTS = {
    enabled: true,
    // Relative to DSH_HOME unless absolute.
    dir: 'history-fold/notes',
    // How often to look at the session log's mtime. A pass costs ~4 s and only
    // runs when the log actually changed.
    refreshMinutes: 10,
    // Also produce events-YYYY-MM.md.
    events: true,
    // Marker score a line must reach to count as a durable event.
    minEventScore: 3,
    // First pass is delayed so boot is never slowed down by mining.
    startDelayMs: 45000,
    // Safety valve: refuse absurdly large logs rather than eat the heap.
    maxLogMB: 600,
    // Files kept out of recall's way are none; everything written here is searchable.
    logMarks: true,
}

const MEME_RE = /\[表情:[^\]]*\]/g
const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{10,}|ghp_[A-Za-z0-9]{10,})/g

// ---------------------------------------------------------------- zstd frames

const ZSTD_MAGIC = 0xfd2fb528

/**
 * Walk complete zstd frames without decompressing their blocks.
 * Mirrors the frame-header + block-header layout of RFC 8878:
 * magic(4) | descriptor(1) | [window] [dictid] [contentsize] | blocks... | [checksum(4)]
 * Returns { frames: [{start,end}], tornStart? } -- tornStart is a final frame cut off
 * by a log that is still being appended, which is normal for a live session.
 */
export function scanZstdFrames(buffer) {
    const frames = []
    let offset = 0
    while (offset < buffer.length) {
        const start = offset
        if (buffer.length - offset < 4) return { frames, tornStart: start }
        if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
            throw new Error('invalid frame magic at byte ' + offset)
        }
        offset += 4
        if (offset === buffer.length) return { frames, tornStart: start }
        const descriptor = buffer.readUInt8(offset)
        offset += 1
        if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit at byte ' + (offset - 1))
        const contentSizeFlag = descriptor >>> 6
        const singleSegment = (descriptor & 32) !== 0
        const checksum = (descriptor & 4) !== 0
        const dictionaryFlag = descriptor & 3
        const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
        const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
        const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
        if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
        offset += remainingHeaderBytes
        for (;;) {
            if (buffer.length - offset < 3) return { frames, tornStart: start }
            const blockHeader = buffer.readUIntLE(offset, 3)
            offset += 3
            const lastBlock = (blockHeader & 1) !== 0
            const blockType = (blockHeader >>> 1) & 3
            const blockSize = blockHeader >>> 3
            if (blockType === 3) throw new Error('reserved block type at byte ' + (offset - 3))
            const payloadBytes = blockType === 1 ? 1 : blockSize
            if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
            offset += payloadBytes
            if (lastBlock) break
        }
        if (checksum) {
            if (buffer.length - offset < 4) return { frames, tornStart: start }
            offset += 4
        }
        frames.push({ start, end: offset })
    }
    return { frames }
}

/** Decode every complete frame of a concatenated-frame log into one UTF-8 string. */
export function decodeSessionLog(buffer) {
    const { frames } = scanZstdFrames(buffer)
    const parts = []
    for (const f of frames) {
        try {
            parts.push(zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)))
        } catch { /* skip one damaged frame rather than lose the whole log */ }
    }
    return Buffer.concat(parts).toString('utf8')
}

// ---------------------------------------------------------------- mining

const clean = (s) => String(s || '').replace(MEME_RE, '').replace(SECRET_RE, '<redacted>').replace(/\r/g, '').trim()

function textOfParts(parts) {
    if (!Array.isArray(parts)) return ''
    return parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n').trim()
}

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (ms) => {
    const d = new Date(ms)
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
const dayFile = (ms) => 'day-' + dayKey(ms).replace(/-/g, '') + '.md'
const monthKey = (ms) => {
    const d = new Date(ms)
    return d.getFullYear() + '-' + pad(d.getMonth() + 1)
}

function firstLine(s, n) {
    const t = clean(s).split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
    return t.length > n ? t.slice(0, n) + '…' : t
}

function trimTo(s, n) {
    return s.length > n ? s.slice(0, n) + '\n…(截断)' : s
}

const PATH_RE = /[A-Za-z]:\\[^\s"'<>|，。；、）】`]+/g

function pathsOf(texts) {
    const set = new Map()
    for (const t of texts) {
        for (const m of String(t).matchAll(PATH_RE)) {
            const p = m[0].replace(/[.,;:）】]+$/, '')
            if (p.length < 6) continue
            set.set(p, (set.get(p) || 0) + 1)
        }
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map((e) => e[0])
}

const EVENT_MARKERS = [
    ['决定', 2], ['定了', 2], ['就按', 2], ['以后都', 3], ['统一', 1], ['规矩', 3], ['规则', 2],
    ['不要再', 2], ['不许', 3], ['禁止', 3], ['必须', 1], ['优先', 1],
    ['已装', 2], ['装好', 2], ['安装到', 2], ['备份在', 3], ['备份到', 3], ['路径是', 2],
    ['根因', 3], ['原因就是', 3], ['踩坑', 2], ['坑在', 2], ['修好', 2], ['改成', 1],
    ['结论', 1], ['实测', 1], ['验证通过', 2], ['确认', 1],
]

function eventScore(line) {
    let s = 0
    for (const [kw, w] of EVENT_MARKERS) if (line.includes(kw)) s += w
    if (/[A-Za-z]:\\/.test(line)) s += 1
    if (line.length < 8) s -= 2
    return s
}

const RULE_RE = /(以后|不要|必须|禁止|统一|规矩|规则)/

/**
 * Turn raw JSONL text into markdown memory files.
 * Pure: no IO. Returns { days: Map<name,md>, events: Map<name,md>, stats }.
 */
export function mineNotes(jsonlText, opts = {}) {
    const o = { ...NOTES_DEFAULTS, ...opts }
    const days = new Map() // file -> [{seq,time,user,said[]}]
    const seenEvents = new Set()
    const events = new Map() // month -> [{date,seq,line}]
    let userN = 0
    let asstN = 0

    let cur = null
    for (const line of jsonlText.split('\n')) {
        if (!line.trim()) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        const type = ev.type
        if (type === 'user/message') {
            const d = ev.data || {}
            const kind = d.source && d.source.kind
            if (kind && kind !== 'user') continue // steer / inject / followup are not the human
            const text = clean(textOfParts(d.content) || (typeof d.text === 'string' ? d.text : ''))
            if (!text) continue
            const file = dayFile(ev.time || Date.now())
            if (!days.has(file)) days.set(file, [])
            cur = { seq: ev.seq, time: ev.time, user: text, said: [] }
            days.get(file).push(cur)
            userN++
            if (o.events && RULE_RE.test(text)) pushEvent(events, seenEvents, ev, text, o, true)
            continue
        }
        if (type === 'assistant/message' && cur) {
            const msg = (ev.data && ev.data.message) || {}
            const text = clean(textOfParts(msg.content))
            if (text && !/^\[tool-call/.test(text)) {
                cur.said.push(text)
                asstN++
                if (o.events && cur.seq === (cur.seq | 0)) pushEvent(events, seenEvents, ev, text, o, false)
            }
        }
    }

    const dayMd = new Map()
    for (const [name, eps] of days) {
        const head = ['# 这一天（' + name.replace('day-', '').replace('.md', '') + '）', '', '由 DSH 会话日志自动拆分，非人工撰写。共 ' + eps.length + ' 段对话。', '']
        const body = []
        for (const ep of eps) {
            body.push('## ' + (firstLine(ep.user, 50) || '空请求'))
            body.push('')
            body.push('**用户：** ' + trimTo(ep.user, 700).replace(/\n/g, ' '))
            body.push('')
            if (ep.said.length) {
                body.push('**结论：** ' + trimTo(ep.said.slice(-2).join('\n\n'), 900))
                body.push('')
            }
            const ps = pathsOf([ep.user, ...ep.said])
            if (ps.length) {
                body.push('**路径：** ' + ps.map((p) => '`' + p + '`').join(' '))
                body.push('')
            }
            body.push('<!-- seq ' + (ep.seq === undefined ? '?' : ep.seq) + ' -->')
            body.push('')
        }
        dayMd.set(name, head.concat(body).join('\n'))
    }

    const eventMd = new Map()
    for (const [month, rows] of events) {
        const out = ['# 条目簿 ' + month, '', '本文件由程序从会话日志自动挑出，非人工撰写。每条带日期与 seq，细节回对应的 day 笔记。', '']
        for (const r of rows) {
            out.push('- **' + r.date + '** · ' + r.line + '  `' + dayFile(Date.parse(r.date + 'T12:00:00')) + ' #' + r.seq + '`')
        }
        eventMd.set('events-' + month + '.md', out.join('\n'))
    }

    return { days: dayMd, events: eventMd, stats: { userMessages: userN, assistantReplies: asstN, dayFiles: dayMd.size, eventFiles: eventMd.size, events: [...events.values()].reduce((s, r) => s + r.length, 0) } }
}

function pushEvent(events, seen, ev, text, o, fromUser) {
    const month = monthKey(ev.time || Date.now())
    // A human-stated rule is durable even when it is short ("以后别用管理员运行"), so it gets
    // a lower length gate and a bonus; model lines must carry a marker on their own.
    const minLen = fromUser ? 6 : 8
    for (const rawLine of text.split('\n')) {
        if (/^\|/.test(rawLine)) continue
        let line = rawLine.replace(/^[\s>*\-•#|]+/, '').replace(/\s+/g, ' ').trim()
        if (line.length < minLen) continue
        if (/^```/.test(line)) continue
        if (line.length > 200) line = line.slice(0, 200) + '…'
        let score = eventScore(line)
        if (fromUser && RULE_RE.test(line)) score += 2
        if (score < o.minEventScore) continue
        const key = line.replace(/[0-9]+/g, '#').slice(0, 60)
        if (seen.has(key)) continue
        seen.add(key)
        if (!events.has(month)) events.set(month, [])
        events.get(month).push({ date: dayKey(ev.time || Date.now()), seq: ev.seq, line })
    }
}

// ---------------------------------------------------------------- io

/** Newest real session log under <home>/sessions (skips .bak/.orig/.broken copies). */
export function newestSessionLog(home) {
    const root = path.join(home, 'sessions')
    let best = null
    const walk = (dir, depth) => {
        if (depth > 4) return
        let entries
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
            const full = path.join(dir, e.name)
            if (e.isDirectory()) { walk(full, depth + 1); continue }
            if (e.name !== 'session.jsonl.zstd') continue
            try {
                const st = fs.statSync(full)
                if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs, size: st.size }
            } catch { /* ignore */ }
        }
    }
    walk(root, 0)
    return best
}

/** Mine one log file and write the notes. Returns stats (never throws on a bad log). */
export function refreshNotes(opts = {}) {
    const o = { ...NOTES_DEFAULTS, ...opts }
    const home = o.home
    if (!home) return { ok: false, reason: 'no-home' }
    const dir = path.isAbsolute(o.dir) ? o.dir : path.join(home, o.dir)
    const log = o.logFile ? { file: o.logFile, mtimeMs: 0, size: 0 } : newestSessionLog(home)
    if (!log) return { ok: false, reason: 'no-session-log' }
    const mb = log.size / 1048576
    if (mb > o.maxLogMB) return { ok: false, reason: 'log-too-big:' + Math.round(mb) + 'MB' }

    let text
    try {
        text = decodeSessionLog(fs.readFileSync(log.file))
    } catch (e) {
        return { ok: false, reason: 'decode-failed:' + (e && e.message ? e.message : 'unknown') }
    }
    const mined = mineNotes(text, o)
    fs.mkdirSync(dir, { recursive: true })
    let written = 0
    for (const [name, md] of mined.days) { fs.writeFileSync(path.join(dir, name), md, 'utf8'); written++ }
    for (const [name, md] of mined.events) { fs.writeFileSync(path.join(dir, name), md, 'utf8'); written++ }
    return { ok: true, written, log: log.file, sizeMB: Math.round(mb * 10) / 10, ...mined.stats }
}

// ---------------------------------------------------------------- plugin glue

export function register(ctx, cfg, logFn) {
    const log = typeof logFn === 'function' ? logFn : () => {}
    const state = { stamp: '', busy: false, timer: null }

    const tick = () => {
        let c
        try { c = { ...NOTES_DEFAULTS, ...((cfg && cfg.notes) || {}) } } catch { c = { ...NOTES_DEFAULTS } }
        if (!c.enabled || state.busy) return
        const home = cfg && typeof cfg.home === 'function' ? cfg.home() : null
        if (!home) return
        const logInfo = newestSessionLog(home)
        if (!logInfo) return
        const stamp = String(logInfo.mtimeMs) + ':' + logInfo.size
        if (stamp === state.stamp) return
        state.busy = true
        // Defer so this never runs inside a hook's critical path.
        setTimeout(() => {
            const t0 = Date.now()
            let r
            try {
                r = refreshNotes({ ...c, home })
            } catch (e) {
                r = { ok: false, reason: 'threw:' + (e && e.message ? e.message : 'unknown') }
            }
            state.busy = false
            if (r.ok) state.stamp = stamp
            log({ mark: 'notes-refresh', ok: r.ok, ms: Date.now() - t0, written: r.written, dayFiles: r.dayFiles, eventFiles: r.eventFiles, events: r.events, reason: r.reason })
        }, 0)
    }

    const start = () => {
        let c
        try { c = { ...NOTES_DEFAULTS, ...((cfg && cfg.notes) || {}) } } catch { c = { ...NOTES_DEFAULTS } }
        if (!c.enabled) return
        const every = Math.max(1, Number(c.refreshMinutes) || 10) * 60000
        const first = setTimeout(tick, Math.max(1000, Number(c.startDelayMs) || 45000))
        const interval = setInterval(tick, every)
        state.timer = { first, interval }
        if (typeof ctx.on === 'function') {
            try { ctx.on('dispose', () => { clearTimeout(first); clearInterval(interval) }) } catch { /* older builds */ }
        }
    }

    start()
    return { tick, stop: () => { if (state.timer) { clearTimeout(state.timer.first); clearInterval(state.timer.interval) } } }
}

export const name = 'dsh-history-fold:notes'
