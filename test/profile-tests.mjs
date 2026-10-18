// Offline tests for the profiling instrument that dsh-history-fold writes once per turn.
// The profile line is what the whole fold policy gets tuned from, so it needs its own test:
// a bug here would waste a DSH restart and produce numbers that mislead.
//
// Run: npm run test:profile   (or: node test/profile-tests.mjs)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'history-fold-profile-'))
process.env.DSH_HOME = tmp
fs.mkdirSync(path.join(tmp, 'dsh-history-fold'), { recursive: true })

const plugin = await import('../lib/index.js')

let passed = 0
let failed = 0
// NOTE: this must await fn(); a synchronous body would print "ok" before any async
// assertion ran and let the script exit first, making the whole suite vacuous.
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
  fs.writeFileSync(path.join(tmp, 'dsh-history-fold', 'config.json'), JSON.stringify(cfg))
}

// steps of: user ask (100 tok) -> assistant with one tool-call (50) -> tool/result (900).
// Tool results deliberately dominate, which is the case the policy has to notice.
function makeSession(steps, tokens) {
  const events = []
  const nodes = []
  const push = (type, data) => {
    const seq = events.length
    events.push({ seq, type, data })
    nodes.push(seq)
    return seq
  }
  for (let i = 0; i < steps; i++) {
    tokens.push(100)
    push('user/message', { id: 'u' + i, role: 'user', content: [{ type: 'text', text: 'ask ' + i }], source: { kind: 'user' } })
    tokens.push(50)
    push('assistant/message', {
      message: { id: 'a' + i, role: 'assistant', content: [{ type: 'tool-call', id: 'c' + i, name: 't', arguments: '{}' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    })
    tokens.push(900)
    push('tool/result', { message: { id: 'r' + i, role: 'user', content: [{ type: 'tool-result', toolCallId: 'c' + i, content: [] }], source: { kind: 'tool', callId: 'c' + i } } })
  }
  const session = { surface: { nodes: nodes.slice(), replaceGeneration: 0 }, events, append() {} }
  // The meter is keyed by seq, exactly like dsh-token-meter's measure().nodes.
  const meter = {
    measure() {
      let surfaceTokens = 0
      const measuredNodes = nodes.map((seq, i) => {
        const t = tokens[i] || 0
        surfaceTokens += t
        return { seq, tokens: t }
      })
      return { surfaceTokens, totalTokens: surfaceTokens, baseline: { kind: 'estimated', tokens: 0 }, nodes: measuredNodes }
    },
  }
  return { session, meter }
}

function runHandler(session, meter, step = 1) {
  const handlers = []
  const ctx = {
    get tokenMeter() { return meter },
    on(event, fn) { assert.equal(event, 'agent/pre-step'); handlers.push(fn) },
    effect() {},
  }
  plugin.apply(ctx)
  assert.ok(handlers.length >= 1)
  const payload = { agent: { session }, step, turn: 7 }
  const next = async () => {}
  return handlers.reduce((p, h) => p.then(() => h(payload, next)), Promise.resolve())
}

function profileLine() {
  const file = path.join(tmp, 'logs', 'history-fold.jsonl')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const profile = lines.filter((l) => l.mark === 'profile')
  return profile[profile.length - 1]
}

console.log('dsh-history-fold profile tests')

let last = null

await test('one profile line per turn, with the real meter numbers', async () => {
  writeConfig({ enabled: true, dryRun: true, profile: true, minNodes: 100000, keepRecentNodes: 20, minFoldNodes: 5, onlyAtTurnStart: true })
  const tokens = []
  const { session, meter } = makeSession(100, tokens)
  await runHandler(session, meter)
  last = profileLine()
  assert.equal(last.mark, 'profile')
  assert.equal(last.step, 1)
  assert.equal(last.turn, 7)
  assert.equal(last.nodes, 300, 'expected 3 nodes per step x 100 steps')
  assert.equal(last.meterAvailable, true)
  // 100 steps x (100 + 50 + 900)
  assert.equal(last.surfaceTokens, 100 * 1050)
  assert.equal(last.totalTokens, last.surfaceTokens)
  assert.equal(last.baseline, 'estimated')
})

await test('token share by event type exposes the real cost driver', async () => {
  assert.deepEqual(last.tokensByType, {
    'user/message': 100 * 100,
    'assistant/message': 100 * 50,
    'tool/result': 100 * 900,
  })
  assert.deepEqual(last.byType['tool/result'], { n: 100, bytes: last.byType['tool/result'].bytes })
  assert.ok(last.byType['tool/result'].bytes > 0)
  // tool/result must be reported as the dominant class, not the most numerous one
  assert.ok(last.tokensByType['tool/result'] > last.tokensByType['user/message'] * 5)
})

await test('source kinds are counted, so compaction checkpoints are visible', async () => {
  assert.deepEqual(last.srcKinds, { user: 100, model: 100, tool: 100 })
})

await test('the single biggest node is identified', async () => {
  assert.ok(last.maxNode)
  assert.equal(last.maxNode.type, 'tool/result')
  assert.equal(last.maxNode.tokens, 900)
  assert.equal(typeof last.maxNode.seq, 'number')
})

await test('head and tail carry type, source and size', async () => {
  assert.equal(last.head.length, 3)
  assert.equal(last.tail.length, 3)
  assert.equal(last.head[0].type, 'user/message')
  assert.equal(last.head[0].src, 'user')
  assert.equal(last.tail[2].type, 'tool/result')
  assert.equal(last.tail[2].src, 'tool')
  assert.ok(last.tail[2].bytes > 0)
})

await test('foldOptions reports what each keepRecent would actually save', async () => {
  const byKeep = new Map(last.foldOptions.map((o) => [o.keep, o]))
  assert.deepEqual([...byKeep.keys()].sort((a, b) => a - b), [20, 40, 80, 160])
  for (const keep of [20, 40, 80, 160]) {
    const row = byKeep.get(keep)
    // 300 nodes, so keeping 20 leaves at most 280 foldable, minus the balance trimming
    assert.ok(row.foldNodes > 0 && row.foldNodes <= 300 - keep)
    assert.ok(row.foldTokens > 0)
    assert.ok(row.foldPct > 0 && row.foldPct <= 100)
  }
  // keeping less must never save less
  assert.ok(byKeep.get(20).foldTokens >= byKeep.get(40).foldTokens)
  assert.ok(byKeep.get(40).foldTokens >= byKeep.get(80).foldTokens)
  assert.ok(byKeep.get(80).foldTokens >= byKeep.get(160).foldTokens)
})

await test('without a visible meter it still writes a usable byte profile', async () => {
  writeConfig({ enabled: true, dryRun: true, profile: true, minNodes: 100000, keepRecentNodes: 20, minFoldNodes: 5, onlyAtTurnStart: true })
  const tokens = []
  const { session } = makeSession(30, tokens)
  await runHandler(session, undefined)
  const line = profileLine()
  assert.equal(line.meterAvailable, false)
  assert.equal(line.surfaceTokens, undefined)
  assert.equal(line.tokensByType, undefined)
  assert.ok(line.totalBytes > 0)
  assert.ok(line.foldOptions.length > 0)
  assert.equal(line.foldOptions[0].foldTokens, undefined)
  assert.ok(line.foldOptions[0].foldNodes > 0)
})

await test('profiling is silent when the plugin is disabled', async () => {
  writeConfig({ enabled: false, dryRun: true, profile: true, minNodes: 100000 })
  const tokens = []
  const { session, meter } = makeSession(30, tokens)
  await runHandler(session, meter)
  const file = path.join(tmp, 'logs', 'history-fold.jsonl')
  const before = fs.readFileSync(file, 'utf8').trim().split('\n').length
  const tokens2 = []
  const second = makeSession(30, tokens2)
  await runHandler(second.session, second.meter)
  const after = fs.readFileSync(file, 'utf8').trim().split('\n').length
  assert.equal(after, before, 'a disabled plugin must write nothing')
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
