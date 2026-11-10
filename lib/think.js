// ============================================================
//  dsh-think-probe  --  v2: 抓 think -> 找记忆 -> 只写日志（不注入）
// ============================================================
//  Closed loop the user wants: while I think, read what I am thinking about, then put the
//  relevant memory back in front of me.
//
//  What is proven (2026-10-25, measured, not assumed):
//    - the REQUEST is deep-frozen: llm/stream cannot add input to the current step
//    - the OUTPUT stream can carry an extra reasoning block, but the model then treats it
//      as "material someone slipped in" and refuses to trust it
//    => delivery has to be a user-role message, either to the next STEP (steer) or the
//       next TURN. This version delivers nothing: it only records what it WOULD hand over,
//       so the selection can be inspected before it is trusted.
//
//  Query recipe (from the 8-case evaluation):
//    - the user's own words are the better query (3/4 vs 1/4 for thinking keywords)
//    - thinking contributes IDENTIFIERS only: tickers, file names, versions, dates
//    - English function words are filtered out (they used to outrank "tiger-maus")
//
//  Fail-open: every own operation is in try/catch, source errors propagate unchanged,
//  nothing is awaited inside the stream.
//
//  ASCII only on purpose: this box runs a GBK code page.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'

export const name = 'dsh-think-probe'

const RECALL_MOD = 'file:///E:/deepseek插件/dsh-history-fold/lib/recall.js'
const SEM_MOD = 'file:///E:/deepseek插件/dsh-history-fold/lib/semantic.js'
let recallLib = null
let semLib = null

const EN_STOP = new Set(('a an the and or but if then than that this these those is are was were be been being ' +
    'i me my we our you your he she it its they them their to of in on at by for with from as not no yes ' +
    'do does did done have has had will would should could can may might must about into over under again ' +
    'also just only very more most some any all both each few many much own same so such nor too ' +
    'now here there when where why how what which who whom whose get got make made let lets say says said ' +
    'think thought know knew need needs want wants see seen look looks first then next last new old good ' +
    'right wrong true false ok okay user users answer answers question questions note notes memory recall ' +
    'context project fact facts confirmed possibly probably maybe actually check checks checked line lines ' +
    'file files code run runs running test tests use uses used using').split(' '))

function dshHome() {
    return process.env.DSH_HOME || path.join(process.env.USERPROFILE || '.', '.dsh')
}

function readConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(dshHome(), 'dsh-think-probe', 'config.json'), 'utf8'))
        return { enabled: true, minScore: 0.5, minMargin: 0.12, maxHits: 3, thinkChars: 3000, ...raw }
    } catch {
        return { enabled: true, minScore: 0.5, minMargin: 0.12, maxHits: 3, thinkChars: 3000 }
    }
}

