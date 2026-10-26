// ============================================================
//  rare.js -- 精确召回层（实体表 + 稀有词）
// ============================================================
//  为什么要有这一层（2026-10-25 实测）:
//    原来的 recall 用 2-gram 切词 + 按出现次数排序，于是"有点牛逼啊"被切成
//    "呲牛/牛逼/逼啊"，全都命中旧账，一天注入 62 次，几乎每轮都在喂废话。
//    而真正能定位的是稀有词：`tiger-maus` 只在 2 个文件里出现，
//    "怎么/之前/是什么" 出现在所有文件里 —— 常见词把唯一定位词挤掉了。
//
//  本层两条路，都不靠打分猜:
//    1. 实体表 entity-map.json：词 -> 文件:行号，人工可加，命中即精确
//    2. 稀有词：只认"名字形状"（含数字/点/连字符/内含大写）且 df<=2 的词
//  两条都不中就返回空 —— 由上层决定是"不注入"还是回退旧逻辑。
//
//  ASCII only in code: this box runs a GBK code page.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'

const EN_STOP = new Set(('a an the and or but if then than that this these those is are was were be been being ' +
    'i me my we our you your he she it its they them their to of in on at by for with from as not no yes ' +
    'do does did done have has had will would should could can may might must about into over under again ' +
    'also just only very more most some any all both each few many much own same so such nor too ' +
    'now here there when where why how what which who whom whose get got make made let lets say says said ' +
    'think thought know knew need needs want wants see seen look looks first then next last new old good ' +
    'right wrong true false ok okay user users answer answers question questions note notes memory recall ' +
    'context project fact facts confirmed possibly probably maybe actually check checks checked line lines ' +
    'file files code run runs running test tests use uses used using').split(' '))

export function looksLikeIdentifier(term) {
    return /[0-9._-]/.test(term) || /[a-z][A-Z]/.test(term)
}

export function readEntityMap(file) {
    try {
        const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!Array.isArray(rows)) return []
        return rows
            .filter((r) => r && typeof r.key === 'string' && typeof r.file === 'string')
            .map((r) => ({ key: r.key.toLowerCase(), file: r.file, line: Number(r.line) || 0, title: String(r.title || '') }))
    } catch {
        return []
    }
}

// Walk a notes root (<base>/<sid>/*.md, or the root itself) once and keep the sections.
export function collectSections(notesDir) {
    const out = { files: new Map(), sections: [] }
    let dirs = []
    try {
        const entries = fs.readdirSync(notesDir, { withFileTypes: true })
        dirs = entries.filter((d) => d.isDirectory()).map((d) => path.join(notesDir, d.name))
    } catch { return out }
    if (!dirs.length) dirs = [notesDir]
    for (const dir of dirs) {
        let names = []
        try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')) } catch { continue }
        for (const f of names) {
            let raw = ''
            try { raw = fs.readFileSync(path.join(dir, f), 'utf8') } catch { continue }
            // two sessions can both have day-20261024.md; keep both, keyed by dir+name
            const key = path.basename(dir) + '/' + f
            out.files.set(key, raw.toLowerCase())
            const lines = raw.split('\n')
            for (let i = 0; i < lines.length; i++) {
                const m = /^##\s+(.*)$/.exec(lines[i])
                if (!m) continue
                const h = m[1].trim()
                if (!h || /^这一天（\d{8}）/.test(h)) continue
                out.sections.push({ f: key, file: f, line: i + 1, h })
            }
        }
    }
    return out
}

function todayTag() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return 'day-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.md'
}

export function candidates(query) {
    const src = String(query || '')
    const latin = new Set()
    for (const w of src.match(/[A-Za-z][A-Za-z0-9._-]{2,}/g) || []) {
        const low = w.toLowerCase().replace(/[._-]+$/, '')
        if (low.length < 3 || EN_STOP.has(low)) continue
        latin.add(low)
    }
    const cjk = new Set()
    const onlyCjk = src.replace(/[^\u4e00-\u9fa5]/g, ' ')
    for (const run of onlyCjk.split(/\s+/)) {
        for (let i = 0; i + 3 <= run.length; i++) cjk.add(run.slice(i, i + 3))
    }
    return { latin: [...latin], cjk: [...cjk].slice(0, 10) }
}

// Returns { hits: [{file, line, title, score, via}], reason }
export function searchRare(notesDir, query, opts = {}) {
    const maxHits = opts.maxHits || 3
    const maxDf = opts.maxDf || 2
    // 1) curated table
    if (opts.mapFile) {
        const map = readEntityMap(opts.mapFile)
        const q = String(query || '').toLowerCase()
        const today = todayTag()
        const hits = []
        for (const row of map) {
            if (row.key.length < 3 || !q.includes(row.key)) continue
            const base = row.file.split('/').pop()
            if (base === today) continue   // 今天的笔记不当记忆
            hits.push({ file: row.file, line: row.line, title: row.title || row.key, score: 9, via: 'map' })
        }
        if (hits.length) return { hits: hits.slice(0, maxHits), reason: 'map-hit' }
    }

    // 2) rare identifiers
    const idx = collectSections(notesDir)
    if (!idx.sections.length) return { hits: [], reason: 'no-sections' }
    const df = (term) => {
        const low = term.toLowerCase()
        let n = 0
        for (const [, raw] of idx.files) if (raw.includes(low)) n += 1
        return n
    }
    const { latin } = candidates(query)
    const triggers = latin
        .filter((t) => looksLikeIdentifier(t) && t.length >= 5)
        .map((t) => ({ t, df: df(t) }))
        .filter((x) => x.df >= 1 && x.df <= maxDf)
        .sort((a, b) => a.df - b.df || b.t.length - a.t.length)
        .slice(0, 2)
    if (!triggers.length) return { hits: [], reason: 'no-identifier' }

    const today = todayTag()
    const hits = []
    for (const s of idx.sections) {
        if (s.file === today) continue
        const raw = idx.files.get(s.f) || ''
        const head = s.h.toLowerCase()
        let score = 0
        for (const t of triggers) {
            if (head.includes(t.t)) score += 3
            else if (raw.includes(t.t)) score += 2
        }
        if (score > 0) hits.push({ file: s.f, line: s.line, title: s.h, score, via: 'rare' })
    }
    hits.sort((a, b) => b.score - a.score)
    return { hits: hits.slice(0, maxHits), reason: hits.length ? 'rare-hit' : 'rare-miss' }
}
