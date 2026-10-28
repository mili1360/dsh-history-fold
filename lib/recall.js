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
import { semanticSearch, SEM_DEFAULTS } from './semantic.js'
import { makeGate } from './gate.js'

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
    semantic: { ...SEM_DEFAULTS },
    minIntervalMs: 20000,
    // Optional: an absolute directory of markdown notes to search alongside the archive.
    notesDir: '',
    // false = only this window's own notes folder (per-session isolation).
    // true  = search every session's notes folder, i.e. "remember everything, everywhere".
    crossSession: false,
}

// Function words carry no retrieval signal. Deliberately short list.
const STOP = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'was', 'were', 'are', 'you',
    '你的', '我的', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '为什么', '可以', '是不',
    '就是', '还是', '但是', '因为', '所以', '如果', '已经', '现在', '时候', '一个', '不是', '没有',
    '这些', '那些', '一下', '有点', '感觉', '应该', '需要', '然后', '而且', '或者',
    // Question words: a turn made of questions retrieves nothing, and matching them pulled back
    // the "为什么为什么为什么…" spam verbatim (2026-10-18).
    '多少', '哪些', '是否', '能不能', '是不是', '怎么办', '为何', '怎样', '什么样', '好不好',
])

// A run that is one short pattern repeated over and over ("为什么为什么为什么…") carries no
// retrieval signal either, and its 2-char grams are pure noise. Measured 2026-10-18: exactly that
// text produced the keywords 为什/什么/么为 and returned the spam message itself.
export function isRepetitiveRun(run) {
    const s = String(run || '')
    for (let unit = 1; unit <= 4; unit++) {
        if (s.length < unit * 3) continue
        const pattern = s.slice(0, unit)
        let ok = true
        for (let i = 0; i + unit <= s.length; i += unit) {
            if (s.slice(i, i + unit) !== pattern) { ok = false; break }
        }
        if (ok) return true
    }
    return false
}

