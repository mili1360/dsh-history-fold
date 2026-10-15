// Edge-case and robustness tests for dsh-history-fold.
//
// fold-tests.mjs covers the happy path and the main guards. This file covers the boundaries
// that a plugin meant to rewrite conversation history must not get wrong:
// unreachable targets, minimums, exact-threshold behaviour, unclosed tool pairs, degenerate
// surfaces, hostile config, and a second fold in the same session.
//
// Nothing here touches a running DSH or the real DSH_HOME.
//
// Run: npm run test:edge
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'history-fold-edge-'))
process.env.DSH_HOME = tmp
fs.mkdirSync(path.join(tmp, 'dsh-history-fold'), { recursive: true })

const plugin = await import('../lib/index.js')

let passed = 0
let failed = 0

// NOTE: must await fn(). A synchronous harness reports "ok" before any async assertion runs
// and lets the script reach process.exit() first, turning the whole suite into a no-op.
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

// Build a session from an explicit node script, so odd shapes are expressible.
// Each entry: { type, data, tokens }. toolCallId/toolResultId let us leave a pair unbalanced.
function buildSession(entries) {
  const events = []
  const nodes = []
  const tokens = []
  const tokensBySeq = new Map()
  for (const e of entries) {
    const seq = events.length
    events.push({ seq, type: e.type, data: e.data })
    nodes.push(seq)
    tokens.push(e.tokens)
    tokensBySeq.set(seq, e.tokens)
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
  // The meter must read the LIVE surface, not a snapshot: a fold replaces a range with one
  // new seq, and a meter that kept the original array would keep reporting the old size.
  const meter = {
    setTokens(seq, n) { tokensBySeq.set(seq, n) },
    measure() {
      let surfaceTokens = 0
      const measured = session.surface.nodes.map((seq) => {
        const t = tokensBySeq.get(seq) || 0
        surfaceTokens += t
        return { seq, tokens: t }
      })
      return { surfaceTokens, totalTokens: surfaceTokens + 13000, baseline: { kind: 'estimated', tokens: 0 }, nodes: measured }
    },
  }
  return { session, meter, nodes, tokens, appended }
}

const STEP = [
  { type: 'user/message', tokens: 100, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'ask' }], source: { kind: 'user' } } },
  { type: 'assistant/message', tokens: 50, data: { message: { id: 'a', role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 't', arguments: '{}' }], source: { kind: 'model' } } } },
  { type: 'tool/result', tokens: 900, data: { message: { id: 'r', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c', content: [] }], source: { kind: 'tool' } } } },
]

// n steps of the standard shape, 1050 tokens each
function makeSteps(n, tokens = null) {
  const out = []
  for (let i = 0; i < n; i++) {
    for (const s of STEP) out.push({ ...s, tokens: tokens === null ? s.tokens : tokens })
  }
  return out
}

async function runHandler(session, meter, step = 1) {
  let handler
  const ctx = {
    get tokenMeter() { return meter },
    on(event, fn) { assert.equal(event, 'agent/pre-step'); handler = fn },
    effect() {},
  }
  plugin.apply(ctx)
  assert.equal(typeof handler, 'function', 'apply must register an agent/pre-step listener')
  return Promise.resolve(handler({ agent: { session }, step, turn: 12 }, async () => {})).then(() => true)
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
function resetLog() {
  fs.rmSync(path.join(tmp, 'logs'), { recursive: true, force: true })
  fs.rmSync(path.join(tmp, 'history-fold', 'archive'), { recursive: true, force: true })
  fs.rmSync(path.join(tmp, 'history-fold', 'index'), { recursive: true, force: true })
}

// A config that folds reliably: 20 steps = 21000 tokens, keep 9 nodes = 3 steps = 3150.
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

console.log('dsh-history-fold edge tests')

// ---------------------------------------------------------------- threshold boundaries

await test('surface exactly at the trigger: idle (the comparison is <=)', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerSurfaceTokens: 21000 })
  const { session, meter } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(lastMark().mark, 'idle')
  assert.equal(lastMark().surfaceTokens, 21000)
})

await test('surface one token above the trigger: folds', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerSurfaceTokens: 20999 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 1)
  assert.equal(lastMark().mark, 'folded')
})

