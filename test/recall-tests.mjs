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
    // gate 默认关掉：单元测试要测的是决策逻辑，不该随 model/gate-model.json 的内容变化。
    // （0.8.0 的 CI 就这么在 Linux 上挂了一个测试——模型加载成功，但判断与本地不同。）
    // gate 自己有专门的测试，见文件末尾。
    writeConfig({ ...cfg, recall: { gate: false, ...(cfg.recall || {}) } })
    const handlers = []
    const ctx = {
        get tokenMeter() { return undefined },
        on(event, fn) { assert.equal(event, 'agent/pre-step'); handlers.push(fn) },
        effect() {},
    }
    plugin.apply(ctx)
    assert.ok(handlers.length >= 1, 'apply must register the fold listener at least')
    const sent = []
    const agent = { session }
    // The batch the step is entering: one user message. Newer recall prepends its context to this
    // list instead of calling agent.inject(), because an injected message lands AFTER the prompt
    // and then gets answered as if the user had said it (2026-10-27).
    const userMsg = { id: 'user-1', role: 'user', content: [{ type: 'text', text: (session.__text || (session.events[0] && session.events[0].data.content[0].text) || 'hi') }], source: { kind: 'user' } }
    const payload = { agent, step, turn: 3, messages: [userMsg] }
    const next = async () => ({ kind: 'enter', messages: [userMsg] })
    return handlers
        .reduce((p, h) => p.then((acc) => h(payload, next).then((out) => out || acc)), Promise.resolve(null))
        .then((decision) => {
            const msgs = decision && Array.isArray(decision.messages) ? decision.messages : []
            for (const m of msgs) {
                if (m && m.source && m.source.kind === 'plugin') sent.push(['inject', m])
            }
            sent.__order = msgs.map((m) => (m && m.source && m.source.kind) || '?')
            return sent
        })
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

