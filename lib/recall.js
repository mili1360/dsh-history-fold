// ============================================================
//  recall.js —— dsh-history-fold 的第二个模块：自动回忆
// ============================================================
//  fold.js 把老历史折成索引，原文留在 archive；索引里写着"可以来查"。
//  但"要不要查"一直由模型自己决定 —— 这是最不可靠的一环
//  （实测：插件装了 10 天，folding 0 次，一次都没翻过日志）。
//
//  本模块把它变成默认动作：每轮第一步取用户消息 → 抽关键词 →
//  查 archive + 笔记 → 命中就注入一小段（带来源路径）。
//  没命中什么都不加，零开销。
//
//  与 fold 模块的关系：
//    - 各自独立 try/catch，一个模块抛错不能拖垮另一个
//    - 共用同一份 config.json，本模块只读其中的 `recall` 段（和 archiveDir）
//    - 各自有 enabled 开关
//
//  ASCII ONLY on purpose -- this box runs a GBK code page.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'

export const name = 'dsh-history-fold:recall'

export const DEFAULTS = {
    // On by default: a recall helper that ships switched off is one that never runs.
    enabled: true,
    // Observe and log what WOULD be injected, without steering anything.
    dryRun: false,
    // Total characters of the injected block.
    maxChars: 1200,
    maxArchiveHits: 4,
    maxNoteHits: 3,
    // A snippet is the cut around the match.
    snippetChars: 220,
    // Fewer distinct keywords than this and the turn is treated as chit-chat.
    minKeywords: 2,
    minKeywordChars: 2,
    maxKeywords: 10,
    // Same session cannot be recalled twice inside this window (ms).
    minIntervalMs: 20000,
    // Optional: an absolute directory of markdown notes to search alongside the archive.
    notesDir: '',
}

// Function words carry no retrieval signal. Deliberately short list.
const STOP = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'was', 'were', 'are', 'you',
    '你的', '我的', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '为什么', '可以', '是不',
    '就是', '还是', '但是', '因为', '所以', '如果', '已经', '现在', '时候', '一个', '不是', '没有',
    '这些', '那些', '一下', '有点', '感觉', '应该', '需要', '然后', '而且', '或者',
])

// Meme captions ride along in the user's messages as `[表情: ...]`. Those words describe a
// picture, not the conversation, so they must never become search terms and an archive row that
// only contains them must never count as a hit. Measured 2026-10-18: a single "好" plus a meme
// produced the keywords 表情/室内/内实/实景/景背/背景 and pulled back three meme captions.
export function stripMemeText(text) {
    return String(text || '')
        .replace(/\[表情[:：][^\]]*\]/g, ' ')
        .replace(/\[emote[:：][^\]]*\]/gi, ' ')
}

export function extractKeywords(text, cfg = DEFAULTS) {
    const out = []
    const seen = new Set()
    const push = (w) => {
        const k = w.toLowerCase()
        if (k.length < cfg.minKeywordChars) return
        if (STOP.has(k)) return
        if (seen.has(k)) return
        seen.add(k)
        out.push(k)
    }
    const src = stripMemeText(text)
    for (const m of src.matchAll(/[A-Za-z][A-Za-z0-9_.-]{3,}/g)) push(m[0])
    // Chinese has no spaces: a whole clause never matches, so use overlapping 2-char grams.
    for (const m of src.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
        const run = m[0]
        if (run.length <= 4) { push(run); continue }
        for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2))
    }
    return out.slice(0, cfg.maxKeywords)
}

function countHits(haystack, keyword) {
    if (!keyword) return 0
    let n = 0
    let i = haystack.indexOf(keyword)
    while (i !== -1 && n < 50) { n++; i = haystack.indexOf(keyword, i + keyword.length) }
    return n
}

export function snippetOf(line, keyword, chars = 220) {
    const text = String(line)
    const i = text.indexOf(keyword)
    const start = i <= 0 ? 0 : Math.max(0, i - Math.floor(chars / 3))
    const cut = text.slice(start, start + chars)
    return (start > 0 ? '...' : '') + cut + (start + chars < text.length ? '...' : '')
}

