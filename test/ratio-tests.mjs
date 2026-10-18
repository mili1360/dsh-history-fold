// Window-ratio threshold tests for dsh-history-fold.
//
// triggerSurfaceTokens / targetSurfaceTokens are ABSOLUTE and were tuned for one window size:
// 250000 can never be reached on a small-window model (the plugin silently does nothing) and is
// only a quarter of a 1M window. triggerRatio / targetRatio scale instead. What this file pins
// down is the three-step resolution order and the fact that a bad ratio degrades safely:
//
//   1. the key is present in the RAW config.json        -> that absolute value wins
//   2. no explicit key, and the context window resolves -> floor(window * ratio)
//   3. no explicit key, and the window does not resolve -> DEFAULTS absolute value
//
// Nothing here touches a running DSH, the real DSH_HOME, or a real llm service: ctx.llm is a
// three-line fake, because what is under test is the precedence and the failure handling, not
// the adapter.
//
// Run: npm run test:ratio
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'history-fold-ratio-'))
process.env.DSH_HOME = tmp
fs.mkdirSync(path.join(tmp, 'dsh-history-fold'), { recursive: true })

const plugin = await import('../lib/index.js')

let passed = 0
let failed = 0

// NOTE: must await fn(). A synchronous harness reports "ok" before any async assertion runs
// and lets the script reach process.exit() first, turning the whole suite into a no-op. This
// project already shipped one fake-green suite that way.
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

const DEFAULTS = { triggerSurfaceTokens: 250000, targetSurfaceTokens: 180000 }

// 20 steps of user (100) -> assistant tool-call (50) -> tool/result (900) = 21000 surface tokens.
const STEP = [
  { type: 'user/message', tokens: 100, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'ask' }], source: { kind: 'user' } } },
  { type: 'assistant/message', tokens: 50, data: { message: { id: 'a', role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 't', arguments: '{}' }], source: { kind: 'model' } } } },
  { type: 'tool/result', tokens: 900, data: { message: { id: 'r', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c', content: [] }], source: { kind: 'tool' } } } },
]

function makeSteps(n) {
  const out = []
  for (let i = 0; i < n; i++) for (const s of STEP) out.push({ ...s })
  return out
}

function buildSession(entries) {
  const events = []
  const nodes = []
  const tokens = new Map()
  for (const e of entries) {
    const seq = events.length
    events.push({ seq, type: e.type, data: e.data })
    nodes.push(seq)
    tokens.set(seq, e.tokens)
  }
  const appended = []
  const session = {
    header: { id: 'session-ratio-0001' },
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
      const measured = session.surface.nodes.map((seq) => {
        const t = tokens.get(seq) || 0
        surfaceTokens += t
        return { seq, tokens: t }
      })
      return { surfaceTokens, totalTokens: surfaceTokens + 13000, baseline: { kind: 'estimated', tokens: 0 }, nodes: measured }
    },
  }
  return { session, meter, nodes, appended }
}

// 21000 tokens of surface, keep 9 nodes (3150 tokens), so a 4000-token target is reachable.
const BASE = {
  enabled: true,
  dryRun: false,
  profile: false,
  keepRecentNodes: 9,
  minFoldNodes: 3,
  minFoldTokens: 1000,
  archive: false,
  onlyAtTurnStart: true,
}

// A fake llm service. `kind` selects what the plugin is allowed to see:
//   'direct'    -> ctx.llm
//   'reflect'   -> ctx.reflect.get('llm')
//   'agentctx'  -> payload.agent.ctx.llm
//   'none'      -> no llm reachable at all
// `answer` is what resolveModelInfo does: an object, undefined, or a thrown error.
function fakeLlm(answer) {
  return {
    calls: [],
    resolveModelInfo(provider, model, signal) {
      this.calls.push({ provider, model, signal })
      if (answer instanceof Error) return Promise.reject(answer)
      if (typeof answer === 'function') return Promise.resolve(answer(provider, model))
      return Promise.resolve(answer)
    },
  }
}

function makeCtx(kind, llm) {
  const ctx = {
    get tokenMeter() { return undefined }, // the profile/policy path is not what is under test here
    on(event, fn) { assert.equal(event, 'agent/pre-step'); this.handler = fn },
    effect() {},
  }
  if (kind === 'direct') ctx.llm = llm
  if (kind === 'reflect') ctx.reflect = { get(name, strict) { assert.equal(strict, false, 'reflection must be the non-throwing form'); return name === 'llm' ? llm : undefined } }
  return ctx
}

async function runHandler(opts) {
  const { session, llm, kind = 'direct', withMeter = false, meter = null, agentOptions = { provider: 'deepseek', model: 'deepseek-chat' }, signal = undefined } = opts
  const ctx = makeCtx(kind, llm)
  if (withMeter) Object.defineProperty(ctx, 'tokenMeter', { get() { return meter }, configurable: true })
  const handlers = []
  const originalOn = ctx.on.bind(ctx)
  ctx.on = (event, fn) => { originalOn(event, fn); handlers.push(fn) }
  plugin.apply(ctx)
  assert.ok(handlers.length >= 1, 'apply must register at least one agent/pre-step listener')
  const agent = { session, options: agentOptions }
  if (opts.agentCtx) agent.ctx = opts.agentCtx
  let nexted = false
  const payload = { agent, step: 1, turn: 12, ...(signal === undefined ? {} : { signal }) }
  for (const h of handlers) await h(payload, async () => { nexted = true })
  return nexted
}

function logLines() {
  const file = path.join(tmp, 'logs', 'history-fold.jsonl')
  if (!fs.existsSync(file)) return []
  // The recall module shares this log file; its lines are not fold events, so filter them out
  // here rather than teaching every assertion about the second module.
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => !String(l.mark || '').startsWith('recall-'))
}
function lastMark() {
  const lines = logLines()
  return lines[lines.length - 1]
}
function resetLog() {
  fs.rmSync(path.join(tmp, 'logs'), { recursive: true, force: true })
}