// ---------------------------------------------------------------- unreachable goals

await test('unreachable target given keepRecentNodes: no-safe-cut, nothing written', async () => {
  resetLog()
  // keep 9 nodes = 3150 tokens always remain, so a target of 100 can never be met
  writeConfig({ ...BASE, targetSurfaceTokens: 100 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 0)
  assert.equal(lastMark().mark, 'no-safe-cut')
})

await test('minFoldNodes not met: no-safe-cut', async () => {
  resetLog()
  writeConfig({ ...BASE, minFoldNodes: 1000 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 0)
  assert.equal(lastMark().mark, 'no-safe-cut')
})

await test('minFoldTokens not met: no-safe-cut', async () => {
  resetLog()
  writeConfig({ ...BASE, minFoldTokens: 1000000 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 0)
  assert.equal(lastMark().mark, 'no-safe-cut')
})

await test('keepRecentNodes larger than the surface: no-safe-cut, never touches it', async () => {
  resetLog()
  writeConfig({ ...BASE, keepRecentNodes: 500 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 0)
  assert.equal(lastMark().mark, 'no-safe-cut')
})

await test('keepRecentNodes 0: folds everything except the last node', async () => {
  resetLog()
  writeConfig({ ...BASE, keepRecentNodes: 0, targetSurfaceTokens: 900 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 1, 'must fold')
  const end = appended[0].opts.surfaceOp.end
  const idx = session.surface.nodes.indexOf(end)
  assert.equal(session.surface.nodes.length - idx - 1, 0, 'nothing may be kept')
})

// ---------------------------------------------------------------- cut safety

await test('an unclosed tool call is never cut across', async () => {
  resetLog()
  // 10 balanced steps, then a dangling assistant tool-call with no matching result
  const entries = makeSteps(19)
  entries.push({ type: 'user/message', tokens: 100, data: { id: 'x', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } } })
  entries.push({ type: 'assistant/message', tokens: 50, data: { message: { id: 'y', role: 'assistant', content: [{ type: 'tool-call', id: 'dangling', name: 't', arguments: '{}' }], source: { kind: 'model' } } } })
  writeConfig({ ...BASE, keepRecentNodes: 0, targetSurfaceTokens: 900 })
  const { session, meter, appended } = buildSession(entries)
  await runHandler(session, meter)
  if (appended.length === 0) {
    assert.equal(lastMark().mark, 'no-safe-cut', 'if it declines, it must say why')
    return
  }
  // if it did fold, the cut must not leave the dangling call on the folded side
  const end = appended[0].opts.surfaceOp.end
  const idx = session.surface.nodes.indexOf(end)
  let open = 0
  for (let i = 0; i <= idx; i++) {
    const ev = session.events[session.surface.nodes[i]]
    if (ev.type === 'tool/result') open -= 1
    else if (ev.type === 'assistant/message') open += (ev.data.message.content || []).filter((b) => b.type === 'tool-call').length
  }
  assert.equal(open, 0, 'an open tool call must never cross the fold cut')
})

// ---------------------------------------------------------------- degenerate surfaces

await test('empty surface: no-op, no log line claiming work', async () => {
  resetLog()
  writeConfig(BASE)
  const { session, meter, appended } = buildSession([])
  await runHandler(session, meter)
  assert.equal(appended.length, 0)
  assert.equal(logLines().filter((l) => l.mark === 'folded').length, 0)
})

await test('single node: no-op', async () => {
  resetLog()
  writeConfig(BASE)
  const { session, meter, appended } = buildSession([{ ...STEP[0], tokens: 999999 }])
  await runHandler(session, meter)
  assert.equal(appended.length, 0)
})

await test('surface node missing from the event log: refuses to cut, fails open', async () => {
  resetLog()
  writeConfig({ ...BASE, keepRecentNodes: 0 })
  const { session, meter } = buildSession(makeSteps(20))
  session.events.splice(5, 1) // surface and log now disagree
  await runHandler(session, meter)
  const marks = logLines().map((l) => l.mark)
  assert.ok(marks.includes('no-safe-cut') || marks.includes('error'), 'must refuse rather than guess')
})

// ---------------------------------------------------------------- digest budget

await test('tiny digestMaxChars: still folds, and says it sampled', async () => {
  resetLog()
  writeConfig({ ...BASE, digestMaxChars: 200 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 1)
  const text = appended[0].data.content[0].text
  assert.ok(text.length < 4000, 'the digest must respect a tiny budget')
  assert.match(text, /sampled: every \d+th/, 'must admit it sampled rather than truncating silently')
})

// ---------------------------------------------------------------- memory feed

await test('an unreachable feed URL never blocks a fold (fail-open)', async () => {
  resetLog()
  // A closed local port refuses immediately, so no timeout is needed.
  // NOTE: the feed itself is an optional feature that only some builds ship; what this case
  // pins down is the contract that matters either way -- an unreachable endpoint, whether the
  // key is honoured or simply ignored, must never stop the fold or throw out of the hook.
  writeConfig({ ...BASE, memoryFeed: true, memoryFeedUrl: 'http://127.0.0.1:9/memory-eternal/api' })
  const { session, meter, appended } = buildSession(makeSteps(20))
  const nexted = await runHandler(session, meter)
  assert.equal(nexted, true, 'must always call next()')
  assert.equal(appended.length, 1, 'a dead endpoint must never block a fold')
})

await test('an unreachable feed URL is reported in the log when the feature is present', async () => {
  resetLog()
  writeConfig({ ...BASE, memoryFeed: true, memoryFeedUrl: 'http://127.0.0.1:9/memory-eternal/api' })
  const { session, meter } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  const marks = logLines().map((l) => l.mark)
  const hasFeed = marks.includes('fed') || marks.includes('feed-error')
  // If a build has no feed at all, neither mark appears and that is fine -- but a build that
  // does have one must not fail silently.
  if (!hasFeed) {
    assert.equal(pluginSupportsFeed(), false, 'a build with a feed must log fed/feed-error instead of swallowing it')
  }
})

// Does THIS build know about the optional memory feed at all?
function pluginSupportsFeed() {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  return src.includes('memoryFeed')
}

// ---------------------------------------------------------------- hostile config

await test('unknown config keys are ignored, not fatal', async () => {
  resetLog()
  writeConfig({ ...BASE, thisKeyDoesNotExist: true, nested: { a: 1 } })
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 1)
})

await test('wrong-typed config values do not crash the hook', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerSurfaceTokens: 'lots', keepRecentNodes: 'many', digestMaxChars: null })
  const { session, meter } = buildSession(makeSteps(20))
  const nexted = await runHandler(session, meter)
  assert.equal(nexted, true, 'must always call next()')
})

await test('corrupt config.json: falls back to the inert defaults', async () => {
  resetLog()
  fs.writeFileSync(path.join(tmp, 'dsh-history-fold', 'config.json'), '{ this is not json')
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 0, 'a corrupt config must not fold anything')
})