function log(obj) {
    try {
        const dir = path.join(dshHome(), 'logs')
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(path.join(dir, 'think-probe.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...obj }) + '\n', 'utf8')
    } catch { /* never let logging break a request */ }
}

// Identifiers worth carrying over from the thinking: tickers, model names, paths, dates.
export function identifiers(text, max = 6) {
    const out = []
    const seen = new Set()
    const re = /[A-Za-z][A-Za-z0-9._-]{2,}|[0-9]{4}-[0-9]{2}-[0-9]{2}/g
    let m
    while ((m = re.exec(String(text || ''))) !== null) {
        const w = m[0].replace(/[._-]+$/, '')
        const low = w.toLowerCase()
        if (low.length < 3 || EN_STOP.has(low)) continue
        if (seen.has(low)) continue
        seen.add(low)
        out.push(w)
        if (out.length >= max) break
    }
    return out
}

// ---- rare-term recall over the notes ------------------------------------------------
// Notes are already organised as "## <the question that was asked>" sections. Indexing them
// by RARITY beats both keyword counting and (measured) embeddings on this corpus:
//   tiger-maus -> 2 files, peekPx -> 2 files, while 怎么/之前 -> every file.
// A query that has neither an identifier nor a term living in <=2 files returns nothing;
// that single rule is what keeps generic questions from being answered with noise.
function collectSections(notesDir) {
    const out = { files: new Map(), sections: [] }
    let dirs = []
    try {
        dirs = fs.readdirSync(notesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(notesDir, d.name))
    } catch { return out }
    if (!dirs.length) dirs = [notesDir]
    for (const dir of dirs) {
        let names = []
        try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')) } catch { continue }
        for (const f of names) {
            let raw = ''
            try { raw = fs.readFileSync(path.join(dir, f), 'utf8') } catch { continue }
            const key = f
            out.files.set(key, raw.toLowerCase())
            const lines = raw.split('\n')
            for (let i = 0; i < lines.length; i++) {
                const m = /^##\s+(.*)$/.exec(lines[i])
                if (!m) continue
                const h = m[1].trim()
                if (!h || /^这一天（\d{8}）/.test(h)) continue
                out.sections.push({ f: key, line: i + 1, h })
            }
        }
    }
    return out
}

function rareCandidates(query, think) {
    const src = String(query || '') + ' ' + String(think || '')
    const latin = new Set()
    for (const w of src.match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) || []) {
        // Trailing punctuation is sentence noise, not part of the name: "time." was being read
        // as an identifier and triggered a lookup on every turn (measured 2026-10-25 20:17).
        const low = w.toLowerCase().replace(/[._-]+$/, '')
        if (low.length < 3 || EN_STOP.has(low)) continue
        latin.add(low)
    }
    const cjk = new Set()
    const onlyCjk = String(query || '').replace(/[^\u4e00-\u9fa5]/g, ' ')
    for (const run of onlyCjk.split(/\s+/)) {
        for (let i = 0; i + 3 <= run.length; i++) cjk.add(run.slice(i, i + 3))
    }
    return { latin: [...latin], cjk: [...cjk].slice(0, 10) }
}

// An identifier looks like a name, not like prose: it carries digits, dots, dashes, or an
// inner capital. Measured 2026-10-25: counting every latin word as an identifier made the
// thinking words "injection"/"delivered" inject three unrelated notes on every turn.
function looksLikeIdentifier(term) {
    return /[0-9._-]/.test(term) || /[a-z][A-Z]/.test(term)
}

// A technical term is a lowercase word the notes themselves only ever write inside code
// formatting: `dpapi`, `vmrun`, `registerhotkey`. Prose words ("injection") also show up in
// ordinary sentences, so the ratio of code-context occurrences tells the two apart without
// hand-maintaining a word list.
function isTechnicalTerm(term, files) {
    const low = term.toLowerCase()
    let total = 0
    let coded = 0
    for (const [, raw] of files) {
        let from = 0
        for (;;) {
            const at = raw.indexOf(low, from)
            if (at === -1) break
            total += 1
            const before = raw.slice(Math.max(0, at - 2), at)
            const after = raw.slice(at + low.length, at + low.length + 2)
            if (before.includes('`') || after.includes('`') || before.includes('/') || before.includes('\\')) coded += 1
            from = at + low.length
            if (total > 40) break
        }
    }
    return total > 0 && coded / total >= 0.5
}

export function searchRare(notesDir, query, think, cfg = {}) {
    const maxTerms = cfg.maxTerms || 3
    const maxDf = cfg.maxDf || 4
    const idx = collectSections(notesDir)
    if (!idx.sections.length) return { terms: [], hits: [], reason: 'no-sections' }
    const df = (term) => {
        const low = term.toLowerCase()
        let n = 0
        for (const [, raw] of idx.files) if (raw.includes(low)) n += 1
        return n
    }
    // TRIGGERS COME FROM THE HUMAN'S WORDS ONLY (measured 2026-10-25, 10 deliveries, 0 useful):
    // my thinking is English prose full of `time.` `user.` `reply.` `archive.`, and every one of
    // those was read as an identifier and pulled up unrelated notes. The thinking still exists,
    // it just may not decide what gets injected -- a name the human typed is the only honest
    // evidence that the subject of the conversation is a thing rather than a process.
    const { latin, cjk } = rareCandidates(query, '')
    // Strict on purpose. A "is it written in code formatting" heuristic was tried and it
    // failed on this corpus: this project's own meta vocabulary (`recall-would`,
    // `injection`) lives in backticks too, so the heuristic read them as technical terms and
    // re-opened the noise. Known cost of the strict rule: plain lowercase technical words
    // (`dpapi`, `vmrun`, `registerhotkey`) do NOT trigger a lookup. Missing a lookup is cheap;
    // injecting three unrelated sections every turn is not.
    const ids = latin.map((t) => ({
        t,
        df: df(t),
        kind: looksLikeIdentifier(t) && t.length >= 5 ? 'id' : 'word',
    }))
        .filter((x) => x.df >= 1)
        .sort((a, b) => (a.kind === 'id' ? -1 : 1) - (b.kind === 'id' ? -1 : 1) || a.df - b.df)
        .slice(0, 2)
    const zh = cjk.map((t) => ({ t, df: df(t), kind: 'zh' })).filter((x) => x.df >= 1 && x.df <= maxDf)
        .sort((a, b) => a.df - b.df || b.t.length - a.t.length)
    const terms = [...ids]
    for (const c of zh) {
        if (terms.some((p) => p.t.includes(c.t) || c.t.includes(p.t))) continue
        terms.push(c)
        if (terms.length >= maxTerms) break
    }
    // Only a name-shaped identifier may trigger a delivery, and it has to be long enough to
    // be specific: "bge" (3 chars, 4 files) matched unrelated sections, "Tiger-Maus" did not.
    // Long enough to be specific: "bge" (3 chars, 4 files) matched unrelated sections.
    const triggers = terms.filter((t) => t.kind === 'id' && t.t.length >= 4)
    if (!triggers.length) return { terms, hits: [], reason: 'no-identifier' }

    const linesCache = new Map()
    const linesOf = (f) => {
        if (!linesCache.has(f)) {
            const raw = []
            for (const [k, lowRaw] of idx.files) if (k === f) raw.push(lowRaw)
            linesCache.set(f, (raw[0] || '').split('\n'))
        }
        return linesCache.get(f)
    }
    const byFile = new Map()
    for (const s of idx.sections) {
        if (!byFile.has(s.f)) byFile.set(s.f, [])
        byFile.get(s.f).push(s)
    }
    const hits = []
    // Today's own notes are not memory: a conversation about the retrieval machinery keeps
    // producing its own vocabulary ("recall-would"), and handing today's file back to the
    // model that just wrote it is self-reference, not recall. Measured 2026-10-25 18:53.
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const todayTag = 'day-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.md'
    for (const [f, list] of byFile) {
        if (f === todayTag) continue
        const lines = linesOf(f)
        for (let i = 0; i < list.length; i++) {
            const s = list[i]
            const end = i + 1 < list.length ? list[i + 1].line - 1 : lines.length
            const body = lines.slice(s.line - 1, end).join('\n')
            const head = s.h.toLowerCase()
            let score = 0
            // Only the identifier terms score at all. Everything else (Chinese 3-grams, prose
            // words) has been measured to match unrelated sections, so it may not vote here.
            for (const t of triggers) {
                const term = t.t.toLowerCase()
                if (head.includes(term)) score += 3
                else if (body.includes(term)) score += 2
            }
            if (score > 0) hits.push({ f, line: s.line, h: s.h, score })
        }
    }
    hits.sort((a, b) => b.score - a.score)
    return { terms, hits: hits.slice(0, cfg.maxHits || 3), reason: 'ok' }
}

// Explicit entity table: term -> {file, line, title}. Deterministic, zero guessing, and the
// human can extend it by editing one JSON file. Checked BEFORE any scoring, because a curated
// hit must never be diluted by probabilistic matches.
export function loadEntityMap(cfg) {
    const file = cfg.mapFile || path.join(dshHome(), 'dsh-think-probe', 'entity-map.json')
    try {
        const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!Array.isArray(rows)) return []
        return rows
            .filter((r) => r && typeof r.key === 'string' && typeof r.file === 'string')
            .map((r) => ({ key: r.key.toLowerCase(), file: r.file, line: Number(r.line) || 0, title: String(r.title || '') }))
    } catch { return [] }
}

