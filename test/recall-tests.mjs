// Tests for the recall module inside dsh-history-fold.
//
// The recall module greps the live session's own archive (and optionally a notes dir) for the
// keywords in the current turn. What matters here is not "does it find text" but:
//   - it never fires on chit-chat (a recall block every turn would drown the conversation)
//   - the block stays inside its character budget
//   - dryRun really injects nothing
//   - a hostile agent or a missing archive cannot break a turn
//
// Run: node test/recall-tests.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const plugin = await import('../lib/index.js')
const { extractKeywords, searchArchive, searchNotes, formatBlock, snippetOf } = plugin

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-tests-'))
process.env.DSH_HOME = tmp

let passed = 0
let failed = 0
async function test(label, fn) {
    try {
        await fn()
        passed++
        console.log('  ok   ' + label)
    } catch (err) {
        failed++
        console.log('  FAIL ' + label + ' -> ' + err.message)
    }
}

function writeConfig(cfg) {
    const dir = path.join(tmp, 'dsh-history-fold')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg))
}

function makeSession(id, texts) {
    const events = texts.map((t, i) => ({
        seq: i,
        type: 'user/message',
        data: { content: [{ type: 'text', text: t }], source: { kind: 'user' } },
    }))
    return { header: { id }, events, surface: { nodes: events.map((e) => e.seq) } }
}

// Fires every registered agent/pre-step handler, the way the host does.
function run(session, cfg, step = 1) {
    writeConfig(cfg)
    const handlers = []
    const ctx = {
        get tokenMeter() { return undefined },
        on(event, fn) { assert.equal(event, 'agent/pre-step'); handlers.push(fn) },
        effect() {},
    }
    plugin.apply(ctx)
    assert.ok(handlers.length >= 1, 'apply must register the fold listener at least')
    const sent = []
    const agent = { session, inject: (m) => sent.push(['inject', m]), steer: (m) => sent.push(['steer', m]) }
    const payload = { agent, step, turn: 3 }
    const next = async () => {}
    return handlers
        .reduce((p, h) => p.then(() => h(payload, next)), Promise.resolve())
        .then(() => sent)
}

// ---------------------------------------------------------------- keywords
await test('keywords: latin words and CJK grams, stopwords dropped', () => {
    const k = extractKeywords('我们为什么要把 timeout 改掉？', { minKeywordChars: 2, maxKeywords: 10 })
    assert.ok(k.includes('timeout'), 'latin word kept')
    assert.ok(!k.includes('我们'), 'stopword dropped')
    assert.ok(k.every((x) => x.length >= 2), 'no single characters')
})

await test('keywords: a one-character-only message yields nothing', () => {
    assert.equal(extractKeywords('a 我 的', { minKeywordChars: 2, maxKeywords: 10 }).length, 0)
})

await test('keywords: meme captions are not search terms', () => {
    // Measured live 2026-10-18: this exact shape produced 表情/室内/内实/实景/景背/背景.
    const k = extractKeywords('可以，哈哈 [表情: 托腮思考，头顶加载圈，脑子转不动]', { minKeywordChars: 2, maxKeywords: 10 })
    for (const bad of ['表情', '室内', '内实', '实景', '景背', '背景', '托腮', '加载']) {
        assert.ok(!k.includes(bad), 'meme word leaked into keywords: ' + bad)
    }
})

// ---------------------------------------------------------------- snippets
await test('snippetOf: cuts around the match and marks both ends', () => {
    const s = snippetOf('x'.repeat(300) + 'TARGET' + 'y'.repeat(300), 'TARGET', 50)
    assert.ok(s.includes('TARGET'))
    assert.ok(s.startsWith('...') && s.endsWith('...'))
    assert.ok(s.length <= 50 + 6, 'cut plus the two ellipses: ' + s.length)
})

// ---------------------------------------------------------------- archive search
await test('searchArchive: ranks the node that mentions the keyword most', () => {
    const file = path.join(tmp, 'archive.jsonl')
    fs.writeFileSync(file, [
        { seq: 1, type: 'user/message', text: 'nothing to see here' },
        { seq: 2, type: 'user/message', text: 'history-fold 的 dryRun 关掉了，history-fold 真的折了' },
        { seq: 3, type: 'tool/result', text: 'unrelated output' },
    ].map((r) => JSON.stringify(r)).join('\n'))
    const hits = searchArchive(file, ['history-fold'], { maxArchiveHits: 4, snippetChars: 200 })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].source, 'archive.jsonl#seq2')
    assert.ok(hits[0].snippet.includes('history-fold'))
})

await test('searchArchive: a missing file is not an error', () => {
    assert.deepEqual(searchArchive(path.join(tmp, 'nope.jsonl'), ['x'], {}), [])
})