await test('enabled:false with dryRun:false is still completely inert', async () => {
  resetLog()
  writeConfig({ ...BASE, enabled: false, dryRun: false })
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 0)
  assert.equal(logLines().length, 0)
})

// ---------------------------------------------------------------- repeated folding

await test('two folds in one session: the second one folds the previous marker', async () => {
  resetLog()
  // keep 6 nodes = 2 steps, so after the first fold the surface is [marker, ...6 nodes].
  // minFoldNodes is 1 on purpose: the marker alone can already reach the target, and folding a
  // single node is legal here. With the shipped default (20) the plugin would -- correctly --
  // log no-safe-cut instead, because taking one node is below its worth-folding floor.
  writeConfig({ ...BASE, keepRecentNodes: 6, targetSurfaceTokens: 3000, minFoldNodes: 1 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 1)
  assert.equal(lastMark().mark, 'folded')

  // Simulate what dsh-session does: splice the replacement into the folded range.
  const { start, end } = appended[0].opts.surfaceOp
  const si = session.surface.nodes.indexOf(start)
  const ei = session.surface.nodes.indexOf(end)
  const markerSeq = 9000
  meter.setTokens(markerSeq, 20000) // the marker carries the digest, so it is sizeable
  // The marker must exist in the event log too: balancedCuts refuses to cut at a node it
  // cannot look up, which is exactly the guard we want.
  session.events.push({
    seq: markerSeq,
    type: 'user/message',
    data: { id: 'marker', role: 'user', content: [{ type: 'text', text: 'folded' }], source: { kind: 'plugin', plugin: 'dsh-history-fold' } },
  })
  session.surface.nodes.splice(si, ei - si + 1, markerSeq)

  await runHandler(session, meter)
  assert.equal(appended.length, 2, 'a second fold must be possible')
  assert.equal(lastMark().mark, 'folded')
  const second = appended[1].opts
  assert.ok(second.sourceEventSeqs.includes(markerSeq), 'the second fold must shadow the first marker')
})

// ---------------------------------------------------------------- tiered index (2026-10-15)

// The in-context index is SAMPLED once it overflows digestMaxChars, and the sampling step is
// capped -- so without a tier file the oldest spans decay into "somewhere in seqs A..B".
// The tier file is the unsampled index, on disk, named by the in-context message.
function tierPath(start, end) {
  return path.join(tmp, 'history-fold', 'index', 'session-test-0001', 'f' + start + '-' + end + '.md')
}

// Put a folded message back into the surface the way dsh-session does after a fold.
function spliceMarker(session, meter, opts, text, markerSeq) {
  const si = session.surface.nodes.indexOf(opts.start)
  const ei = session.surface.nodes.indexOf(opts.end)
  meter.setTokens(markerSeq, 20000)
  session.events.push({
    seq: markerSeq,
    type: 'user/message',
    data: { id: 'marker', role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-history-fold' } },
  })
  session.surface.nodes.splice(si, ei - si + 1, markerSeq)
}

await test('tier index: a fold writes the unsampled index to disk and names it in context', async () => {
  resetLog()
  writeConfig({ ...BASE, keepRecentNodes: 6, targetSurfaceTokens: 3000, minFoldNodes: 1 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 1, 'must fold')
  const { start, end } = appended[0].opts.surfaceOp
  const tier = tierPath(start, end)
  assert.ok(fs.existsSync(tier), 'the tier file must exist: ' + tier)
  const body = fs.readFileSync(tier, 'utf8')
  assert.ok(body.includes('## message index'), 'the tier file must carry the full index')
  assert.ok(body.includes('seqs ' + start + '..' + end), 'the tier file must name its range')
  assert.ok(body.includes(archivePath()), 'the tier file must point back at the raw text')

  const text = appended[0].data.content[0].text
  assert.ok(text.includes(tier), 'the folded message must name the tier file')
  const m = /\[fold-index\] seqs=(\d+)\.\.(\d+) messages=(\d+) file=(.+)/.exec(text)
  assert.ok(m, 'the folded message must carry a parseable marker')
  assert.equal(Number(m[1]), start)
  assert.equal(Number(m[2]), end)
  assert.equal(m[4].trim(), tier)
})

await test('tier index: the next fold turns an older marker into a pointer and nests the tiers', async () => {
  resetLog()
  writeConfig({ ...BASE, keepRecentNodes: 6, targetSurfaceTokens: 3000, minFoldNodes: 1 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 1)
  const first = appended[0].opts.surfaceOp
  const firstText = appended[0].data.content[0].text
  const firstTier = tierPath(first.start, first.end)

  spliceMarker(session, meter, first, firstText, 9100)
  await runHandler(session, meter)
  assert.equal(appended.length, 2, 'a second fold must be possible')

  const secondText = appended[1].data.content[0].text
  assert.ok(
    /\[0\] fold-pointer seq=9100:/.test(secondText),
    'the old marker must become a pointer line, not a truncated prefix'
  )
  assert.ok(secondText.includes(firstTier), 'the pointer line must name the older tier file')

  const second = appended[1].opts.surfaceOp
  const body = fs.readFileSync(tierPath(second.start, second.end), 'utf8')
  assert.ok(body.includes('## older tier files'), 'the new tier file must nest the older one')
  assert.ok(body.includes(firstTier), 'the nesting must name the older tier file')
})

await test('tier index: fold-pointer lines survive digest sampling', async () => {
  resetLog()
  writeConfig({ ...BASE, keepRecentNodes: 6, targetSurfaceTokens: 3000, minFoldNodes: 1, digestMaxChars: 500 })
  const { session, meter, appended } = buildSession(makeSteps(60))
  const markerSeq = 9200
  meter.setTokens(markerSeq, 20000)
  const oldTier = tierPath(1, 9)
  session.events.push({
    seq: markerSeq,
    type: 'user/message',
    data: {
      id: 'marker',
      role: 'user',
      content: [{ type: 'text', text: '[dsh-history-fold] an older fold\n[fold-index] seqs=1..9 messages=10 file=' + oldTier }],
      source: { kind: 'plugin', plugin: 'dsh-history-fold' },
    },
  })
  session.surface.nodes.unshift(markerSeq)

  await runHandler(session, meter)
  assert.equal(appended.length, 1, 'must fold')
  const text = appended[0].data.content[0].text
  assert.ok(text.includes('sampled: every'), 'the digest must really have been sampled')
  assert.ok(text.includes('fold-pointer seq=9200'), 'a fold-pointer must never be sampled away')
  assert.ok(text.includes(oldTier), 'the surviving pointer must name the older tier file')

  const { start, end } = appended[0].opts.surfaceOp
  const body = fs.readFileSync(tierPath(start, end), 'utf8')
  assert.ok(body.includes('## older tier files'), 'the tier file must nest the older fold')
  assert.ok(body.includes(oldTier), 'the nesting must name the older tier file')
})

// ---------------------------------------------------------------- hostile contexts

// The proven failure this guards against: a third-party plugin (cancanqiqi/dsh-human-subagent)
// called a service method that does not exist on the loaded build, the exception propagated
// out of apply() into the loader, and the WHOLE profile refused to start. Being merely
// incompatible must instead cost this plugin its own activation -- nothing more.
await test('apply() returns normally when the context is hostile, and records the deactivation', async () => {
  resetLog()
  writeConfig({ ...BASE, enabled: true })

  // Each hostile context is a shape a DSH build could really present: a missing service (a
  // renamed or dropped one) or one that refuses the call. `step` is asserted too: the log has
  // to name the service that failed, or the user cannot tell an incompatible build from a bug.
  const probes = []
  const hostile = [
    { label: 'ctx.on throws', step: 'agent/pre-step', ctx: { on() { throw new Error('boom-on') }, effect() {} } },
    { label: 'ctx.on absent', step: 'services', ctx: { effect() {} } },
    {
      label: 'ctx.effect throws',
      step: 'ctx.effect',
      ctx: {
        on(event, fn) { assert.equal(event, 'agent/pre-step'); assert.equal(typeof fn, 'function'); return () => probes.push('disposed') },
        effect() { throw new Error('boom-effect') },
      },
    },
    { label: 'ctx.effect absent', step: 'services', ctx: { on() { return () => {} } } },
    { label: 'ctx is null', step: 'services', ctx: null },
  ]

  let seen = 0
  for (const h of hostile) {
    let threw = null
    try {
      plugin.apply(h.ctx)
    } catch (err) {
      threw = err
    }
    assert.equal(threw, null, 'apply() must NOT throw with a hostile ctx: ' + h.label)
    const lines = logLines().filter((l) => l.mark === 'deactivated')
    assert.equal(lines.length, seen + 1, 'each hostile ctx must leave exactly ONE deactivation line: ' + h.label)
    assert.equal(lines[lines.length - 1].reason, 'registration-failed', h.label)
    assert.equal(lines[lines.length - 1].step, h.step, 'the log must name the step that failed: ' + h.label)
    seen = lines.length
  }

  // Deactivating means "not activated", not "half activated": the listener that ctx.effect
  // could not take charge of must have been handed back.
  assert.deepEqual(probes, ['disposed'], 'a listener registered before a later step failed must be disposed')

  // And with everything present the very same apply() still wires the hook up normally: the
  // guard is a failure path, not a new condition on the happy path.
  resetLog()
  const { session, meter, appended } = buildSession(makeSteps(20))
  await runHandler(session, meter)
  assert.equal(appended.length, 1, 'the happy path must still fold')
  assert.equal(lastMark().mark, 'folded')
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