// Every substring of length >= 2 that appears inside a stopword. Cheap to build once, and it stops
// the CJK gram splitter from turning "为什么" into "为什" and "么是".
const STOP_GRAMS = (() => {
    const set = new Set()
    for (const w of STOP) {
        for (let i = 0; i + 2 <= w.length; i++) set.add(w.slice(i, i + 2))
    }
    return set
})()

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
    // Every 2-gram that appears inside a stopword is junk too ("为什", "么是" from "为什么").
    const stopGrams = STOP_GRAMS
    const push = (w) => {
        const k = w.toLowerCase()
        if (k.length < cfg.minKeywordChars) return
        if (STOP.has(k)) return
        if (stopGrams.has(k)) return
        if (seen.has(k)) return
        seen.add(k)
        out.push(k)
    }
    const src = stripMemeText(text)
    for (const m of src.matchAll(/[A-Za-z][A-Za-z0-9_.-]{3,}/g)) push(m[0])
    // Chinese has no spaces: a whole clause never matches, so use overlapping 2-char grams.
    for (const m of src.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
        const run = m[0]
        if (isRepetitiveRun(run)) continue
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

// Notes are rewritten wholesale whenever the session log changes (every few minutes), so the same
// few megabytes get re-read and re-lowercased on every turn. Measured 2026-10-22: 3.6 MB / 52 files
// cost ~100 ms per turn, all of it spent on files that did not change. Key the parsed form on
// (file, mtime, size) and the steady-state cost drops to a stat per file.
const noteCache = new Map() // file -> { mtimeMs, size, lines, lowerAll }

function loadNote(file) {
    let st
    try { st = fs.statSync(file) } catch { return null }
    const hit = noteCache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit
    let raw
    try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
    // stripMemeText only rewrites inline [表情: ...] markers and leaves newlines alone, so the
    // stripped body and the raw lines share line boundaries -- an offset in one maps to the other.
    const lowerAll = stripMemeText(raw).toLowerCase()
    const newlines = []
    for (let i = 0; i < lowerAll.length; i++) if (lowerAll.charCodeAt(i) === 10) newlines.push(i)
    const lines = raw.split('\n')
    // 章节标题（## …）单独存一份小写文本：标题就是"我当时怎么问的"，它命中关键词是极强的信号。
    // 一天笔记里正文可能提到某个词几十次，而标题只在讲那件事时才出现。
    const titlesLower = lines.filter((l) => /^\s{0,3}#{1,6}\s/.test(l)).join('\n').toLowerCase()
    const entry = { mtimeMs: st.mtimeMs, size: st.size, lines, lowerAll, newlines, titlesLower }
    noteCache.set(file, entry)
    return entry
}

// Which line contains this character offset of the lowercased body (binary search on newlines).
function lineAtOffset(note, offset) {
    const nl = note.newlines
    if (!nl.length) return 0
    let lo = 0
    let hi = nl.length - 1
    let idx = nl.length
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (nl[mid] >= offset) { idx = mid; hi = mid - 1 } else { lo = mid + 1 }
    }
    return idx
}

// The line that mentions the winning keyword most often (first on a tie) -- that is the line a
// reader wants quoted, not merely the first one that happens to contain it.
function densestLine(note, offsets) {
    const counts = new Map()
    for (const off of offsets) {
        const idx = lineAtOffset(note, off)
        counts.set(idx, (counts.get(idx) || 0) + 1)
    }
    let bestIdx = -1
    let bestN = 0
    for (const [idx, n] of counts) {
        if (n > bestN || (n === bestN && bestIdx >= 0 && idx < bestIdx)) { bestN = n; bestIdx = idx }
    }
    return bestIdx >= 0 ? (note.lines[bestIdx] || '') : ''
}

// Exposed for tests: a cache that silently grows or never invalidates is worse than no cache.
export function noteCacheSize() { return noteCache.size }
export function noteCacheClear() { noteCache.clear() }

// Notes live per session: <base>/<sid>. A missing folder just means "not mined yet", and notes
// written before the split are still in the root, so fall back to it.
// The two sides spell the id differently -- the session header says "session-<uuid>" while the
// miner names the folder "<uuid>" -- so both are normalised here. Without this the lookup missed
// every time and silently fell back to the shared root (found by review 2026-10-22).
export function shortSessionId(sid) {
    return String(sid || '').replace(/^session-/, '').replace(/[^A-Za-z0-9._-]/g, '_')
}

export function ownNotesDir(base, sid) {
    if (!base) return ''
    const own = shortSessionId(sid)
    if (!own) return base
    const dir = path.join(base, own)
    try { if (fs.statSync(dir).isDirectory()) return dir } catch { /* not mined yet */ }
    return base
}

function listNoteFiles(dir, recursive) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
    const files = []
    for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase().endsWith('.md')) { files.push({ file: path.join(dir, e.name), source: e.name }); continue }
        if (recursive && e.isDirectory()) {
            let sub
            try { sub = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }) } catch { continue }
            for (const f of sub) {
                if (!f.isFile() || !f.name.toLowerCase().endsWith('.md')) continue
                files.push({ file: path.join(dir, e.name, f.name), source: e.name + '/' + f.name })
            }
        }
    }
    return files
}