await test('searchArchive: a row that only carries a meme caption is not a hit', () => {
    const file = path.join(tmp, 'meme-only.jsonl')
    fs.writeFileSync(file, [
        { seq: 1, type: 'user/message', text: '好的 [表情: 室内实景背景，女仆装半身]' },
        { seq: 2, type: 'user/message', text: '室内实景背景 这个词其实是我在说插件' },
    ].map((r) => JSON.stringify(r)).join('\n'))
    const hits = searchArchive(file, ['室内'], { maxArchiveHits: 4, snippetChars: 120 })
    assert.equal(hits.length, 1, 'only the row that mentions it outside a caption')
    assert.equal(hits[0].source, 'meme-only.jsonl#seq2')
})

// ---------------------------------------------------------------- notes search
await test('searchNotes: one snippet per file, the best line wins', () => {
    const dir = path.join(tmp, 'notes')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plan.md'), 'first line\nram 256 GB is the target plan\nunrelated\n')
    fs.writeFileSync(path.join(dir, 'other.md'), 'nothing here\n')
    const hits = searchNotes(dir, ['ram'], { maxNoteHits: 3, snippetChars: 200 })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].source, 'plan.md')
    assert.ok(hits[0].snippet.includes('ram'))
})

// ---------------------------------------------------------------- budget
await test('formatBlock: respects maxChars, and returns empty with no hits', () => {
    assert.equal(formatBlock([], {}), '')
    const hits = Array.from({ length: 10 }, (_, i) => ({ source: 's' + i, path: '/p', snippet: 'x'.repeat(200) }))
    const block = formatBlock(hits, { maxChars: 600 })
    assert.ok(block.length <= 600, 'block inside budget: ' + block.length)
    assert.ok(block.includes('路径: /p'))
})

// ---------------------------------------------------------------- the hook
function seedArchive(sid, text) {
    const dir = path.join(tmp, 'history-fold', 'archive')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify({ seq: 1, type: 'user/message', text }) + '\n')
}

await test('hook: injects one steer when the session archive has a hit', async () => {
    seedArchive('session-r1', '当时把 history-fold 的触发线定在 750k')
    const sent = await run(makeSession('session-r1', ['history-fold 的触发线是多少']), {
        enabled: true, recall: { enabled: true, dryRun: false, minIntervalMs: 0 },
    })
    assert.equal(sent.length, 1, 'exactly one injection')
    assert.equal(sent[0][0], 'inject', 'inject() is preferred over steer()')
    const text = sent[0][1].content[0].text
    assert.ok(text.includes('750k'))
    assert.ok(text.includes('路径:'), 'the snippet carries its source path')
    assert.equal(sent[0][1].source.kind, 'plugin', 'must not pretend to be the user')
})

await test('hook: chit-chat with too few keywords injects nothing', async () => {
    const sent = await run(makeSession('session-r2', ['喵喵喵']), {
        enabled: true, recall: { enabled: true, minIntervalMs: 0 },
    })
    assert.equal(sent.length, 0)
})

await test('hook: recall disabled leaves the fold module alone and injects nothing', async () => {
    seedArchive('session-r1', 'history-fold 触发线 750k')
    const sent = await run(makeSession('session-r1', ['history-fold 触发线']), {
        enabled: true, recall: { enabled: false },
    })
    assert.equal(sent.length, 0)
})

await test('hook: dryRun logs the intent and steers nothing', async () => {
    seedArchive('session-r1', 'history-fold 触发线 750k')
    const sent = await run(makeSession('session-r1', ['history-fold 触发线']), {
        enabled: true, recall: { enabled: true, dryRun: true, minIntervalMs: 0 },
    })
    assert.equal(sent.length, 0)
    const log = fs.readFileSync(path.join(tmp, 'logs', 'history-fold.jsonl'), 'utf8')
    assert.ok(log.includes('recall-would-inject'))
})

await test('hook: a step other than the first is ignored', async () => {
    seedArchive('session-r1', 'history-fold 触发线 750k')
    const sent = await run(makeSession('session-r1', ['history-fold 触发线']), {
        enabled: true, recall: { enabled: true, minIntervalMs: 0 },
    }, 2)
    assert.equal(sent.length, 0)
})

await test('hook: a hostile agent is contained (the turn still proceeds)', async () => {
    writeConfig({ enabled: true, recall: { enabled: true, minIntervalMs: 0 } })
    const handlers = []
    plugin.apply({ on(e, f) { handlers.push(f) }, effect() {} })
    let reached = false
    const payload = { agent: { get session() { throw new Error('boom') } }, step: 1 }
    for (const h of handlers) await h(payload, async () => { reached = true })
    assert.ok(reached, 'next() still ran')
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