// Search one JSONL archive produced by the fold module: every line is one archived node.
export function searchArchive(file, keywords, cfg = DEFAULTS) {
    let raw
    try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
    const lines = raw.split('\n').filter(Boolean)
    const scored = []
    for (const line of lines) {
        let row
        try { row = JSON.parse(line) } catch { continue }
        const text = typeof row.text === 'string' ? row.text : ''
        if (!text) continue
        // Score against the text with meme captions removed, so a row that only carries a
        // caption cannot look like a hit. The snippet still comes from the original text.
        const lower = stripMemeText(text).toLowerCase()
        let score = 0
        let best = null
        let bestScore = 0
        for (const k of keywords) {
            const c = countHits(lower, k)
            if (c === 0) continue
            score += c
            if (c > bestScore) { bestScore = c; best = k }
        }
        if (score > 0) scored.push({ score, text, best, seq: row.seq })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, cfg.maxArchiveHits).map((h) => ({
        source: path.basename(file) + '#seq' + (h.seq === undefined ? '?' : h.seq),
        path: file,
        keyword: h.best,
        snippet: snippetOf(h.text.replace(/\s+/g, ' '), h.best, cfg.snippetChars),
    }))
}

// Search plain markdown notes: one snippet per file, the best matching line wins.
export function searchNotes(dir, keywords, cfg = DEFAULTS) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
    const scored = []
    for (const e of entries) {
        if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue
        const file = path.join(dir, e.name)
        let raw
        try { raw = fs.readFileSync(file, 'utf8') } catch { continue }
        const lines = raw.split('\n')
        const lowerAll = stripMemeText(raw).toLowerCase()
        let score = 0
        for (const k of keywords) score += countHits(lowerAll, k)
        if (score <= 0) continue
        let best = null
        let bestScore = 0
        for (const k of keywords) {
            for (const line of lines) {
                if (!line.includes(k)) continue
                const c = countHits(line.toLowerCase(), k)
                if (c > bestScore) { bestScore = c; best = { keyword: k, line } }
            }
        }
        if (!best) continue
        scored.push({
            score,
            source: e.name,
            path: file,
            keyword: best.keyword,
            snippet: snippetOf(best.line.trim(), best.keyword, cfg.snippetChars),
        })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, cfg.maxNoteHits)
}

export function formatBlock(hits, cfg = DEFAULTS) {
    if (!hits.length) return ''
    let out = '[dsh-history-fold] 自动回忆：这一轮的词在旧账里命中了下面几段。\n' +
        '当线索用，要细节就按路径读原文，别凭这几句下结论。\n'
    let n = 0
    for (const h of hits) {
        const item = '\n- [' + h.source + '] ' + h.snippet + '\n  路径: ' + h.path
        if (out.length + item.length > cfg.maxChars) break
        out += item
        n++
    }
    return n === 0 ? '' : out
}

// The last human-authored message on the visible surface.
export function lastUserText(session) {
    const events = session && Array.isArray(session.events) ? session.events : []
    const nodes = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : null
    const seqs = nodes || events.map((e) => e.seq)
    for (let i = seqs.length - 1; i >= 0; i--) {
        const seq = seqs[i]
        const ev = events[seq] || events.find((e) => e.seq === seq)
        if (!ev || ev.type !== 'user/message') continue
        const data = ev.data || {}
        const src = data.source && data.source.kind
        if (src && src !== 'user') continue
        const text = textOf(data)
        if (text) return text
    }
    return ''
}

// Pull text out of whatever shape this build used. Tolerant on purpose: returning "" here looks
// exactly like "the plugin is broken", which is the failure mode this module exists to remove.
export function textOf(data) {
    if (!data || typeof data !== 'object') return ''
    for (const h of [data, data.message, data.payload]) {
        if (!h || typeof h !== 'object') continue
        if (typeof h.text === 'string' && h.text.trim()) return h.text
        if (typeof h.content === 'string' && h.content.trim()) return h.content
        if (Array.isArray(h.content)) {
            const parts = h.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string')
            if (parts.length) return parts.map((c) => c.text).join('\n')
        }
    }
    return ''
}

