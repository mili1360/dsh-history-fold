// Offline tests for dsh-history-fold's live policy: token-driven folding, the pre-fold
// archive, and the extractive digest that replaces the folded range.
// Nothing here touches the running DSH or the real DSH_HOME.
//
// Run: npm test   (or: node test/fold-tests.mjs)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'history-fold-test-'))
process.env.DSH_HOME = tmp
fs.mkdirSync(path.join(tmp, 'dsh-history-fold'), { recursive: true })

const plugin = await import('../lib/index.js')

let passed = 0
let failed = 0
// NOTE: this must await fn(). Call sites write `await test(..., async () => {...})`, so a
// synchronous body here would report "ok" before a single async assertion ran -- and the
// script would reach process.exit() first, making every async case vacuous.
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
const NODE_TOKENS = [100, 50, 900]

function makeSession(steps) {
  const events = []
  const nodes = []
  const tokens = []
  const push = (type, data, t) => {
    const seq = events.length
    events.push({ seq, type, data })
    nodes.push(seq)
    tokens.push(t)
    return seq
  }
  for (let i = 0; i < steps; i++) {
    push('user/message', { id: 'u' + i, role: 'user', content: [{ type: 'text', text: 'ask number ' + i }], source: { kind: 'user' } }, NODE_TOKENS[0])
    push('assistant/message', {
      message: { id: 'a' + i, role: 'assistant', content: [{ type: 'tool-call', id: 'c' + i, name: 'tool' + i, arguments: '{"i":' + i + '}' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, NODE_TOKENS[1])
    push('tool/result', { message: { id: 'r' + i, role: 'user', content: [{ type: 'tool-result', toolCallId: 'c' + i, content: [] }], source: { kind: 'tool', callId: 'c' + i } } }, NODE_TOKENS[2])
  }
  const appended = []
  const session = {
    header: { id: 'session-test-0001' },
    surface: { nodes: nodes.slice(), replaceGeneration: 0 },
    events,
    append(type, data, opts) {
      appended.push({ type, data, opts })
      return { seq: events.length }
    },
  }
  const meter = {
    measure() {
      let surfaceTokens = 0
      const measuredNodes = nodes.map((seq, i) => {
        surfaceTokens += tokens[i]
        return { seq, tokens: tokens[i] }
      })
      return { surfaceTokens, totalTokens: surfaceTokens + 13000, baseline: { kind: 'estimated', tokens: 0 }, nodes: measuredNodes }
    },
  }
  return { session, meter, nodes, tokens, appended }
}

function runHandler(session, meter, step = 1) {
  let handler
  const ctx = {
    get tokenMeter() { return meter },
    on(event, fn) { assert.equal(event, 'agent/pre-step'); handler = fn },
    effect() {},
  }
  plugin.apply(ctx)
  assert.equal(typeof handler, 'function', 'apply must register an agent/pre-step listener')
  let nexted = false
  return Promise.resolve(handler({ agent: { session }, step, turn: 12 }, async () => { nexted = true })).then(() => nexted)
}

function logLines() {
  const file = path.join(tmp, 'logs', 'history-fold.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function lastMark() {
  const lines = logLines()
  return lines[lines.length - 1]
}

function archivePath() {
  return path.join(tmp, 'history-fold', 'archive', 'session-test-0001.jsonl')
}

// targetSurfaceTokens must be reachable GIVEN keepRecentNodes: the fixture keeps 9 nodes and
// each step is 3 nodes / 1050 tokens, so at least 3 steps (3150 tokens) always remain. A target
// of 2000 was unreachable, which made pickEndIndex return -1 and every fold test report
// "no-safe-cut" instead of "folded".
const BASE = {
  enabled: true,
  dryRun: false,
  profile: false,
  triggerSurfaceTokens: 5000,
  targetSurfaceTokens: 4000,
  keepRecentNodes: 9,
  minFoldNodes: 3,
  minFoldTokens: 1000,
  archive: true,
  archiveDir: 'history-fold/archive',
  digestMaxChars: 30000,
  digestLineChars: 160,
  onlyAtTurnStart: true,
}

console.log('dsh-history-fold tests')

await test('disabled: never appends, never archives, never logs', async () => {
  writeConfig({ enabled: false })
  const { session, meter } = makeSession(20)
  await runHandler(session, meter)
  assert.equal(logLines().length, 0)
  assert.ok(!fs.existsSync(path.join(tmp, 'history-fold')), 'nothing may be created')
})

await test('no config.json at all: inert, exactly as the SAFETY block promises', async () => {
  // The header promises a fresh install "changes nothing at all". That is a contract, so it
  // gets a test: DEFAULTS themselves must be inert, with no config file present.
  fs.rmSync(path.join(tmp, 'dsh-history-fold', 'config.json'), { force: true })
  fs.rmSync(path.join(tmp, 'logs'), { recursive: true, force: true })
  fs.rmSync(path.join(tmp, 'history-fold'), { recursive: true, force: true })
  const { session, meter, appended } = makeSession(20)
  await runHandler(session, meter)
  assert.equal(appended.length, 0, 'a fresh install must not fold anything')
  assert.ok(!fs.existsSync(path.join(tmp, 'history-fold')), 'a fresh install must not archive')
  assert.ok(!fs.existsSync(path.join(tmp, 'logs', 'history-fold.jsonl')), 'a fresh install must not even log')
})

await test('below the trigger: idle, nothing written', async () => {
  writeConfig({ ...BASE, triggerSurfaceTokens: 1000000 })
  const { session, meter, appended } = makeSession(20)
  await runHandler(session, meter)
  assert.equal(appended.length, 0)
  assert.equal(lastMark().mark, 'idle')
  assert.equal(lastMark().surfaceTokens, 20 * 1050)
})

await test('dry run: reports the fold but writes nothing at all', async () => {
  writeConfig({ ...BASE, dryRun: true })
  const { session, meter, appended } = makeSession(20)
  await runHandler(session, meter)
  assert.equal(appended.length, 0, 'dry run must not append')
  assert.ok(!fs.existsSync(path.join(tmp, 'history-fold')), 'dry run must not archive')
  const mark = lastMark()
  assert.equal(mark.mark, 'would-fold')
  assert.ok(mark.foldTokens > 0)
  assert.ok(mark.foldPct > 0)
})

await test('no meter: refuses to fold blind rather than guess', async () => {
  writeConfig(BASE)
  const { session, appended } = makeSession(20)
  await runHandler(session, undefined)
  assert.equal(appended.length, 0)
  assert.equal(lastMark().mark, 'no-meter')
})

await test('live fold: correct span, provenance and balance', async () => {
  writeConfig(BASE)
  const { session, meter, appended } = makeSession(20)
  await runHandler(session, meter)

  assert.equal(appended.length, 1, 'expected exactly one append')
  const { type, data, opts } = appended[0]
  assert.equal(type, 'user/message')
  assert.equal(data.role, 'user')
  assert.equal(typeof data.id, 'string')
  assert.ok(data.id.length > 0)
  assert.equal(data.source.kind, 'plugin')
  assert.equal(data.content[0].type, 'text')

  // surfaceOp must have exactly the 3 keys op/start/end (dsh-session:300-303)
  assert.deepEqual(Object.keys(opts.surfaceOp).sort(), ['end', 'op', 'start'])
  assert.equal(opts.surfaceOp.op, 'replace')

  const startIdx = session.surface.nodes.indexOf(opts.surfaceOp.start)
  const endIdx = session.surface.nodes.indexOf(opts.surfaceOp.end)
  assert.equal(startIdx, 0, 'the fold must start at the oldest node')
  assert.ok(endIdx > startIdx)
  const shadowed = session.surface.nodes.slice(startIdx, endIdx + 1)

  // sourceEventSeqs must cover EVERY shadowed node, with no duplicates
  const sources = opts.sourceEventSeqs
  assert.deepEqual([...sources].sort((a, b) => a - b), [...shadowed].sort((a, b) => a - b))
  assert.equal(new Set(sources).size, sources.length)

  // the cut must be tool-pairing balanced: no open tool call may cross it
  let open = 0
  for (let i = 0; i <= endIdx; i++) {
    const ev = session.events[session.surface.nodes[i]]
    if (ev.type === 'tool/result') open -= 1
    else if (ev.type === 'assistant/message') open += ev.data.message.content.filter((b) => b.type === 'tool-call').length
  }
  assert.equal(open, 0, 'an open tool call must never cross the fold cut')

  // the recent tail is untouched
  assert.equal(session.surface.nodes.length - endIdx - 1, 9, 'keepRecentNodes must be preserved exactly')
})

await test('live fold: stops as soon as the target is met, and not one node earlier', async () => {
  const mark = lastMark()
  assert.equal(mark.mark, 'folded')
  const remaining = mark.surfaceTokens - mark.foldTokens
  assert.ok(remaining <= BASE.targetSurfaceTokens, 'must fold down to the target')
  // Folding one node less would leave it above the target, i.e. it did not over-fold.
  const { nodes, tokens } = makeSession(20)
  const endIdx = nodes.indexOf(mark.endSeq)
  assert.ok(remaining + tokens[endIdx] > BASE.targetSurfaceTokens, 'must not fold more than required')
})

await test('live fold: the full text of every folded node is archived first', async () => {
  const file = archivePath()
  assert.ok(fs.existsSync(file), 'archive file must exist')
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const mark = lastMark()
  assert.equal(rows.length, mark.folded, 'one archive row per folded node')
  assert.equal(rows[0].seq, mark.startSeq)
  assert.equal(rows[rows.length - 1].seq, mark.endSeq)
  assert.equal(rows[0].type, 'user/message')
  assert.equal(rows[0].src, 'user')
  assert.equal(rows[0].text, 'ask number 0')
  // tool calls keep a readable stub, so the archive stands on its own
  const call = rows.find((r) => r.type === 'assistant/message')
  assert.ok(call.text.includes('[tool-call tool0 {"i":0}]'), 'got ' + JSON.stringify(call.text))
})

await test('live fold: the replacement carries an index and points at the archive', async () => {
  const fresh = makeSession(20)
  await runHandler(fresh.session, fresh.meter)
  const body = fresh.appended[0].data.content[0].text
  assert.ok(body.includes('history-fold'), 'must be attributable')
  assert.ok(body.includes('session-test-0001.jsonl'), 'must name the archive file')
  assert.ok(body.includes('NOTHING WAS DELETED'))
  assert.ok(body.includes('[0] user/message (user) seq=0: ask number 0'), 'index line must be extractive')
  assert.ok(body.includes('(all '), 'must state whether the index was sampled')
})

await test('the digest samples itself when it would exceed its budget', async () => {
  writeConfig({ ...BASE, digestMaxChars: 400 })
  const fresh = makeSession(20)
  await runHandler(fresh.session, fresh.meter)
  const body = fresh.appended[0].data.content[0].text
  assert.ok(/sampled: every [0-9]+th of [0-9]+ folded messages/.test(body), 'must say it sampled: ' + body.slice(0, 200))
  assert.ok(body.length < 4000, 'the digest must stay near its budget, got ' + body.length)
})

await test('archive failure blocks the fold instead of losing history', async () => {
  // Put a FILE where the archive directory must go, so mkdir cannot succeed.
  const blocker = path.join(tmp, 'history-fold', 'blocked')
  fs.writeFileSync(blocker, 'not a directory')
  writeConfig({ ...BASE, archiveDir: 'history-fold/blocked' })
  const fresh = makeSession(20)
  await runHandler(fresh.session, fresh.meter)
  assert.equal(fresh.appended.length, 0, 'nothing may be folded when the archive failed')
  assert.equal(lastMark().mark, 'archive-failed')
})

await test('never folds in the middle of a turn', async () => {
  writeConfig(BASE)
  const fresh = makeSession(20)
  await runHandler(fresh.session, fresh.meter, 5)
  assert.equal(fresh.appended.length, 0)
})

await test('a broken session cannot throw out of the hook (fails open)', async () => {
  writeConfig(BASE)
  const session = { surface: { get nodes() { throw new Error('boom') } }, events: [], append() {} }
  const nexted = await runHandler(session, undefined)
  assert.equal(nexted, true, 'must still call next()')
  assert.ok(logLines().some((l) => l.mark === 'error'), 'the failure must be logged')
})

await test('always calls next(), so a turn is never blocked', async () => {
  writeConfig(BASE)
  const fresh = makeSession(20)
  const nexted = await runHandler(fresh.session, fresh.meter)
  assert.equal(nexted, true)
})

// Regression: a tool-result block nests its payload as
// {toolCallId, content:[{type:'text',text}]}. The stub branch used to drop that nested
// content, so the archive kept only "[tool-result c0]" and the real output became unreadable
// once the span left the visible surface. makeSession() builds tool results with an EMPTY
// content array, which is why the suite stayed green while the bug was live -- so this test
// builds its own session whose tool results carry a body.
// Verified 2026-10-11 on a real 608-message fold: bodies kept went 0/300 -> 298/298.
await test('the archive keeps the real tool-result body, not just the call id', async () => {
  writeConfig(BASE)
  // The archive is shared across cases and appended to, and makeSession()'s tool results carry
  // an EMPTY content array, so start from a clean file or this case would scan their rows too.
  fs.rmSync(archivePath(), { force: true })

  const events = []
  const nodes = []
  const tokens = []
  const push = (type, data, t) => {
    const seq = events.length
    events.push({ seq, type, data })
    nodes.push(seq)
    tokens.push(t)
  }
  const body = 'BODY-7f3a9c ' + 'x'.repeat(600)
  for (let i = 0; i < 20; i++) {
    push('user/message', { id: 'u' + i, role: 'user', content: [{ type: 'text', text: 'ask ' + i }], source: { kind: 'user' } }, 100)
    push('assistant/message', { message: { id: 'a' + i, role: 'assistant', content: [{ type: 'tool-call', id: 'c' + i, name: 'tool', arguments: '{}' }], source: { kind: 'model' } } }, 50)
    push('tool/result', {
      message: {
        id: 'r' + i, role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c' + i, content: [{ type: 'text', text: body }] }],
        source: { kind: 'tool', callId: 'c' + i },
      },
    }, 900)
  }
  const session = {
    header: { id: 'session-test-0001' },
    surface: { nodes: nodes.slice(), replaceGeneration: 0 },
    events,
    append() { return { seq: events.length } },
  }
  const meter = {
    measure() {
      let surfaceTokens = 0
      const measuredNodes = nodes.map((seq, i) => { surfaceTokens += tokens[i]; return { seq, tokens: tokens[i] } })
      return { surfaceTokens, totalTokens: surfaceTokens + 13000, baseline: { kind: 'estimated', tokens: 0 }, nodes: measuredNodes }
    },
  }
  await runHandler(session, meter)
  assert.equal(lastMark().mark, 'folded', 'the fold must have happened')
  const rows = fs.readFileSync(archivePath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const toolRows = rows.filter((r) => r.type === 'tool/result')
  assert.ok(toolRows.length > 0, 'the folded span must contain tool results')
  assert.ok(toolRows.every((r) => r.text.includes(body)), 'every archived tool result must carry its body verbatim')
  // the fixture names its calls c0, c1, ... -- keep the id so a body can be traced to its call
  assert.ok(toolRows.every((r) => /\[tool-result c\d+\]/.test(r.text)), 'the call id must stay for correlation')
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
