// semantic.js -- embedding-based ranking for recall, used when a local embedding service is up.
//
// Why this exists: the 2-char-gram matcher retrieves on shared characters, so a query like
// "那个清理插件是怎么触发的" matched 83 archived rows, ranked a live-patch dump first, and none of
// it was relevant. Measured on the real archive 2026-10-18: semantic ranking put the right rows
// on top ("触发线是多少" -> the config row and the log row) where the gram matcher returned noise.
//
// Important measured detail: bge-small-zh scores Chinese conversational text in a narrow band
// (0.45-0.60), so an absolute threshold is useless -- 0.55 zeroed out three of four test queries.
// The rule here is therefore RELATIVE: keep the best row only when it clearly beats the field.
//
// Failure policy: any problem (service down, bad response, timeout) returns null and the caller
// falls back to the gram matcher. Recall must never break a turn because an embedding server
// was not running.
//
// ASCII only on purpose -- this box runs a GBK code page.

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const CACHE_VERSION = 1

export const SEM_DEFAULTS = {
    enabled: true,
    endpoint: 'http://127.0.0.1:8021/v1/embeddings',
    model: 'bge-small-zh',
    // 32-text batches on CPU exceeded 4 s and kept timing out; the fallback then embedded the
    // whole archive one row at a time (99 s). 16 items with a 20 s ceiling take a few seconds.
    timeoutMs: 20000,
    // Minimum cosine for the best row to be worth injecting (bge-small sits in 0.45-0.60; measured\n    // 2026-10-18 on the real archive, 0.50 was the line that dropped "喵喵喵" (0.454) and\n    // "我要去打同学" (0.476) while keeping both genuinely relevant queries (0.540 / 0.590)).
    minScore: 0.50,
    // How far the best row must beat the median score before it is considered a real match.
    minMargin: 0.12,
    // Never inject more than this many rows from the semantic path.
    topK: 2,
    // Rows longer than this are truncated before embedding: the first 400 chars carry the topic.
    maxChars: 400,
    // Archive vectors are cached next to the archive as <archive>.vec.json.
    cacheSuffix: '.vec.json',
    batch: 16,
    // A backlog this small is embedded inline (a second or two); anything larger is built in the
    // background so a fold that adds hundreds of rows never stalls the turn it happens in.
    inlineBudget: 8,
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    const d = Math.sqrt(na) * Math.sqrt(nb)
    return d ? dot / d : 0
}

export async function embedBatch(cfg, inputs) {
    // Plain node:http, not fetch. Rationale: aborting or closing an undici request around process
    // exit tripped "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" (win/async.c:94) and
    // killed the test process with 0xC0000409 even though every assertion had passed. A plugin
    // that runs inside DSH must not carry a dependency whose teardown can fault the host process.
    const payload = JSON.stringify({ model: cfg.model, input: inputs })
    return await new Promise((resolve) => {
        let done = false
        const finish = (v) => { if (!done) { done = true; resolve(v) } }
        let req
        try {
            const url = new URL(cfg.endpoint)
            req = http.request({
                hostname: url.hostname,
                port: url.port || 80,
                path: url.pathname + url.search,
                method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
                agent: false,
            }, (res) => {
                if (res.statusCode !== 200) { res.resume(); return finish(null) }
                let raw = ''
                res.setEncoding('utf8')
                res.on('data', (d) => { raw += d })
                res.on('end', () => {
                    try {
                        const json = JSON.parse(raw)
                        if (!json || !Array.isArray(json.data)) return finish(null)
                        finish(json.data.map((d) => d.embedding))
                    } catch { finish(null) }
                })
            })
            req.on('error', () => finish(null))
            req.setTimeout(cfg.timeoutMs, () => { req.destroy(); finish(null) })
            req.end(payload)
        } catch {
            finish(null)
        }
    })
}

/** Is the service reachable at all? Cheap probe, cached for the process. */
let reachable
export async function isReachable(cfg = SEM_DEFAULTS) {
    if (reachable !== undefined) return reachable
    const v = await embedBatch({ ...SEM_DEFAULTS, ...cfg }, ['ping'])
    reachable = Array.isArray(v) && Array.isArray(v[0])
    return reachable
}

export function resetReachability() { reachable = undefined }

function rowKey(row) {
    const text = String(row.text || '')
    return String(row.seq) + ':' + text.length + ':' + text.slice(0, 32)
}

/**
 * Load or build the vector cache for one archive file.
 * Returns [{ seq, vec }] or null when embeddings are unavailable.
 */
// The model name is part of the cache path: vectors from bge-small (512) and bge-base (768) are
// not comparable, and mixing them ranked everything at 0.08 (measured 2026-10-18).
// The name alone is not enough: the local server ignores the requested model name and serves
// whatever it was started with, so a cache can be right by name and wrong by size. Every reader
// and writer must go through this one function, and expectDim catches the drift.
function cachePathOf(file, c) {
    return file + '.' + String(c.model).replace(/[^a-z0-9._-]/gi, '_') + c.cacheSuffix
}