// Search plain markdown notes: one snippet per file, the best matching line wins.
// cfg.recursive also walks one level of session folders (used by the explicit recall_memory tool).
export function searchNotes(dir, keywords, cfg = DEFAULTS) {
    const candidates = listNoteFiles(dir, !!cfg.recursive)
    if (!candidates.length) return []
    const seen = new Set()
    // 第一遍：收集每个文件的关键词命中位置，顺便统计 df（关键词出现在多少个文件里）。
    // 旧实现直接按"命中次数"排序，于是 `的卡`/`个学` 这种碎片在长文件里出现几十次就让长文件通吃；
    // 2026-10-28 实测：那种打分下真实 20 题 top1 只有 2/20，而同样语料改成 TF-IDF 后是 9/20。
    const rows = []
    const df = new Map()
    for (const { file, source } of candidates) {
        seen.add(file)
        const note = loadNote(file)
        if (!note) continue
        const { lowerAll } = note
        // Count occurrences straight in the lowercased body instead of lowercasing every line per
        // keyword: 52 files x ~2000 lines x 5 keywords was the remaining ~25 ms per turn.
        const hits = new Map()
        for (const k of keywords) {
            const offsets = []
            let i = lowerAll.indexOf(k)
            while (i !== -1 && offsets.length < 50) { offsets.push(i); i = lowerAll.indexOf(k, i + k.length) }
            if (!offsets.length) continue
            hits.set(k, offsets)
            df.set(k, (df.get(k) || 0) + 1)
        }
        if (!hits.size) continue
        rows.push({ file, source, note, hits })
    }
    // Drop cached files that disappeared, so a pruned notes dir cannot pin memory forever.
    if (noteCache.size > seen.size) {
        for (const key of noteCache.keys()) if (!seen.has(key)) noteCache.delete(key)
    }
    const N = rows.length || 1
    const scored = []
    for (const { file, source, note, hits } of rows) {
        let score = 0
        let best = null
        let bestWeight = -1
        for (const [k, offsets] of hits) {
            // 1+log 抑制"同一个词出现几十次"的刷分；idf 让稀有名（瓦特/00381）压过常见碎片；
            // 标题命中再乘一个权重 —— 这三条都是评测里验证过方向的。
            const idf = Math.log((N + 1) / ((df.get(k) || 0) + 1)) + 1
            const inTitle = note.titlesLower && note.titlesLower.includes(k)
            // ignoreCounts: 完全忽略"出现几次"（纯 idf）。碎片词靠出现次数刷分是主要噪声来源，
            // 实测把它关掉比 1+log(n) 更好或持平。
            const tf = cfg.ignoreCounts ? 1 : 1 + Math.log(offsets.length)
            const w = tf * idf * (inTitle ? (cfg.titleWeight ?? 2) : 1)
            score += w
            if (w > bestWeight) { bestWeight = w; best = { keyword: k, offsets } }
        }
        const line = densestLine(note, best.offsets)
        if (!line) continue
        scored.push({
            score,
            source,
            path: file,
            keyword: best.keyword,
            snippet: snippetOf(line.trim(), best.keyword, cfg.snippetChars),
        })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, cfg.maxNoteHits)
}