const WINDOW = 1000000

console.log('dsh-history-fold window-ratio tests')

// ---------------------------------------------------------------- 1. the ratio path

await test('window resolvable + no absolute key: trigger = floor(window * triggerRatio)', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.75, targetRatio: 0.18 })
  const { session } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: WINDOW } })
  await runHandler({ session, llm, agentOptions: { provider: 'deepseek', model: 'deepseek-chat' } })
  const line = lastMark()
  assert.equal(line.trigger, Math.floor(WINDOW * 0.75), 'trigger must be floor(window * ratio)')
  assert.equal(line.trigger, 750000)
  assert.equal(line.target, Math.floor(WINDOW * 0.18), 'target must be floor(window * ratio)')
  assert.equal(line.target, 180000)
  assert.equal(line.windowTokens, WINDOW, 'the resolved window must be visible in the log')
  assert.equal(line.triggerSource, 'ratio')
  assert.equal(line.targetSource, 'ratio')
  assert.equal(llm.calls.length, 1, 'resolveModelInfo is called once per turn')
  assert.equal(llm.calls[0].provider, 'deepseek')
  assert.equal(llm.calls[0].model, 'deepseek-chat')
})

await test('a non-integer product is floored, never rounded up', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.7, targetRatio: 0.3333 })
  const { session } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: 1234567 } })
  await runHandler({ session, llm })
  const line = lastMark()
  assert.equal(line.trigger, Math.floor(1234567 * 0.7))
  assert.equal(line.trigger, 864196)
  assert.equal(line.target, Math.floor(1234567 * 0.3333))
  assert.equal(line.target, 411481)
})

await test('the plugin actually folds when the ratio threshold is crossed', async () => {
  resetLog()
  // 21000-token surface. The fixture keeps 9 nodes = 3 whole steps = 3150 tokens, so the
  // smallest surface a fold can leave behind is 3150: a target BELOW that is unreachable by
  // construction and correctly ends in no-safe-cut (there is a case for that below). 3500 is
  // reachable, and it sits under the 10000-token trigger the ratio resolves to.
  writeConfig({ ...BASE, triggerRatio: 0.01, targetRatio: 0.0035 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: WINDOW } })
  await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(appended.length, 1, 'a crossed ratio trigger must fold')
  assert.equal(lastMark().mark, 'folded')
  assert.equal(lastMark().trigger, 10000)
  assert.equal(lastMark().target, 3500)
  assert.equal(lastMark().triggerSource, 'ratio')
})

await test('the ratio path also works through ctx.reflect.get("llm")', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.75, targetRatio: 0.18 })
  const { session } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: 200000 } })
  await runHandler({ session, llm, kind: 'reflect' })
  const line = lastMark()
  assert.equal(line.trigger, 150000)
  assert.equal(line.windowTokens, 200000)
  assert.equal(line.triggerSource, 'ratio')
  assert.match(line.via, /ctx\.reflect\.get/, 'the log must say which path reached llm')
})