export async function archiveVectors(file, cfg = SEM_DEFAULTS) {
    const c = { ...SEM_DEFAULTS, ...cfg }
    const cacheFile = cachePathOf(file, c)

    let rows
    try {
        rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
        return null
    }
    const keyed = rows.filter((r) => typeof r.text === 'string' && r.text.trim())

    // Incremental cache: key -> vector. A folder grows by appending, so most keys survive a fold and
    // only the new rows need embedding. A stamp of the whole file would throw the cache away every
    // time the archive grew, and a 1114-row rebuild measured 85 s -- far too long to sit inside a
    // pre-step hook.
    let entries = {}
    try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
        if (cached && cached.v === CACHE_VERSION && cached.entries) entries = cached.entries
    } catch { /* no cache yet */ }

    // A cache written by a different embedding model still parses -- its vectors are just the
    // wrong shape, and a mismatched cosine ranked the best row at 0.115 (measured 2026-10-21).
    // Drop those keys so they are rebuilt instead of quietly ranking garbage.
    if (c.expectDim) {
        for (const k of Object.keys(entries)) {
            const v = entries[k]
            if (!Array.isArray(v) || v.length !== c.expectDim) delete entries[k]
        }
    }

    const have = []
    const missing = []
    for (const r of keyed) {
        const k = rowKey(r)
        if (entries[k]) have.push({ seq: r.seq, vec: entries[k] })
        else missing.push(r)
    }

    if (!missing.length) return have

    // Never block the hook for a long build: do a small backlog inline, and start a background
    // build for a large one (a fold can add hundreds of rows at once).
    const inline = c.inlineBudget
    if (missing.length > inline) {
        // Partial results are fine: ranking over what is already embedded still works, and the
        // next call finds more. One build at a time per file.
        void buildInBackground(file, c, missing, entries, cacheFile)
        return have.length ? have : null
    }
    for (const r of missing) {
        const one = await embedBatch(c, [String(r.text).slice(0, c.maxChars)])
        if (one && one[0]) {
            entries[rowKey(r)] = one[0]
            have.push({ seq: r.seq, vec: one[0] })
        }
    }
    saveCache(cacheFile, entries)
    return have.length ? have : null
}

const building = new Set()

async function buildInBackground(file, c, missing, entries, cacheFile) {
    if (building.has(file)) return
    building.add(file)
    try {
        for (let i = 0; i < missing.length; i += c.batch) {
            const chunk = missing.slice(i, i + c.batch)
            const done = await embedBatch(c, chunk.map((r) => String(r.text).slice(0, c.maxChars)))
            if (done) {
                for (let j = 0; j < chunk.length; j++) if (done[j]) entries[rowKey(chunk[j])] = done[j]
            } else {
                for (const r of chunk) {
                    const one = await embedBatch(c, [String(r.text).slice(0, c.maxChars)])
                    if (one && one[0]) entries[rowKey(r)] = one[0]
                }
            }
        }
        saveCache(cacheFile || cachePathOf(file, c), entries)
    } catch { /* best effort */ } finally {
        building.delete(file)
    }
}

function saveCache(cacheFile, entries) {
    try {
        fs.writeFileSync(cacheFile, JSON.stringify({ v: CACHE_VERSION, entries }))
    } catch { /* cache write is best-effort */ }
}

/**
 * Rank archived rows against one query.
 * Returns { hits, reason } where hits is [] when nothing clearly matched.
 */
export async function semanticSearch(file, query, cfg = SEM_DEFAULTS, rowsOverride = null) {
    const c = { ...SEM_DEFAULTS, ...cfg }
    if (!c.enabled) return { hits: [], reason: 'disabled' }

    // Embed the query first: the length it comes back with is the only trustworthy statement about
    // which model is actually serving, so the archive cache gets validated against it.
    const qv = await embedBatch(c, [String(query).slice(0, c.maxChars)])
    if (!qv) return { hits: [], reason: 'no-query-vector' }

    const vectors = await archiveVectors(file, { ...c, expectDim: qv[0].length })
    if (!vectors || !vectors.length) return { hits: [], reason: 'no-vectors' }

    const scored = vectors.map((v) => ({ seq: v.seq, score: cosine(qv[0], v.vec) }))
    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]
    const mid = scored[Math.floor(scored.length / 2)].score
    const margin = best.score - mid
    if (best.score < c.minScore) return { hits: [], reason: 'below-min-score:' + best.score.toFixed(3) }
    if (margin < c.minMargin) return { hits: [], reason: 'no-margin:' + margin.toFixed(3) }

    const textOf = new Map()
    if (rowsOverride) {
        for (const r of rowsOverride) textOf.set(r.seq, r.text)
    } else {
        try {
            for (const r of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) {
                textOf.set(r.seq, r.text)
            }
        } catch { /* leave empty */ }
    }

    const hits = scored.slice(0, c.topK).filter((s) => s.score >= c.minScore).map((s) => ({
        seq: s.seq,
        score: s.score,
        source: path.basename(file) + '#seq' + s.seq,
        path: file,
        snippet: String(textOf.get(s.seq) || '').replace(/\s+/g, ' ').slice(0, 200),
    }))
    return { hits, reason: 'ok' }
}