// ---------------------------------------------------------------- explicit search tool
// Until now the model could only be fed: the hook decided what to inject. This tool gives the
// decision back to the model -- when a question is about something that happened earlier, it can
// ask instead of hoping the next injection lands.
export function buildRecallTool(services) {
    return {
        name: 'recall_memory',
        description: 'Search this session\'s folded history (the archive) for passages relevant to '
            + 'a query. Use it when the user asks about something discussed earlier, or when you '
            + 'suspect an old decision matters. Returns excerpts with the path of the source file, '
            + 'so details can be read verbatim afterwards.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What to look for, in natural language or keywords.' },
                limit: { type: 'integer', description: 'How many excerpts to return (1-8, default 4).' },
            },
            required: ['query'],
            additionalProperties: false,
        },
        // The host refuses a tool without an output contract ("must declare output { schema,
        // render, presentationMeta? }" -- sandbox, 2026-10-18 10:42:38).
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                // required belongs at the object level; inside a property it is rejected with
                // "schema.properties.ok.required is not supported on type boolean" (10:44:21).
                required: ['ok', 'text'],
                properties: {
                    ok: { type: 'boolean' },
                    route: { type: 'string' },
                    hits: { type: 'number' },
                    text: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
        },
        async execute(args) {
            const query = String((args && args.query) || '').trim()
            const limit = Math.max(1, Math.min(8, Number((args && args.limit) || 4)))
            if (!query) return { ok: false, error: 'query is required' }

            const conf = services.readConfig()
            const rel = typeof conf.archiveDir === 'string' ? conf.archiveDir : 'history-fold/archive'
            const archiveDir = path.isAbsolute(rel) ? rel : path.join(services.home(), rel)
            const c = { ...DEFAULTS, ...(conf.recall || {}) }

            const hits = []
            let route = 'gram'
            try {
                const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'))
                for (const f of files.slice(0, 5)) {
                    const r = await semanticSearch(path.join(archiveDir, f), query, { ...SEM_DEFAULTS, ...(c.semantic || {}), topK: limit,
                        // The model asked explicitly, so show lower-confidence rows too: the hook's
                        // 0.50 threshold is for unasked injections, not for a deliberate search.
                        minScore: 0.35, minMargin: 0 })
                    if (r && r.hits && r.hits.length) { hits.push(...r.hits); route = 'semantic' }
                }
            } catch { /* fall through */ }

            if (!hits.length) {
                const keywords = extractKeywords(query, c)
                route = 'gram'
                try {
                    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'))
                    for (const f of files.slice(0, 5)) {
                        hits.push(...searchArchive(path.join(archiveDir, f), keywords, { ...c, maxArchiveHits: limit }))
                    }
                } catch { /* nothing */ }
            }
            try {
                services.log({ mark: 'recall-tool', route, query: query.slice(0, 80), hits: hits.length })
            } catch { /* logging is optional */ }

            if (!hits.length) return { ok: true, route, hits: 0, text: 'No matching passage in the archived history for: ' + query }
            const text = hits.slice(0, limit).map((h) => '- [' + h.source + '] ' + h.snippet + '\n  path: ' + h.path).join('\n')
            return { ok: true, route, hits: hits.length, text }
        },
    }
}

export function registerRecallTool(ctx, services) {
    if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') return false
    const def = buildRecallTool(services)
    let d
    if (typeof ctx.tools.defineTool === 'function') d = ctx.tools.defineTool(def)
    else d = def
    ctx.tools.register(d)
    return true
}