export function lookupEntityMap(query, cfg) {
    const map = loadEntityMap(cfg)
    if (!map.length) return { hits: [], reason: 'no-map' }
    const q = String(query || '').toLowerCase()
    if (!q.trim()) return { hits: [], reason: 'no-query' }
    const hits = []
    for (const row of map) {
        if (!row.key || row.key.length < 3) continue
        if (!q.includes(row.key)) continue
        // today's notes are not memory (same rule as the rare-term route)
        const d = new Date()
        const pad = (n) => String(n).padStart(2, '0')
        if (row.file === 'day-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.md') continue
        hits.push({ f: row.file, line: row.line, h: row.title || row.key, score: 9, via: 'map' })
    }
    return { hits, reason: hits.length ? 'map-hit' : 'map-miss' }
}

// Pure: turn (user text, thinking text) into a query and a ranked set of memory hits.
export async function analyze(userText, thinkText, cfg) {
    log({ mark: 'analyze-enter', thinkLen: String(thinkText || '').length })
    if (!recallLib) recallLib = await import(RECALL_MOD)
    log({ mark: 'analyze-imported' })
    const lib = recallLib
    const zh = lib.extractKeywords(userText || '', { max: 8 }) || []
    const ids = identifiers(thinkText || '')
    const keywords = [...new Set([...zh, ...ids])].slice(0, 10)
    const notesDir = cfg.notesDir || path.join(dshHome(), 'history-fold', 'notes')
    const archiveDir = cfg.archiveDir || path.join(dshHome(), 'history-fold', 'archive')

    // 1) Curated table first: a human-writable term -> file:line map. Deterministic, so it can
    //    never be diluted by a probabilistic match.
    try {
        const mapped = lookupEntityMap(userText, cfg)
        if (mapped.hits.length) {
            return {
                keywords: mapped.hits.map((h) => h.h).slice(0, 3),
                identifiers: [],
                reason: 'map',
                hits: mapped.hits.slice(0, cfg.maxHits).map((h) => ({
                    route: 'map', score: 9, file: h.f + ':' + h.line, snippet: h.h.slice(0, 160),
                })),
            }
        }
    } catch { /* a broken table must never stop the rest */ }

    let noteHits = []
    try {
        log({ mark: 'analyze-before-search', dir: notesDir, kw: keywords.join(',') })
        noteHits = lib.searchNotes(notesDir, keywords, { recursive: true, maxNoteHits: cfg.maxHits, snippetChars: 200 }) || []
        log({ mark: 'analyze-after-search', n: noteHits.length })
    } catch (e) {
        log({ mark: 'analyze-search-err', err: String(e && e.message) })
    }

    // Rare-term-first recall over the notes (measured 2026-10-25):
    //   "Tiger-Maus" lives in 2 files, "怎么/之前/是什么" live in all of them, and ranking by
    //   occurrence let the common words bury the one term that could locate the answer.
    //   A query with no identifier and no term rarer than 2 files now returns nothing, which
    //   is what stopped the "今天天气怎么样" style questions from being answered with noise.
    let rare = { terms: [], hits: [], reason: 'disabled' }
    try {
        rare = searchRare(notesDir, userText, thinkText, cfg)
    } catch (err) { rare = { terms: [], hits: [], reason: 'rare-err:' + String((err && err.message) || err) } }
    if (rare.hits.length) {
        return {
            keywords: rare.terms.map((t) => t.t),
            identifiers: ids,
            reason: 'rare:' + rare.reason,
            hits: rare.hits.map((h) => ({ route: 'notes', score: Number(h.score.toFixed(1)), file: h.f + ':' + h.line, snippet: h.h.slice(0, 160) })),
        }
    }

    // No archive fallback. The archive only holds folded originals with a thin index, and every
    // single archive hit observed on 2026-10-25 was unrelated ("是不是测试过没问题呀", "喵喵喵").
    // A route that has never once been right is not a fallback, it is noise with a schedule.
    // 2026-11-09: noteHits 之前算了但没返回（bug）——先返回关键词命中的 notes。
    if (noteHits && noteHits.length) {
        return {
            keywords,
            identifiers: ids,
            reason: 'notes',
            hits: noteHits.slice(0, cfg.maxHits).map((h) => ({
                route: 'notes',
                score: Number((h.score || 0).toFixed ? h.score.toFixed(1) : h.score),
                file: h.path || h.file || '',
                snippet: String(h.snippet || h.title || '').slice(0, 160),
            })),
        }
    }
    return { keywords, identifiers: ids, reason: 'no-match', hits: [] }
}