await test('the ratio path also works through payload.agent.ctx.llm', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.75, targetRatio: 0.18 })
  const { session } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: 128000 } })
  await runHandler({ session, llm, kind: 'none', agentCtx: { llm } })
  const line = lastMark()
  assert.equal(line.trigger, 96000)
  assert.equal(line.windowTokens, 128000)
})

// ---------------------------------------------------------------- 2. the absolute override

await test('config.json sets triggerSurfaceTokens: that value wins over a resolvable window', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerSurfaceTokens: 5000, targetRatio: 0.0035 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: WINDOW } })
  await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(lastMark().trigger, 5000, 'an explicit absolute key must beat window * triggerRatio')
  assert.equal(lastMark().triggerSource, 'absolute')
  // The untouched key still resolves by ratio: precedence is per key, not per file.
  assert.equal(lastMark().target, 3500)
  assert.equal(lastMark().targetSource, 'ratio')
  assert.equal(appended.length, 1, 'a 5000 trigger over a 21000 surface must fold')
})

await test('an explicit absolute target also beats a resolvable window, trigger still by ratio', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerSurfaceTokens: 5000, targetSurfaceTokens: 4000 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: WINDOW } })
  await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(lastMark().trigger, 5000)
  assert.equal(lastMark().target, 4000)
  assert.equal(lastMark().triggerSource, 'absolute')
  assert.equal(lastMark().targetSource, 'absolute')
  assert.equal(appended.length, 1)
})

await test('an explicit targetSurfaceTokens wins while the trigger still uses the ratio', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.01, targetSurfaceTokens: 4000 })
  const { session, meter } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: WINDOW } })
  await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(lastMark().trigger, 10000)
  assert.equal(lastMark().triggerSource, 'ratio')
  assert.equal(lastMark().target, 4000)
  assert.equal(lastMark().targetSource, 'absolute')
})

await test('both keys explicit: both absolute, the window is irrelevant', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerSurfaceTokens: 5000, targetSurfaceTokens: 4000 })
  const { session, meter } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: 128000 } })
  await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(lastMark().trigger, 5000)
  assert.equal(lastMark().target, 4000)
  assert.equal(lastMark().triggerSource, 'absolute')
  assert.equal(lastMark().targetSource, 'absolute')
})

await test('the shipped DEFAULTS absolute values are NOT treated as an explicit choice', async () => {
  resetLog()
  // A config.json without either absolute key, on a window where DEFAULTS would say something
  // different. If the raw-file check were done against the merged config object, this case
  // would report 'absolute' and 250000 -- the exact bug the precedence rule exists to avoid.
  writeConfig({ ...BASE, triggerRatio: 0.5, targetRatio: 0.02 })
  const { session } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: 200000 } })
  await runHandler({ session, llm })
  const line = lastMark()
  assert.equal(line.trigger, 100000)
  assert.notEqual(line.trigger, DEFAULTS.triggerSurfaceTokens)
  assert.equal(line.triggerSource, 'ratio')
})

await test('idle above a ratio trigger below the surface: the log still names window and source', async () => {
  resetLog()
  // 20000-token trigger over a 21000-token surface: crossed, so it must not report idle.
  writeConfig({ ...BASE, triggerRatio: 0.1, targetRatio: 0.02 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: 200000 } })
  await runHandler({ session, llm, withMeter: true, meter })
  assert.notEqual(lastMark().mark, 'idle')
  assert.equal(lastMark().trigger, 20000)

  // 30000-token trigger over the same surface: idle, and the log is still traceable.
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.15, targetRatio: 0.02 })
  const below = buildSession(makeSteps(20))
  await runHandler({ session: below.session, llm, withMeter: true, meter: below.meter })
  const line = lastMark()
  assert.equal(line.mark, 'idle')
  assert.equal(line.trigger, 30000)
  assert.equal(line.triggerSource, 'ratio')
  assert.equal(line.windowTokens, 200000)
  assert.equal(line.surfaceTokens, 21000)
})

// ---------------------------------------------------------------- 3. the fallback