await test('keywords: a spam repetition yields nothing at all', () => {
  // The 为什么为什么为什么… message used to return the spam itself. Repeated runs have no
  // retrieval signal, and their 2-char grams are noise.
  assert.deepEqual(extractKeywords('为什么为什么为什么为什么'), [])
  assert.equal(plugin.isRepetitiveRun('为什么为什么为什么'), true)
  assert.equal(plugin.isRepetitiveRun('正常的一句话'), false)
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
    // The compact format is one header line plus "· path — snippet"; the path must be present.
    assert.ok(block.includes('/p'), 'the block carries each hit path')
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
    assert.ok(text.includes('.jsonl'), 'the snippet carries its source path')
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

await test('hook: recall-injected records the real query and hit paths', async () => {
    // 这条日志是将来训练数据的唯一来源：真实的问话 + 当时召回了哪几节。
    // 没有它就只能继续用"标题原文"当监督，而那已经证明学不到"换个说法"。
    seedArchive('session-r1', 'history-fold 触发线 750k')
    const sent = await run(makeSession('session-r1', ['history-fold 触发线']), {
        enabled: true, recall: { enabled: true, minIntervalMs: 0 },
    })
    assert.ok(sent.length >= 1, 'expected an injected message')
    const log = fs.readFileSync(path.join(tmp, 'logs', 'history-fold.jsonl'), 'utf8')
    const line = log.split('\n').filter((l) => l.includes('recall-injected')).pop()
    assert.ok(line, 'expected a recall-injected line')
    assert.ok(line.includes('"q":'), 'query not recorded')
    assert.ok(line.includes('"paths":'), 'hit paths not recorded')
})

await test('hook: strict no longer swallows a plain question (falls back)', async () => {
    // 2026-10-27 的决定：strict 曾经意味着"话里没有标识符就什么都不查"，日志里
    // 192 次 skip 对 590 次注入 —— 而同一批评测显示泛问题用词面 top-5 能覆盖 65~80%。
    // 所以「没找到专名」现在是退到大众路径，不是终点。
    seedArchive('session-r1', 'history-fold 触发线 750k')
    const sent = await run(makeSession('session-r1', ['history-fold 触发线']), {
        enabled: true, recall: { enabled: true, minIntervalMs: 0, strict: true },
    })
    assert.ok(sent.length >= 1, 'plain question should still recall under strict')
    const log = fs.readFileSync(path.join(tmp, 'logs', 'history-fold.jsonl'), 'utf8')
    assert.ok(log.includes('recall-fallback'), 'expected a recall-fallback line')
})

await test('hook: fallback:false restores the old strict skip, and the skip carries q', async () => {
    seedArchive('session-r1', 'history-fold 触发线 750k')
    const sent = await run(makeSession('session-r1', ['history-fold 触发线']), {
        enabled: true, recall: { enabled: true, minIntervalMs: 0, strict: true, fallback: false },
    })
    assert.equal(sent.length, 0)
    const log = fs.readFileSync(path.join(tmp, 'logs', 'history-fold.jsonl'), 'utf8')
    const line = log.split('\n').filter((l) => l.includes('strict-no-rare')).pop()
    assert.ok(line, 'expected a strict skip')
    assert.ok(line.includes('"q":'), 'skip should record the question too')
})

await test('hook: a short meta question is gated out of the fallback', async () => {
    // 实测（2026-10-27，活体）：「要怎么问呢」5 个字召回了 4 条旧账，全是噪声。
    // 档案里故意放着这句话 —— 没有门槛它一定会命中，所以这条测的是门槛本身。
    seedArchive('session-r1', '要怎么问呢 要怎么问 元问题')
    const sent = await run(makeSession('session-r1', ['要怎么问呢']), {
        enabled: true, recall: { enabled: true, minIntervalMs: 0, strict: true },
    })
    assert.equal(sent.length, 0, 'a 5-char meta question must not recall')
    const log = fs.readFileSync(path.join(tmp, 'logs', 'history-fold.jsonl'), 'utf8')
    assert.ok(log.includes('fallback-gate'), 'the gate should say why it skipped')
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

await test('the recall_memory tool registers and answers without an archive', async () => {
  // The explicit door: the model asks instead of waiting to be fed. A missing archive is a normal
  // state, not an error, so the tool must answer instead of throwing.
  const tools = []
  plugin.registerRecallTool({ tools: { register: (d) => tools.push(d) } }, {
    home: () => path.join(tmp, 'empty-home'),
    readConfig: () => ({ archiveDir: 'history-fold/archive', recall: {} }),
    log: () => {},
  })
  assert.equal(tools.length, 1, 'one tool registered')
  assert.equal(tools[0].name, 'recall_memory')
  const r = await tools[0].execute({ query: 'something that is not there' })
  assert.equal(r.ok, true)
  assert.equal(r.hits, 0)
})
// The note cache is what keeps a 3.6 MB notes dir cheap per turn. A cache that never notices a
// rewritten file would answer with stale memory -- the worst possible failure for this module.
await test('notes cache: a rewritten note is re-read, not served stale', () => {
    const dir = path.join(tmp, 'notes-cache')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'day-1.md')
    fs.writeFileSync(file, '旧内容 alpha', 'utf8')
    const first = searchNotes(dir, ['alpha'], { maxNoteHits: 2, snippetChars: 80 })
    assert.equal(first.length, 1)
    assert.equal(plugin.noteCacheSize(), 1)
    // 让 size 也跟着变：NTFS 的 mtime 精度不足以区分"同一毫秒内的两次写"，
    // 只改字节不改大小时这条测试会偶发失败（实测三次里一次 FAIL）。
    fs.writeFileSync(file, '新内容 alpha 这次写得更长一些', 'utf8')
    const second = searchNotes(dir, ['alpha'], { maxNoteHits: 2, snippetChars: 80 })
    assert.equal(second.length, 1)
    assert.ok(second[0].snippet.includes('新内容'), 'stale note served: ' + second[0].snippet)
})

await test('notes cache: a deleted note is dropped from the cache', () => {
    const dir = path.join(tmp, 'notes-drop')
    fs.mkdirSync(dir, { recursive: true })
    const a = path.join(dir, 'a.md')
    const b = path.join(dir, 'b.md')
    fs.writeFileSync(a, 'keeper 一号', 'utf8')
    fs.writeFileSync(b, 'gone 二号', 'utf8')
    searchNotes(dir, ['号码'], { maxNoteHits: 5, snippetChars: 80 })
    assert.equal(plugin.noteCacheSize(), 2)
    fs.rmSync(b)
    searchNotes(dir, ['keeper'], { maxNoteHits: 5, snippetChars: 80 })
    assert.equal(plugin.noteCacheSize(), 1, 'deleted file pinned in cache')
})

await test('notes search: the best line of a file is the one that is quoted', () => {
    const dir = path.join(tmp, 'notes-bestline')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'n.md'), ['第一行 提到 trigger 一次', '第二行 trigger trigger trigger', '第三行 无关'].join('\n'), 'utf8')
    const hits = searchNotes(dir, ['trigger'], { maxNoteHits: 1, snippetChars: 60 })
    assert.equal(hits.length, 1)
    assert.ok(hits[0].snippet.includes('第二行'), 'picked line: ' + hits[0].snippet)
})

// Per-session notes: another window's memory must not leak into this window's automatic recall.
await test('ownNotesDir prefers the session folder and falls back to the root', () => {
    const base = path.join(tmp, 'notes-perm')
    fs.mkdirSync(path.join(base, 'sid-1'), { recursive: true })
    fs.writeFileSync(path.join(base, 'sid-1', 'day-1.md'), '我方记忆 alpha', 'utf8')
    fs.writeFileSync(path.join(base, 'root.md'), '共享记忆 alpha', 'utf8')
    assert.equal(plugin.ownNotesDir(base, 'sid-1'), path.join(base, 'sid-1'))
    // Regression (2026-10-22): the session header says "session-<uuid>" while the miner names the
    // folder "<uuid>". A raw string compare missed every time and silently disabled isolation.
    assert.equal(plugin.ownNotesDir(base, 'session-sid-1'), path.join(base, 'sid-1'))
    // A session with no folder yet falls back to the shared root instead of returning nothing.
    assert.equal(plugin.ownNotesDir(base, 'sid-2'), base)
})

await test('recursive note search reaches into session folders', () => {
    const base = path.join(tmp, 'notes-recur')
    fs.mkdirSync(path.join(base, 'sid-a'), { recursive: true })
    fs.mkdirSync(path.join(base, 'sid-b'), { recursive: true })
    fs.writeFileSync(path.join(base, 'sid-a', 'day-1.md'), '别的窗口 trigger 一次', 'utf8')
    fs.writeFileSync(path.join(base, 'sid-b', 'day-1.md'), '这个窗口 trigger 两次 trigger', 'utf8')
    const flat = searchNotes(base, ['trigger'], { maxNoteHits: 5, snippetChars: 60 })
    assert.equal(flat.length, 0, 'flat search should not cross folders')
    const deep = searchNotes(base, ['trigger'], { maxNoteHits: 5, snippetChars: 60, recursive: true })
    assert.equal(deep.length, 2)
    assert.ok(deep[0].source.includes('sid-'), 'source should name the session folder: ' + deep[0].source)
})

await test('crossSession: off reads only this window, on reads every window', async () => {
  // Isolation by default; "remember everything" as an explicit opt-in.
  const notesBase = path.join(tmp, 'notes-cross')
  fs.mkdirSync(path.join(notesBase, 'mine'), { recursive: true })
  fs.mkdirSync(path.join(notesBase, 'other'), { recursive: true })
  fs.writeFileSync(path.join(notesBase, 'mine', 'day-1.md'), '本窗口的碎碎念', 'utf8')
  fs.writeFileSync(path.join(notesBase, 'other', 'day-1.md'), '别的窗口记下了 zetaquux 这个暗号', 'utf8')
  const mk = () => makeSession('mine', ['关于 zetaquux 你还记得吗'])
  const off = await run(mk(), { enabled: true, recall: { enabled: true, minIntervalMs: 0, notesDir: notesBase, crossSession: false, maxChars: 3000 } })
  assert.ok(!JSON.stringify(off).includes('zetaquux 这个暗号'), 'isolation leaked with crossSession off')
  const on = await run(mk(), { enabled: true, recall: { enabled: true, minIntervalMs: 0, notesDir: notesBase, crossSession: true, maxChars: 3000 } })
  assert.ok(JSON.stringify(on).includes('zetaquux 这个暗号'), 'crossSession did not reach the other window')
})

// ---------------------------------------------------------------- gate（分类器）单独测
// 它测的是"模型文件能不能加载、分数是不是可用"，不测召回逻辑——所以不经过 run() 的 gate:false。
await test('gate: the bundled model loads and separates obvious cases', async () => {
    const { makeGate } = await import('../lib/gate.js')
    const g = makeGate()
    assert.equal(g.available, true, 'model/gate-model.json should ship with the package')
    // 明确的回忆意图要给高分，明显的当下问题/寒暄要给低分
    assert.ok(g.prob('我们之前选过哪个模型来做检索') > 0.6, 'recall intent should score high')
    assert.ok(g.prob('现在跑到第几步了') < 0.4, 'status question should score low')
    assert.ok(g.prob('要怎么问呢') < 0.4, 'meta question should score low')
})

await test('gate: a missing model file degrades to "no opinion"', async () => {
    const { makeGate } = await import('../lib/gate.js')
    const g = makeGate({ modelFile: path.join(tmp, 'no-such-model.json') })
    assert.equal(g.available, false)
    assert.equal(g.allow('随便一句话'), true, 'without a model the rules must decide')
    assert.equal(g.prob('随便一句话'), null)
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