export function apply(ctx) {
    if (readConfig().enabled === false) { log({ mark: 'disabled' }); return }
    if (!ctx || typeof ctx.on !== 'function') return
    let call = 0
    // The request is deep-frozen, so the only honest way to hand memory back is the agent's
    // own inbox: agent.inject() puts a message in the next-step inbox WITHOUT waking the
    // driver, so it rides in at the start of the next turn, next to the human's prompt.
    // The agent handle only exists in a pre-step payload, hence this listener.
    // 2026-11-10 用户要求：注入必须在【下一轮 think 之前】（pre-step 时给），
    // 不能等 llm/stream 的 .then 去 inject（那会排在消息后面/下一轮里，时机不对）。
    // 做法：analyze 结果先存 globalThis.__probePending，pre-step 时注入并清空。
    // 2026-11-10 二次要求：希望注入显示在【用户消息后面】——试试直接改 payload.messages
    // （push 一条带 source.kind='plugin' 的 user 消息，UI 可能会排在用户消息旁边）。
    let lastAgent = null
    try {
        ctx.on('agent/pre-step', (payload, next) => {
            if (payload && payload.agent) {
                lastAgent = payload.agent
                try {
                    const pending = globalThis.__probePending
                    if (pending && pending.text) {
                        globalThis.__probePending = null
                        const factory = globalThis.__probeCreateUserMessage
                        if (typeof factory === 'function') {
                            const msg = factory({
                                content: [{ type: 'text', text: pending.text }],
                                source: { kind: 'plugin', plugin: name, form: 'recall' },
                            })
                            const arr = payload && Array.isArray(payload.messages) ? payload.messages : null
                            if (arr) {
                                // 改 payload.messages（可能显示在用户消息附近）；失败再退回 inject
                                try {
                                    arr.push(msg)
                                    log({ mark: 'recall-delivered', call: pending.call, chars: pending.text.length, via: 'payload' })
                                } catch {
                                    if (typeof lastAgent.inject === 'function') lastAgent.inject(msg)
                                    log({ mark: 'recall-delivered', call: pending.call, chars: pending.text.length, via: 'inject-fallback' })
                                }
                            } else if (typeof lastAgent.inject === 'function') {
                                lastAgent.inject(msg)
                                log({ mark: 'recall-delivered', call: pending.call, chars: pending.text.length, via: 'inject' })
                            }
                        }
                    }
                } catch (e) {
                    log({ mark: 'deliver-failed', error: String((e && e.message) || e) })
                }
            }
            return next()
        })
    } catch { /* older builds without this hook: delivery just never fires */ }
    ctx.on('llm/stream', (options, next) => {
        const cfg = readConfig()
        if (cfg.enabled === false) return next()

        // the human's own words (plugin reminders are user-role too, so filter by source)
        let userText = ''
        try {
            const msgs = options.messages || []
            for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i]
                if (!m || m.role !== 'user' || (m.source && m.source.kind) !== 'user') continue
                const t = (m.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join(' ').trim()
                if (t) { userText = t; break }
            }
        } catch { /* unexpected message shape is not worth failing a request */ }

        const source = next()
        if (!source || typeof source[Symbol.asyncIterator] !== 'function') return source
        call += 1
        const id = call
        return (async function* probed() {
            let think = ''
            let chunks = 0
            let text = 0
            let fired = false
            let finished = true
            try {
                for await (const chunk of source) {
                    try {
                        chunks += 1
                        if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && think.length < cfg.thinkChars) think += chunk.text
                        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text.length
                        // 2026-11-10 debug: 看真正的 chunk.type（只记前 8 个不同的）
                        if (!globalThis.__probeTypes) globalThis.__probeTypes = new Set()
                        if (chunk && chunk.type && !globalThis.__probeTypes.has(chunk.type) && globalThis.__probeTypes.size < 8) {
                            globalThis.__probeTypes.add(chunk.type)
                            log({ mark: 'chunk-type', type: chunk.type })
                        }
                    } catch { /* ignore */ }
                    yield chunk
                    // thinking is settled once the visible answer starts; look it up then,
                    // without awaiting -- an await here stalls the answer mid-word.
                    // 2026-11-09: 有些会话只有 reasoning 没有 text-delta（实测 textChars=0）——
                    // 不能死等 text-delta，reasoning 攒够了一截就先分析一次。
                    if (!fired && chunk && (chunk.type === 'text-delta' || chunk.type === 'tool-call-delta' || think.length > 200)) {
                        fired = true
                        log({ mark: 'fired', call: id, chunkType: chunk.type, thinkLen: think.length, user: String(userText || '').slice(0, 30) })
                        if (think.trim()) {
                            log({ mark: 'analyze-call', call: id, thinkLen: think.length })
                            void analyze(userText, think, cfg).then(async (r) => {
                                log({
                                    mark: 'recall-would', call: id, user: userText.slice(0, 60),
                                    thinkChars: think.length, keywords: String(r.keywords || '').slice(0, 80),
                                    reason: r.reason, hits: r.hits.length,
                                })
                                const dedupKey = r.hits.slice(0, 3).map((h) => h.file).join('|')
                                log({ mark: 'deliver-check', call: id, cfgDeliver: !!cfg.deliver, hits: r.hits.length, hasAgent: !!lastAgent, hasInject: !!(lastAgent && typeof lastAgent.inject === 'function') })
                                // 2026-11-02: same batch within 10 min -> skip. Without this the same three
                                // notes were re-delivered every single turn.
                                // 2026-11-10 三文鱼：不能每句都注入。加最小间隔（minIntervalSec，默认 180 秒），
                                // 不管话题是否相同，间隔不够就不注入。
                                const sinceLast = Date.now() - (globalThis.__probeLastDeliver || 0)
                                const minInterval = (Number(cfg.minIntervalSec) || 180) * 1000
                                log({ mark: 'dedup-check', call: id, sinceLast: sinceLast, sameKey: dedupKey === (globalThis.__probeLastKey || ''), key: String(dedupKey || '').slice(0, 80) })
                                if (cfg.deliver && r.hits.length && lastAgent && typeof lastAgent.inject === 'function'
                                    && sinceLast >= minInterval
                                    && !(sinceLast < 600000 && dedupKey === (globalThis.__probeLastKey || ''))) {
                                    try {
                                        const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
                                        globalThis.__probeCreateUserMessage = createUserMessage
                                        const lines = r.hits.slice(0, 3).map((h) => '- ' + h.file + '  ' + h.snippet).join('\n')
                                        const text = '[记忆] 与刚才那句相关的旧笔记（只给定位，不贴全文）：\n' + lines + '\n要细节我再去读原文。'
                                        // 2026-11-10: 不在 .then 里直接 inject（时机会排在下一轮消息里）；
                                        // 存 pending，由下一轮 agent/pre-step 注入（think 之前）。
                                        globalThis.__probePending = { call: id, text }
                                        globalThis.__probeLastDeliver = Date.now(); globalThis.__probeLastKey = dedupKey
                                        log({ mark: 'recall-delivered', call: id, chars: text.length, hits: r.hits.length })
                                    } catch (e) {
                                        log({ mark: 'deliver-failed', call: id, error: String((e && e.message) || e) })
                                    }
                                }
                            }).catch((e) => log({ mark: 'analyze-failed', call: id, error: String((e && e.message) || e) }))
                        }
                    }
                }
            } catch (err) {
                finished = false
                throw err
            } finally {
                log({ mark: 'stream', call: id, chunks, reasoningChars: think.length, textChars: text, finished })
            }
        })()
    })
    log({ mark: 'boot', pid: process.pid, version: 2 })
}