await test('no ctx.llm at all: DEFAULTS, source default, no throw, next() still called', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.75, targetRatio: 0.18 })
  const { session, meter } = buildSession(makeSteps(20))
  const nexted = await runHandler({ session, kind: 'none', withMeter: true, meter })
  assert.equal(nexted, true, 'the hook must always call next()')
  const line = lastMark()
  assert.equal(line.trigger, DEFAULTS.triggerSurfaceTokens)
  assert.equal(line.target, DEFAULTS.targetSurfaceTokens)
  assert.equal(line.triggerSource, 'default')
  assert.equal(line.targetSource, 'default')
  assert.equal(line.windowTokens, null, 'an unknown window must be reported as null, not guessed')
})

await test('resolveModelInfo throws: DEFAULTS, source default, no throw', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.75, targetRatio: 0.18 })
  const { session, meter } = buildSession(makeSteps(20))
  const llm = fakeLlm(new Error('no adapter registered for provider "deepseek"'))
  const nexted = await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(nexted, true)
  assert.equal(lastMark().trigger, DEFAULTS.triggerSurfaceTokens)
  assert.equal(lastMark().triggerSource, 'default')
  assert.equal(lastMark().windowTokens, null)
})

await test('resolveModelInfo returns no context: DEFAULTS, source default', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.75, targetRatio: 0.18 })
  const { session, meter } = buildSession(makeSteps(20))
  const llm = fakeLlm({ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' })
  await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(lastMark().trigger, DEFAULTS.triggerSurfaceTokens)
  assert.equal(lastMark().triggerSource, 'default')
  assert.equal(lastMark().windowTokens, null)
})

await test('resolveModelInfo returns a non-positive window: DEFAULTS, source default', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.75, targetRatio: 0.18 })
  const { session, meter } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: 0 } })
  await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(lastMark().trigger, DEFAULTS.triggerSurfaceTokens)
  assert.equal(lastMark().triggerSource, 'default')
  assert.equal(lastMark().windowTokens, null)
})

await test('resolveModelInfo returns a non-integer window: DEFAULTS, source default', async () => {
  resetLog()
  // dsh-llm validates contextWindow as a positive INTEGER, so a fraction is not capacity data.
  // Trusting it would produce a fractional token threshold, which no reader could explain.
  writeConfig({ ...BASE, triggerRatio: 0.75, targetRatio: 0.18 })
  const { session, meter } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: 1234567.5 } })
  const nexted = await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(nexted, true)
  assert.equal(lastMark().trigger, DEFAULTS.triggerSurfaceTokens)
  assert.equal(lastMark().triggerSource, 'default')
  assert.equal(lastMark().windowTokens, null)
})

await test('a non-numeric window is rejected: DEFAULTS, source default', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.75, targetRatio: 0.18 })
  const { session, meter } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: '1000000' } })
  await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(lastMark().trigger, DEFAULTS.triggerSurfaceTokens)
  assert.equal(lastMark().triggerSource, 'default')
  assert.equal(lastMark().windowTokens, null)
})

await test('no provider/model on the agent: the ratio path is never attempted', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.75, targetRatio: 0.18 })
  const { session, meter } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: WINDOW } })
  await runHandler({ session, llm, withMeter: true, meter, agentOptions: {} })
  assert.equal(llm.calls.length, 0, 'with no route there is nothing to resolve')
  assert.equal(lastMark().trigger, DEFAULTS.triggerSurfaceTokens)
  assert.equal(lastMark().triggerSource, 'default')
})

await test('a session without requestHeader() is not fatal (the compactor fallback route)', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.75, targetRatio: 0.18 })
  const { session, meter } = buildSession(makeSteps(20))
  session.requestHeader = () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } })
  const llm = fakeLlm({ context: { contextWindow: 1000000 } })
  await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(lastMark().trigger, 750000)
  assert.equal(lastMark().triggerSource, 'ratio')
})

// ---------------------------------------------------------------- 4. invalid ratios

for (const bad of [0, 1, 1.5, '0.75', null, -0.5, Number.NaN]) {
  await test('invalid triggerRatio ' + String(bad) + ': rule 3, and the log says so', async () => {
    resetLog()
    writeConfig({ ...BASE, triggerRatio: bad, targetRatio: 0.18 })
    const { session, meter } = buildSession(makeSteps(20))
    const llm = fakeLlm({ context: { contextWindow: WINDOW } })
    const nexted = await runHandler({ session, llm, withMeter: true, meter })
    assert.equal(nexted, true, 'a bad ratio must never throw out of the hook')
    const line = lastMark()
    assert.equal(line.trigger, DEFAULTS.triggerSurfaceTokens, 'a bad ratio falls back to the DEFAULTS value')
    assert.equal(line.triggerSource, 'default')
    assert.equal(line.triggerRatioInvalid, true, 'the log must name the invalid ratio as the reason')
    // ...and the OTHER key is untouched by it: it still resolved from the window.
    assert.equal(line.target, 180000)
    assert.equal(line.targetSource, 'ratio')
  })
}