// One-line shape signature of the visible tail, used ONLY in a skip log line, so that
// "skipped" and "broken" never look the same in the log.
export function surfaceSignature(session) {
    try {
        const events = session && Array.isArray(session.events) ? session.events : []
        const nodes = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : null
        const seqs = (nodes || events.map((e) => e.seq)).slice(-3)
        return seqs.map((seq) => {
            const ev = events[seq] || events.find((e) => e.seq === seq)
            if (!ev) return 'seq' + seq + ':missing'
            const d = ev.data || {}
            const kinds = Array.isArray(d.content) ? d.content.map((c) => (c && c.type) || '?').join('+') : typeof d.text
            return (ev.type || '?') + '/' + ((d.source && d.source.kind) || '-') + '/' + kinds
        }).join(' | ')
    } catch {
        return 'unreadable'
    }
}

export function register(ctx, services) {
    const state = new Map() // sid -> last recall timestamp

    const handler = async (payload, next) => {
        try {
            const conf = services.readConfig()
            const c = { ...DEFAULTS, ...(conf.recall || {}) }
            if (conf.enabled === false) return next()
            if (!c.enabled) return next()
            const step = payload && payload.step
            if (step !== undefined && step !== 1) return next()

            const agent = payload && payload.agent
            const session = agent && agent.session
            if (!session) return next()

            const sid = (session.header && session.header.id) || 'unknown'
            const now = Date.now()
            if (now - (state.get(sid) || 0) < c.minIntervalMs) return next()

            const keywords = extractKeywords(lastUserText(session), c)
            if (keywords.length < c.minKeywords) {
                // A silent skip here is indistinguishable from a broken plugin, so say why.
                services.log({
                    mark: 'recall-skip',
                    sid,
                    reason: 'too-few-keywords',
                    need: c.minKeywords,
                    got: keywords.length,
                    surface: surfaceSignature(session),
                })
                return next()
            }

            const hits = []
            const rel = typeof conf.archiveDir === 'string' ? conf.archiveDir : 'history-fold/archive'
            const archiveDir = path.isAbsolute(rel) ? rel : path.join(services.home(), rel)
            try {
                const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'))
                const own = files.filter((f) => f.includes(sid))
                for (const f of (own.length ? own : files).slice(0, 3)) {
                    hits.push(...searchArchive(path.join(archiveDir, f), keywords, c))
                }
            } catch { /* no archive yet */ }
            const notesDir = c.notesDir || conf.notesDir || ''
            if (notesDir) {
                try { hits.push(...searchNotes(notesDir, keywords, c)) } catch { /* ignore */ }
            }

            state.set(sid, now)
            if (!hits.length) {
                services.log({ mark: 'recall-miss', sid, keywords: keywords.slice(0, 6) })
                return next()
            }
            const block = formatBlock(hits, c)
            if (!block) return next()

            if (c.dryRun) {
                services.log({ mark: 'recall-would-inject', sid, chars: block.length, hits: hits.length })
                return next()
            }
            try {
                const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
                const msg = createUserMessage({
                    content: [{ type: 'text', text: block }],
                    source: { kind: 'plugin', plugin: services.name, form: 'notice' },
                })
                // dsh-agent-loop defines both, and they deliver at the SAME point (the next
                // step):  steer(input) { this.send(input, 'next-step', true)  }
                //          inject(input) { this.send(input, 'next-step', false) }
                // The only difference is whether the driver is woken. We are already inside a
                // running turn's pre-step, so there is nothing to wake -- inject is the exact
                // semantic. steer stays as the fallback for builds that only ship that one.
                let via = 'inject'
                if (typeof agent.inject === 'function') {
                    agent.inject(msg)
                } else if (typeof agent.steer === 'function') {
                    via = 'steer'
                    agent.steer(msg)
                } else {
                    throw new Error('agent exposes neither inject() nor steer()')
                }
                services.log({ mark: 'recall-injected', sid, via, chars: block.length, hits: hits.length, keywords: keywords.slice(0, 6) })
            } catch (err) {
                services.log({ mark: 'recall-inject-failed', sid, error: String((err && err.message) || err) })
            }
            return next()
        } catch (err) {
            try { services.log({ mark: 'recall-error', error: String((err && err.message) || err) }) } catch { /* ignore */ }
            return next()
        }
    }

    ctx.on('agent/pre-step', handler)
}