export function formatBlock(hits, cfg = DEFAULTS) {
    if (!hits.length) return ''
    // Compact on purpose: the injected block sits between the user's message and the reply, so
    // every extra line is visual noise the user has to look past. One header line, one line per
    // hit, no boilerplate. (Measured 2026-10-26: the old three-line preamble plus a two-line
    // entry per hit looked like a second user message.)
    const head = '[记忆] 命中 ' + hits.length + ' 条旧账（要细节我按路径去读原文）'
    // Budget: the caller's maxChars wins when it is tighter; otherwise the compact default.
    const cap = Math.min(cfg.maxChars || 1800, cfg.compactMaxChars || 600)
    let out = head
    let n = 0
    for (const h of hits) {
        const item = '\n· ' + h.path + ' — ' + h.snippet
        if (out.length + item.length > cap) break
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

            // Prefer the messages claimed for THIS step. At agent/pre-step the current user
            // message is still in the inbox, not yet in session.events, so lastUserText() returns
            // the PREVIOUS turn's words (measured 2026-10-26: events=6, no user/message,
            // userTextLen=0 on a fresh session). Recalling from the previous turn is always one
            // step behind; the claimed batch is what I am answering right now.
            const claimedText = (() => {
                const msgs = payload && Array.isArray(payload.messages) ? payload.messages : []
                for (let i = msgs.length - 1; i >= 0; i--) {
                    const m = msgs[i]
                    if (!m || m.role !== 'user') continue
                    const kind = m.source && m.source.kind
                    if (kind && kind !== 'user') continue
                    const t = textOf(m.data || m)
                    if (t && t.trim()) return t
                }
                return ''
            })()
            const userText = claimedText || lastUserText(session)
            const keywords = extractKeywords(userText, c)
            // "Recall intent": the human is explicitly asking me to remember something. Under
            // `recall.strict` this is the one case where the broad keyword path is allowed, because
            // answering "what script did we write before" IS a retrieval request. Everything else
            // under strict must be located precisely or not at all.
            const RECALL_INTENT = /之前|上次|以前|我们做过|做过什么|还记得|回忆|那个脚本|上次那个|前面说/
            const recallIntent = c.intentAllowsBroad !== false && RECALL_INTENT.test(userText)
            // The intent words themselves are noise as search terms ("帮我/回忆/之前" matched every
            // old entry). Drop them from the keyword list so the nouns carry the search.
            if (recallIntent) {
                const intentText = '之前上次以前我们做过做过什么还记得回忆那个脚本上次那个前面说'
                const kept = keywords.filter((k) => !intentText.includes(k))
                if (kept.length) keywords.splice(0, keywords.length, ...kept)
            }
            // 放宽 strict 之后（2026-10-27）不能让所有问句都进 fallback：实测「要怎么问呢」
            // 这种元问题也召回了 4 条旧账，全是噪声（问句只有 5 个字，切出「怎么/么问」这种碎片）。
            // 所以 fallback 需要一道门槛：明确要翻旧账（回忆意图），或者问句本身足够具体。
            const userLen = String(userText || '').trim().length
            // 2026-10-28：在"字数+关键词"这道硬门槛之上，再挂一个小分类器复核。
            // 它不是替代规则，而是过滤规则的误触发：实测规则在真实对话上误报 20.4%
            // （73/358），加这层后降到 14.5%（52/358），而正例放行零损失（23/42），
            // 真题 7/20 也零损失。模型缺失时静默跳过，规则照旧。
            // 注意：明确回忆意图（"之前那个脚本…"）不交给模型否决 —— 人已经说清楚了。
            const basicGate = keywords.length >= (c.fallbackMinKeywords || 2) && userLen >= (c.fallbackMinChars || 12)
            let gateAllows = true
            // c.gate === false 显式关掉分类器复核。单元测试必须用它：测试要测的是决策逻辑，
            // 不该随 ``model/gate-model.json`` 的内容变化而变（0.8.0 的 CI 就是这样在 Linux 上
            // 挂了一个测试——本地模型加载成功、CI 上的判断不同，而模型只是数据）。
            if (basicGate && !recallIntent && c.gate !== false) {
                try {
                    const gate = makeGate({
                        threshold: typeof c.gateThreshold === 'number' ? c.gateThreshold : 0.50,
                        // 不传 modelFile 时 gate.js 会按自身目录找 ../model/gate-model.json
                        ...(typeof c.gateModel === 'string' && c.gateModel ? { modelFile: c.gateModel } : {}),
                    })
                    if (gate.available) gateAllows = gate.allow(userText)
                } catch { gateAllows = true }
            }
            const canFallback = recallIntent || (basicGate && gateAllows)
            const hits = []
            const rel = typeof conf.archiveDir === 'string' ? conf.archiveDir : 'history-fold/archive'
            const archiveDir = path.isAbsolute(rel) ? rel : path.join(services.home(), rel)

            // Precise layer first (2026-10-25): a curated entity table, then rare identifiers.
            // It runs BEFORE the short-message gate on purpose: "肉鸽游戏" is four characters and
            // used to be skipped for being short, even though it names a real topic. The gate
            // exists to stop chit-chat, not to block a lookup that already knows what it wants.
            // `recall.strict: true` means: if this layer finds nothing, inject nothing at all
            // instead of falling back to the gram matcher.
            let rareHit = false
            try {
                const rare = await import('./rare.js')
                // notesDir lives under `recall` in the live config, but older installs put it at the
                // top level, and `notes.dir` is the mining destination. Accept all three: reading
                // only the top-level key left this whole layer dead and strict silently inert
                // (found live 2026-10-27: route stayed "gram" with strict=true).
                const relNotes = c.notesDir || conf.notesDir || (conf.notes && conf.notes.dir) || ''
                const notesRoot = relNotes
                    ? (path.isAbsolute(relNotes) ? relNotes : path.join(services.home(), relNotes))
                    : ''
                if (notesRoot) {
                    const manualMap = c.entityMapFile || path.join(services.home(), 'dsh-history-fold', 'entity-map.json')
                    const autoMap = c.entityMapAutoFile || path.join(services.home(), 'dsh-history-fold', 'entity-map.auto.json')
                    // Rebuild the AUTO table when it is missing or older than autoMapMinutes.
                    // It is generated from the notes themselves, so "the map goes stale" is not a
                    // job for the human -- the headings that name a topic are the user's own words.
                    try {
                        let stale = true
                        try {
                            const st = fs.statSync(autoMap)
                            stale = Date.now() - st.mtimeMs > (c.autoMapMinutes || 30) * 60000
                        } catch { stale = true }
                        if (stale) {
                            // The table may be broader than the live rare-term scan: a table hit is
                            // exact by construction, while the scan has to stay narrow.
                            const built = rare.rebuildAutoMap(notesRoot, autoMap, { maxDf: c.autoMapMaxDf || 4, limit: c.autoMapLimit || 600 })
                            services.log({ mark: 'recall-auto-map', written: built.written, terms: built.terms, reason: built.reason })
                        }
                    } catch (err) {
                        services.log({ mark: 'recall-auto-map-error', error: String((err && err.message) || err) })
                    }
                    const found = rare.searchRare(notesRoot, userText, {
                        maxHits: c.maxArchiveHits || 2,
                        maxDf: c.rareMaxDf || 2,
                        mapFiles: [manualMap, autoMap],
                    })
                    if (found.hits && found.hits.length) {
                        rareHit = true
                        hits.push(...found.hits.map((h) => ({
                            path: h.file, snippet: h.title, score: h.score, source: h.via === 'map' ? '实体表' : '稀有词', via: 'rare:' + h.via,
                        })))
                        services.log({ mark: 'recall-rare-hit', sid, via: found.reason, hits: found.hits.length, chars: userText.length })
                    } else if (c.strict && !recallIntent) {
                        // 过去这里直接 skip：没有标识符就不查笔记。日志实测（2026-10-27）
                        // 192 次 skip 对 590 次注入 —— 而同一批评测显示泛问题用词面 top-5
                        // 就能覆盖 65~80%。等于"三分之一的问题压根没叫醒检索"。
                        // 现在「没找到专名」不再是终点，而是退到下面的大众路径；
                        // c.fallback === false 才恢复旧的严格跳过。
                        if (c.fallback === false || !canFallback) {
                            services.log({ mark: 'recall-skip', sid, reason: (c.fallback === false ? 'strict-no-rare:' : 'fallback-gate:') + found.reason, q: String(userText || '').slice(0, 60) })
                            return next()
                        }
                        services.log({ mark: 'recall-fallback', sid, from: 'no-rare:' + found.reason })
                    }
                }
                // Strict means strict even when the notes root could not be resolved: otherwise a
                // misconfigured path silently turns the whole feature back on. A message that
                // ASKS me to remember ("之前那个脚本是什么") is the one case where the broad path
                // is what the user actually asked for, so it is allowed through.
                if (!rareHit && c.strict && !recallIntent) {
                    if (c.fallback === false || !canFallback) {
                        services.log({ mark: 'recall-skip', sid, reason: (c.fallback === false ? 'strict-no-rare:' : 'fallback-gate:') + (notesRoot ? 'no-hit' : 'no-notes-root'), q: String(userText || '').slice(0, 60) })
                        return next()
                    }
                    services.log({ mark: 'recall-fallback', sid, from: notesRoot ? 'no-rare-hit' : 'no-notes-root' })
                }
            } catch (err) {
                services.log({ mark: 'recall-rare-error', sid, error: String((err && err.message) || err) })
            }

            // The keyword gate exists to stop chit-chat injections, not to stop semantic search:
            // embeddings take the whole sentence, so a sentence with few extractable keywords can
            // still be perfectly searchable. Short messages are only skipped when the precise
            // layer above found nothing.
            const clean = stripMemeText(userText).replace(/\s+/g, ' ').trim()
            const tooShort = clean.length < 12
            if (!rareHit && keywords.length < c.minKeywords && tooShort) {
                // A silent skip here is indistinguishable from a broken plugin, so say why.
                services.log({
                    mark: 'recall-skip',
                    sid,
                    reason: 'too-short-and-too-few-keywords',
                    need: c.minKeywords,
                    got: keywords.length,
                    chars: clean.length,
                    q: String(userText || '').slice(0, 60),
                    surface: surfaceSignature(session),
                })
                return next()
            }

            // Everything below this line is the probabilistic fallback (embeddings, gram matcher,
            // keyword notes). It runs ONLY when the precise layer found nothing: a curated hit
            // must never be diluted by noise (measured 2026-10-25: the dpapi lookup returned 3
            // hits, 2 unrelated, purely because the fallback also ran).
            // `route` is declared OUTSIDE: it is logged after this block, and putting it inside
            // made every injection fail with "route is not defined" (measured live 22:38).
            let route = rareHit ? 'rare' : 'gram'
            if (!rareHit) {
            // Semantic retrieval first, when the local embedding service answers. Measured
            // 2026-10-18 against the real archive: the gram matcher offered 83-97 candidates and
            // ranked a live-patch dump first, while embeddings put the genuinely relevant rows on
            // top. It never blocks a turn: a cold index builds in the background and this call
            // gets whatever is already embedded.
            //
            // Two queries, not one: the raw sentence and the keyword join. Measured on the same
            // archive, the raw sentence won on some questions and the keyword join on others
            // ("清理插件怎么开机" -> 0.637 relevant via the join, 0.605 unrelated via the raw text),
            // so both run and the results are merged. Two local calls cost ~200 ms.
            if (c.semantic && c.semantic.enabled !== false) {
                try {
                    const filesS = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'))
                    const ownS = filesS.filter((f) => f.includes(sid))
                    const kwQuery = keywords.slice(0, 8).join(' ')
                    for (const f of (ownS.length ? ownS : filesS).slice(0, 3)) {
                        const full = path.join(archiveDir, f)
                        const merged = new Map()
                        for (const q of kwQuery ? [userText, kwQuery] : [userText]) {
                            const r = await semanticSearch(full, q, c.semantic)
                            for (const h of (r && r.hits) || []) {
                                const prev = merged.get(h.seq)
                                if (!prev || h.score > prev.score) merged.set(h.seq, h)
                            }
                        }
                        if (merged.size) {
                            const ranked = [...merged.values()].sort((x, y) => y.score - x.score)
                            hits.push(...ranked.slice(0, c.semantic.topK || 2))
                            route = 'semantic'
                        }
                    }
                } catch { /* fall through to the gram matcher */ }
            }

            // The gram matcher needs keywords to work with; semantic already ran above without them.
            if (!hits.length && keywords.length >= c.minKeywords) {
                try {
                    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'))
                    const own = files.filter((f) => f.includes(sid))
                    for (const f of (own.length ? own : files).slice(0, 3)) {
                        hits.push(...searchArchive(path.join(archiveDir, f), keywords, c))
                    }
                } catch { /* no archive yet */ }
            }
            // Notes are per session now: this window gets its own folder, and only falls back to the
            // shared root when no per-session folder exists (older flat layouts, hand-written notes).
            // `recall.crossSession: true` searches every session's folder instead -- "remember
            // everything I ever talked about anywhere", at the cost of other windows leaking in.
            const notesBase = c.notesDir || conf.notesDir || ''
            if (notesBase && keywords.length) {
                if (c.crossSession) {
                    try { hits.push(...searchNotes(notesBase, keywords, { ...c, recursive: true })) } catch { /* ignore */ }
                } else {
                    const own = ownNotesDir(notesBase, sid)
                    let ownHits = []
                    try { ownHits = searchNotes(own, keywords, c) } catch { /* ignore */ }
                    // A session with no notes folder of its own (fresh window, sandbox, resumed
                    // elsewhere) used to yield zero conclusions. Fall back to the shared root --
                    // but ONLY when that folder does not exist: falling back on "empty" would leak
                    // other windows into this one even with crossSession off (caught by the
                    // isolation test).
                    if (!ownHits.length && !fs.existsSync(own)) {
                        try { ownHits = searchNotes(notesBase, keywords, { ...c, recursive: true }) } catch { /* ignore */ }
                    }
                    hits.push(...ownHits)
                }
            }
            }

            state.set(sid, now)
            if (!hits.length) {
                services.log({ mark: 'recall-miss', sid, keywords: keywords.slice(0, 6) })
                return next()
            }
            // On a recall request the human wants both halves: what was concluded, and where the
            //原话 is. Notes carry the conclusions (they are the distilled day files); the archive
            // carries verbatim paths. Conclusions first, evidence second -- and both are labelled so
            // the two are never confused.
            if (recallIntent) {
                const isNote = (h) => /\.md$/i.test(String(h.source || '')) || String(h.path || '').endsWith('.md')
                hits.sort((a, b) => (isNote(b) ? 1 : 0) - (isNote(a) ? 1 : 0))
                for (const h of hits) h.source = (isNote(h) ? '要点 ' : '原文 ') + (h.source || '')
                services.log({ mark: 'recall-intent', sid, notes: hits.filter(isNote).length, archive: hits.filter((h) => !isNote(h)).length })
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
                // Put the recalled material BEFORE the user's message, in the same batch the step
                // is entering. Two reasons, both measured:
                //   1. `agent.inject()` lands the block AFTER the prompt, so it reads as "the user
                //      said another thing" and the reply answers the block instead of the question
                //      (2026-10-27: one exchange turned into two).
                //   2. Leading context is what the model treats as background; trailing context is
                //      what it treats as an instruction.
                // This is the same seam the built-in `agent-instructions` / `tool-skill` plugins
                // use: await next(), then reshape the decision's message list.
                const decision = await next()
                if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
                    return decision
                }
                if (decision.messages.some((m) => m && m.id === msg.id)) return decision
                // 记下"真实问话 -> 召回了哪几节"。这是将来训练用的样本来源：
                // 现在造的 paraphrase 全是假的（见 E:\AI_Workspace\retrieval-train\结果-20261027.md 第十节），
                // 只有真实使用日志里才天然带"同一件事被换个说法问"。
                // 只写路径尾段（-60 字符），避免把整条绝对路径写进日志；query 只留前 60 字。
                services.log({
                    mark: 'recall-injected',
                    sid,
                    via: 'batch-prepend',
                    route,
                    chars: block.length,
                    hits: hits.length,
                    q: String(userText || '').slice(0, 60),
                    // 只记笔记（.md）。训练要的是"这句问话对应哪一节"，而档案是会话原文 jsonl，
                    // 没有"章节"这个概念，混进来就是噪声。沙箱实测前 5 条里 4 条是同一个 jsonl 重复。
                    // 空数组 = 这次只命中档案，没有可用的训练目标。
                    paths: (() => {
                        const isNote = (h) => /\.md$/i.test(String(h && (h.path || h.source) || ''))
                        const seen = new Set()
                        const out = []
                        for (const h of hits) {
                            if (!isNote(h)) continue
                            const p = String((h && (h.path || h.source)) || '')
                            if (!p || seen.has(p)) continue
                            seen.add(p)
                            out.push(p.slice(-60))
                            if (out.length >= 3) break
                        }
                        return out
                    })(),
                    keywords: keywords.slice(0, 6),
                })
                return { ...decision, messages: [msg, ...decision.messages] }
            } catch (err) {
                services.log({ mark: 'recall-inject-failed', sid, error: String((err && err.message) || err) })
                return next()
            }
        } catch (err) {
            try { services.log({ mark: 'recall-error', error: String((err && err.message) || err) }) } catch { /* ignore */ }
            return next()
        }
    }

    ctx.on('agent/pre-step', handler)
}