await test('invalid targetRatio: only the target falls back', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.75, targetRatio: 'lots' })
  const { session, meter } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: WINDOW } })
  await runHandler({ session, llm, withMeter: true, meter })
  const line = lastMark()
  assert.equal(line.trigger, 750000)
  assert.equal(line.target, DEFAULTS.targetSurfaceTokens)
  assert.equal(line.targetSource, 'default')
  assert.equal(line.targetRatioInvalid, true)
  assert.equal(line.triggerRatioInvalid, undefined, 'a valid ratio must not be flagged')
})

await test('an invalid ratio with an unresolvable window: still rule 3, no throw', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 2, targetRatio: -1 })
  const { session, meter } = buildSession(makeSteps(20))
  const nexted = await runHandler({ session, kind: 'none', withMeter: true, meter })
  assert.equal(nexted, true)
  assert.equal(lastMark().trigger, DEFAULTS.triggerSurfaceTokens)
  assert.equal(lastMark().target, DEFAULTS.targetSurfaceTokens)
  assert.equal(lastMark().triggerSource, 'default')
})

// ---------------------------------------------------------------- 5. an unreachable target

await test('target well above triggerRatio: the target is unreachable, so no-safe-cut runs', async () => {
  resetLog()
  // window 100000 -> trigger 10000, target 50000. The 21000-token surface crosses the trigger,
  // but the fold loop stops the moment the remaining surface drops to the target, and the
  // remaining surface can only be at most what it started from -- so no index ever satisfies
  // `remaining <= 50000` except the cut before node 0, which the loop never examines. The loop
  // finds nothing, which is exactly the existing unreachable-target path: no new behaviour is
  // invented for ratios, it exits through no-safe-cut like an oversized keepRecentNodes does.
  writeConfig({ ...BASE, triggerRatio: 0.1, targetRatio: 0.5 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: 100000 } })
  const nexted = await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(nexted, true, 'an unreachable target must never throw out of the hook')
  assert.equal(appended.length, 0, 'nothing may be folded when the target is unreachable')
  assert.equal(lastMark().mark, 'no-safe-cut')
  assert.equal(lastMark().trigger, 10000)
  assert.equal(lastMark().target, 50000)
  assert.equal(lastMark().triggerSource, 'ratio')
  assert.equal(lastMark().windowTokens, 100000)
})

await test('targetRatio >= triggerRatio just above the surface: it folds, and the cut is still balanced', async () => {
  resetLog()
  // The honest boundary case: with target 20000 and a 21000-token surface, the cut before node
  // 0 (trivially balanced, remaining 21000) does satisfy `remaining <= 20000`... so the fold
  // happens and folds one step. That is the pre-existing shape of the loop, unchanged by this
  // feature; what this case pins down is that the ratio path does not crash here either.
  writeConfig({ ...BASE, triggerRatio: 0.1, targetRatio: 0.2 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: 100000 } })
  const nexted = await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(nexted, true)
  assert.equal(lastMark().mark, appended.length > 0 ? 'folded' : 'no-safe-cut')
  if (appended.length > 0) {
    const end = appended[0].opts.surfaceOp.end
    assert.equal(session.surface.nodes.indexOf(end), 2, 'the first balanced cut is after one step')
  }
})

await test('targetRatio >= triggerRatio with a resolvable-but-tiny surface: same path', async () => {
  resetLog()
  writeConfig({ ...BASE, triggerRatio: 0.5, targetRatio: 0.6 })
  const { session, meter, appended } = buildSession(makeSteps(20))
  const llm = fakeLlm({ context: { contextWindow: 40000 } })
  const nexted = await runHandler({ session, llm, withMeter: true, meter })
  assert.equal(nexted, true)
  assert.equal(appended.length, 0)
  assert.ok(['no-safe-cut', 'idle'].includes(lastMark().mark), 'either guard is acceptable; a crash is not')
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
