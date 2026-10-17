// dsh-history-fold -- fold old surface nodes into ONE message, losslessly recoverable later.
//
// WHY
//   A very long session sends its whole message history on every request. Measured on this
//   machine (one real long session vs a fresh one):
//     history tokens 497141, output/input ratio 0.20%, decode 59 tok/s
//     fresh session ratio 0.64%, decode 176 tok/s
//   So context size does NOT slow the first token (TTFT stayed ~2.5s in both), but it does
//   slow decode, because attention runs over the whole KV. Folding old nodes fixes that.
//
// HOW (exactly what dsh-compaction-basic does, lib/index.js:605-616)
//   session.append("user/message", message, {
//     surfaceOp: { op: "replace", start, end },
//     sourceEventSeqs: [...every shadowed seq...]
//   })
//   dsh-session then runs state.nodes.splice(startIdx, count, newSeq)  (lib/index.js:427),
//   so the replacement takes the OLD range's position and chronology is preserved.
//
// RULES THIS FILE FOLLOWS (all verified against the real sources, not guessed)
//   - surface.nodes is an array of plain seq numbers, NOT objects. (dsh-session:340-349)
//   - surfaceOp must have exactly the 3 keys op/start/end, both seqs non-negative integers.
//     (dsh-session:300-303)
//   - sourceEventSeqs must list EVERY shadowed surface node, must be non-empty, and every
//     entry must be strictly smaller than the new event's seq. (dsh-session:320-337)
//   - A user/message event's data IS the message and needs id/role/source.kind/content.
//     (dsh-session:278-280, 1246-1258)
//   - A cut is safe only when no unanswered tool call crosses it. Reimplemented from
//     @deepseek-ai/dsh-compaction/lib/types/tool-pairing.js so this plugin needs no
//     dependency on the DSH install path.
//
// SAFETY
//   dryRun: false  -> the shipped default: the fold really happens. It is still bounded --
//                     it can only fire above triggerRatio (0.75 of the model's window),
//                     which sits just below the built-in compactor's 0.8, so it acts only
//                     in the last quarter of a window; every folded node is archived
//                     verbatim before the fold; and a failed archive write aborts the fold.
//   dryRun: true   -> observe and log only; never writes anything. Use this to watch the
//                     numbers before trusting the fold on your own sessions.
//   enabled: false -> the plugin is loaded but completely idle.
//
// ASCII ONLY on purpose -- this box runs a GBK code page.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const name = 'dsh-history-fold'
const inject = []

const DEFAULTS = {
  // On by default: a plugin whose whole purpose is to keep the request small must not
  // install itself inert. The fold is bounded by the trigger ratio below, it archives
  // every node before removing it, and a failed archive write aborts the fold.
  // Set enabled: false to keep the plugin loaded but completely idle.
  enabled: true,
  // Set true to observe and log only. False is the shipped default: fold for real.
  dryRun: false,
  // Write one size/profile line per turn.
  profile: true,
  // Fold only while the visible history is above this many tokens.
  // dsh-compaction-basic compacts at 0.8 * contextWindow (800k here) and retains 0.16
  // (160k). Staying below that line is what stops the lossy summarizer from ever firing.
  //
  // These two absolute values are the FALLBACK, used only when the model's context window
  // cannot be resolved. When it can be resolved, the ratios below take precedence (an
  // explicit key in config.json still beats both). See resolveThresholds().
  triggerSurfaceTokens: 250000,
  // Fold down to about this many tokens of visible history.
  targetSurfaceTokens: 180000,
  // The same two thresholds as fractions of the model's context window. A ratio is what
  // scales: 250000 is unreachable on a 128k-window model (the plugin silently does nothing)
  // and only 25% of a 1M window (the lossy summarizer gets there first).
  //   0.75 == 750k of a 1M window: dsh-compaction-basic compacts at
  //           thresholdRatio * contextWindow (DEFAULT_THRESHOLD_RATIO .8 == 800k) and its
  //           replacement is a model-written summary that loses detail. Folding just below
  //           that line is what stops that summarizer from ever firing.
  //   0.18 == 180k: mirrors the compactor's DEFAULT_RETAIN_RATIO of .16.
  // Resolution order: explicit key in config.json > window * ratio > DEFAULTS above.
  triggerRatio: 0.75,
  targetRatio: 0.18,
  // Never fold the most recent this-many nodes.
  keepRecentNodes: 60,
  // Never fold fewer than this many nodes, or fewer than this many tokens.
  minFoldNodes: 20,
  minFoldTokens: 20000,
  // Keep the full text of everything folded, so nothing is ever lost.
  archive: true,
  archiveDir: 'history-fold/archive',
  // Caps on the extractive digest that replaces the folded range.
  digestMaxChars: 30000,
  digestLineChars: 160,
  // Tiered index (2026-10-15). The in-context digest is SAMPLED once it overflows
  // digestMaxChars, and the sampling step is capped at 64 -- so the oldest spans degrade
  // into "somewhere in seqs A..B there is something". The tier index pushes the UNSAMPLED
  // index of every fold onto disk and leaves only its path in context, and a fold that
  // covers an earlier fold message points at that earlier tier file instead of collapsing
  // it to digestLineChars. That is the recursive part: context -> tier file -> older tier
  // file -> raw archive. Reading one costs nothing until it is actually read.
  indexTree: true,
  indexDir: 'history-fold/index',
  indexFull: true,
  // Only fold before a turn's first step, never in the middle of one.
  onlyAtTurnStart: true,
  logFile: 'logs/history-fold.jsonl',
}

// keepRecent values whose saving is reported in the profile line
const PROFILE_KEEPS = [20, 40, 80, 160]

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function configPath() {
  return path.join(dshHome(), 'dsh-history-fold', 'config.json')
}

// Read config.json and keep TWO things: the merged config (as before), and the set of keys
// that the RAW file contained. The second one is what makes the absolute-over-ratio
// precedence possible: DEFAULTS also carries triggerSurfaceTokens / targetSurfaceTokens, so
// asking the merged object "is this key set?" would always answer yes and the ratios could
// never apply. A missing, unparseable, or non-object file yields no raw keys, so nothing is
// explicit and the window/ratio path is free to apply.
function readConfigFile() {
  let raw
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: { ...DEFAULTS }, rawKeys: new Set() }
    }
    raw = parsed
  } catch {
    return { config: { ...DEFAULTS }, rawKeys: new Set() }
  }
  return { config: { ...DEFAULTS, ...raw }, rawKeys: new Set(Object.keys(raw)) }
}

function readConfig() {
  return readConfigFile().config
}

// A ratio is usable only if it is a real number strictly inside (0, 1). Anything else
// (0, 1, 1.5, "0.75", null, NaN, missing) is reported as not usable so the caller falls back
// to the shipped absolute default -- silently turning a bad ratio into a broken threshold
// would leave the plugin doing nothing at all, with no explanation in the log.
function usableRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1 ? value : undefined
}

// Resolve ONE threshold, in the required precedence order:
//   1. the key is present in the raw config.json          -> that absolute value wins
//   2. no explicit key, and the context window is known   -> floor(window * ratio)
//   3. no explicit key, and the window is unknown/invalid -> the DEFAULTS absolute value
// Returns the value plus where it came from, because a threshold nobody can trace back to a
// source is a threshold nobody can debug.
function resolveThreshold(cfg, rawKeys, key, ratioKey, windowTokens) {
  const explicit = rawKeys instanceof Set && rawKeys.has(key) ? cfg[key] : undefined
  if (explicit !== undefined) return { value: explicit, source: 'absolute' }
  const ratio = usableRatio(cfg[ratioKey])
  if (ratio !== undefined && typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens > 0) {
    return { value: Math.floor(windowTokens * ratio), source: 'ratio' }
  }
  return { value: DEFAULTS[key], source: 'default' }
}

function resolveThresholds(cfg, rawKeys, windowTokens) {
  const trigger = resolveThreshold(cfg, rawKeys, 'triggerSurfaceTokens', 'triggerRatio', windowTokens)
  const target = resolveThreshold(cfg, rawKeys, 'targetSurfaceTokens', 'targetRatio', windowTokens)
  return {
    windowTokens: typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : null,
    trigger: trigger.value,
    target: target.value,
    triggerSource: trigger.source,
    targetSource: target.source,
    // Why the ratios did not apply, when they did not. An invalid ratio is the one failure
    // mode a user cannot see from the resolved numbers alone.
    triggerRatioInvalid: !(rawKeys instanceof Set && rawKeys.has('triggerSurfaceTokens')) && usableRatio(cfg.triggerRatio) === undefined && cfg.triggerRatio !== undefined,
    targetRatioInvalid: !(rawKeys instanceof Set && rawKeys.has('targetSurfaceTokens')) && usableRatio(cfg.targetRatio) === undefined && cfg.targetRatio !== undefined,
  }
}

// The threshold fields that go into EVERY profile and fold log line, so a reader can always
// tell which of the three paths produced the thresholds that were used.
function thresholdsLog(t) {
  const out = { trigger: t.trigger, target: t.target, windowTokens: t.windowTokens, triggerSource: t.triggerSource, targetSource: t.targetSource }
  if (t.triggerRatioInvalid) out.triggerRatioInvalid = true
  if (t.targetRatioInvalid) out.targetRatioInvalid = true
  return out
}

function logLine(obj) {
  try {
    const file = path.join(dshHome(), readConfig().logFile)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n')
  } catch {
    // logging must never be able to break a turn
  }
}

// How one surface event changes the count of tool calls that are still open.
function eventDelta(event) {
  if (!event || typeof event !== 'object') return 0
  if (event.type === 'tool/result') return -1
  if (event.type === 'assistant/message') {
    const message = event.data && event.data.message
    const content = message && Array.isArray(message.content) ? message.content : []
    return content.filter((block) => block && block.type === 'tool-call').length
  }
  return 0
}

// Look up session events by their absolute seq, whatever order the log is in.
//
// The accessor changed between DSH generations, and getting it wrong is SILENT: an empty map
// makes balancedCuts refuse every cut, so the plugin logs `no-safe-cut` forever and never
// folds. Verified 2026-10-15 on 0.2.0-rc.2 (sandbox #2): `session.events` does not exist there
// (only a private `eventsSnapshot`), and the profile line read
// `byType:{"unknown":{"n":20,"bytes":0}}` -- every node unknown.
//   - 0.1.x: `session.events`, a plain array whose entries carry their own `seq`.
//   - 0.2.0: `session.log`, a POSITIONAL array -- `eventAt(seq)` is literally `log[seq]` --
//            plus `snapshotEvents()` for a frozen copy.
function eventMap(session) {
  const bySeq = new Map()
  try {
    if (Array.isArray(session.events)) {
      for (const event of session.events) {
        if (event && typeof event.seq === 'number') bySeq.set(event.seq, event)
      }
      if (bySeq.size > 0) return bySeq
    }
  } catch {
    // a throwing accessor must fall through to the next shape, never break the fold
  }
  try {
    const log = session.log
    if (Array.isArray(log)) {
      for (let seq = 0; seq < log.length; seq++) {
        if (log[seq] !== undefined) bySeq.set(seq, log[seq])
      }
      if (bySeq.size > 0) return bySeq
    }
  } catch {
    // same: fall through
  }
  try {
    if (typeof session.snapshotEvents === 'function') {
      let index = 0
      for (const event of session.snapshotEvents()) {
        if (event && typeof event.seq === 'number') bySeq.set(event.seq, event)
        else if (event !== undefined) bySeq.set(index, event)
        index += 1
      }
    }
  } catch {
    // out of options: an empty map, which fails safe (no cut)
  }
  return bySeq
}

// The surface-replace marker for one fold.
//
// The range keys changed between generations and the wrong set is REJECTED, not ignored:
// dsh-session's isReplaceOp demands exactly {op, startSeq, endSeq} in 0.2.0 and exactly
// {op, start, end} in 0.1.x. Both validations run BEFORE the event is pushed onto the log, so
// trying one shape and falling back to the other cannot leave a half-appended event behind.
function surfaceOps(session, startSeq, endSeq) {
  const legacy = { op: 'replace', start: startSeq, end: endSeq }
  const modern = { op: 'replace', startSeq, endSeq }
  // A host that still exposes `session.events` is the 0.1.x generation, whose isReplaceOp
  // wants start/end. Anything else is 0.2.0+, which wants startSeq/endSeq. The other shape is
  // kept as a fallback in case a build ever accepts both or reports the shape differently.
  const usesLegacy = Array.isArray(session && session.events)
  return usesLegacy ? [legacy, modern] : [modern, legacy]
}

// Append the fold message, using whichever surface-replace shape this host accepts.
// Returns the shape that worked, so the caller can record it in the log.
function appendFold(session, message, startSeq, endSeq, shadowed) {
  let lastError
  for (const surfaceOp of surfaceOps(session, startSeq, endSeq)) {
    try {
      session.append('user/message', message, {
        surfaceOp,
        sourceEventSeqs: shadowed.slice(),
      })
      return Object.hasOwn(surfaceOp, 'startSeq') ? 'startSeq' : 'start'
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

function jsonBytes(value) {
  try {
    return JSON.stringify(value).length
  } catch {
    return -1
  }
}

// The latest node index that is still at least `keep` nodes away from the end AND lands on a
// balanced cut. -1 when there is no such index.
function pickEndIndex(nodes, balanced, keep) {
  const lastAllowedIdx = nodes.length - 1 - keep
  if (lastAllowedIdx < 0) return -1
  for (let i = lastAllowedIdx; i >= 0; i--) {
    if (balanced[i + 1]) return i
  }
  return -1
}

// Resolve the real token meter. cordis throws on an undeclared service property
// (cordis/lib/index.js:675), so this tries the declared path first, then the sanctioned
// non-runtime reflection path (same file, line 679), then the agent's own composed context.
// WHICH path worked is returned and logged: a plugin that silently gets nothing is worse
// than one that says so.
function resolveMeter(ctx, payload) {
  try {
    if (ctx.tokenMeter) return { meter: ctx.tokenMeter, via: 'ctx.tokenMeter' }
  } catch {
    // not declared in inject, or not visible here -- try the reflection path
  }
  try {
    const reflected = ctx.reflect && typeof ctx.reflect.get === 'function'
      ? ctx.reflect.get('tokenMeter', false)
      : undefined
    if (reflected) return { meter: reflected, via: 'ctx.reflect.get' }
  } catch {
    // no reflection service either
  }
  try {
    const agentCtx = payload && payload.agent && payload.agent.ctx
    if (agentCtx && agentCtx.tokenMeter) return { meter: agentCtx.tokenMeter, via: 'agent.ctx.tokenMeter' }
  } catch {
    // the agent context is composed differently here
  }
  return { meter: undefined, via: 'none' }
}

// Where the model identity comes from, in the same order the shipped compactor uses
// (dsh-compaction-basic/lib/index.js:268-277): the agent's own options first, then the route
// the session actually last requested, because on the first request the options may be unset.
function routeTargets(agent) {
  const targets = []
  try {
    const options = agent && agent.options
    if (options && typeof options.provider === 'string' && options.provider.length > 0
      && typeof options.model === 'string' && options.model.length > 0) {
      targets.push({ provider: options.provider, model: options.model, via: 'agent.options' })
    }
  } catch {
    // agent.options is absent in some compositions
  }
  try {
    const config = agent && agent.session && typeof agent.session.requestHeader === 'function'
      ? agent.session.requestHeader()?.config
      : undefined
    if (config && config.provider !== undefined && config.model !== undefined) {
      targets.push({ provider: config.provider, model: config.model, via: 'session.requestHeader' })
    }
  } catch {
    // not every session keeps a request header
  }
  return targets
}

// The context window of the model this turn will actually run on, or undefined when it cannot
// be established. Same lookup the shipped compactor performs for its own threshold:
// ctx.llm.resolveModelInfo(provider, model, signal) -> info.context.contextWindow
// (dsh-compaction-basic:877-881, dsh-llm resolveModelInfoFor:1301-1316, where `context` is
// optional and omitted entirely for a model whose adapter declares no capacity).
//
// ctx.llm is NOT declared in this plugin's inject (adding it would make the whole plugin fail
// to load wherever no llm service exists), and cordis throws on undeclared service properties,
// so this mirrors resolveMeter(): direct property, then the sanctioned reflection path, then
// the agent's own composed context. Any failure -- no service, no route, a throwing or
// non-conforming resolveModelInfo, a non-positive window -- simply means "unknown", which
// leaves the caller on its absolute default. Nothing here is cached: `resolveModelInfo` is a
// local adapter lookup, and a threshold derived from a stale window would be worse than the
// cost of asking again.
async function resolveWindowTokens(ctx, payload) {
  const agent = payload && payload.agent
  const targets = routeTargets(agent)
  if (targets.length === 0) return { windowTokens: undefined, via: 'none', reason: 'no-provider-model' }

  let llm
  let via = 'none'
  try {
    if (ctx.llm) { llm = ctx.llm; via = 'ctx.llm' }
  } catch {
    // not declared in inject, or not visible here -- try the reflection path
  }
  if (llm === undefined) {
    try {
      const reflected = ctx.reflect && typeof ctx.reflect.get === 'function' ? ctx.reflect.get('llm', false) : undefined
      if (reflected) { llm = reflected; via = 'ctx.reflect.get' }
    } catch {
      // no reflection service either
    }
  }
  if (llm === undefined) {
    try {
      const agentCtx = agent && agent.ctx
      if (agentCtx && agentCtx.llm) { llm = agentCtx.llm; via = 'agent.ctx.llm' }
    } catch {
      // the agent context is composed differently here
    }
  }
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') {
    return { windowTokens: undefined, via, reason: 'llm-not-reachable' }
  }

  const signal = payload && payload.signal
  for (const target of targets) {
    try {
      const info = await llm.resolveModelInfo(target.provider, target.model, signal)
      const contextWindow = info && info.context ? info.context.contextWindow : undefined
      // A positive INTEGER is what dsh-llm itself requires of contextWindow
      // (resolveModelInfoFor:1306). Anything else here -- a string, NaN, a fraction, a zero --
      // is not capacity data, and is treated as "no window" rather than turned into a
      // threshold nobody can explain.
      if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && Number.isInteger(contextWindow) && contextWindow > 0) {
        return { windowTokens: contextWindow, via: via + '/' + target.via }
      }
    } catch {
      // a bad route or an adapter that cannot report capacity: try the next target, then give up
    }
  }
  return { windowTokens: undefined, via, reason: 'no-context-window' }
}

// One observation line per turn: where the tokens actually are, and what folding would save.
// Never throws into the caller; diagnostics must never stop a turn.
function logProfile(session, nodes, bySeq, meter, step, turn, via, thresholds) {
  const byType = {}
  let totalBytes = 0
  for (let i = 0; i < nodes.length; i++) {
    const event = bySeq.get(nodes[i])
    const type = event && typeof event.type === 'string' ? event.type : 'unknown'
    const bytes = event === undefined ? 0 : jsonBytes(event)
    if (bytes > 0) totalBytes += bytes
    const row = byType[type] || (byType[type] = { n: 0, bytes: 0 })
    row.n += 1
    if (bytes > 0) row.bytes += bytes
  }

  const out = { mark: 'profile', step, turn, via, nodes: nodes.length, totalBytes, byType, ...thresholdsLog(thresholds) }

  // The real meter, when this build exposes it to the plugin context. This is what
  // compaction plans against, so preferring it over byte counts is deliberate.
  let tokensBySeq = null
  try {
    if (meter && typeof meter.measure === 'function') {
      const measured = meter.measure(session)
      out.meterAvailable = true
      out.surfaceTokens = measured.surfaceTokens
      out.totalTokens = measured.totalTokens
      out.baseline = measured.baseline && measured.baseline.kind
      tokensBySeq = new Map()
      if (Array.isArray(measured.nodes)) {
        for (const node of measured.nodes) {
          if (node && typeof node.seq === 'number') tokensBySeq.set(node.seq, node.tokens)
        }
      }
    } else {
      out.meterAvailable = false
    }
  } catch (err) {
    out.meterAvailable = false
    out.meterError = String(err && err.message ? err.message : err)
  }

  // What folding the oldest run would buy, at several keepRecent settings.
  const balanced = balancedCuts(nodes, bySeq)
  const savings = []
  for (const keep of PROFILE_KEEPS) {
    const endIdx = pickEndIndex(nodes, balanced, keep)
    if (endIdx < 0) continue
    const row = { keep, foldNodes: endIdx + 1 }
    if (tokensBySeq !== null) {
      let folded = 0
      for (let i = 0; i <= endIdx; i++) folded += tokensBySeq.get(nodes[i]) || 0
      row.foldTokens = folded
      row.foldPct = out.surfaceTokens ? Math.round((folded / out.surfaceTokens) * 1000) / 10 : null
    }
    savings.push(row)
  }
  out.foldOptions = savings

  // Which message sources the surface is made of, and where the tokens really sit. This is
  // what decides the whole policy: if tool results dominate, folding whole messages by age
  // is the wrong lever and pruning old tool output is the right one.
  const srcKinds = {}
  const tokensByType = {}
  let maxNode = null
  for (let i = 0; i < nodes.length; i++) {
    const seq = nodes[i]
    const event = bySeq.get(seq)
    const type = event && typeof event.type === 'string' ? event.type : 'unknown'
    const message = event && (event.type === 'user/message' ? event.data : (event.data && event.data.message))
    const src = message && message.source && typeof message.source.kind === 'string' ? message.source.kind : 'none'
    srcKinds[src] = (srcKinds[src] || 0) + 1
    if (tokensBySeq !== null) {
      const tokens = tokensBySeq.get(seq) || 0
      tokensByType[type] = (tokensByType[type] || 0) + tokens
      if (maxNode === null || tokens > maxNode.tokens) maxNode = { seq, type, src, tokens }
    }
  }
  out.srcKinds = srcKinds
  if (tokensBySeq !== null) {
    out.tokensByType = tokensByType
    out.maxNode = maxNode
  }

  // A few concrete nodes at both ends, so the shape is unambiguous.
  const describe = (seq) => {
    const event = bySeq.get(seq)
    const message = event && (event.type === 'user/message' ? event.data : (event.data && event.data.message))
    const src = message && message.source && typeof message.source.kind === 'string' ? message.source.kind : null
    return { seq, type: event && event.type, src, bytes: event === undefined ? 0 : jsonBytes(event) }
  }
  out.head = nodes.slice(0, 3).map(describe)
  out.tail = nodes.slice(-3).map(describe)

  logLine(out)
}

// balanced[i] === true  <=>  the cut immediately BEFORE nodes[i] is tool-pairing balanced.
// balanced[nodes.length] is the cut after the whole surface.
function balancedCuts(nodes, bySeq) {
  const balanced = new Array(nodes.length + 1).fill(false)
  balanced[0] = true
  let open = 0
  for (let i = 0; i < nodes.length; i++) {
    const event = bySeq.get(nodes[i])
    if (event === undefined) {
      // An unknown node means the surface and the log disagree. Refuse to cut here
      // or anywhere after it, rather than guess.
      return balanced
    }
    open += eventDelta(event)
    balanced[i + 1] = open === 0
  }
  return balanced
}

// How many leading surface nodes this host refuses to let anyone fold.
//
// 0.2.0 puts the system prompt in the surface itself and protects it (dsh-session/lib/index.js
// :412-419): a replace that reaches node 0 is rejected with
//   `surface replace: node 0 holds the system prompt and may be rewritten only by a
//    system/message over exactly that node`
// So the fold must start AFTER that head. Its tokens stay in the surface, which means they
// also stay in the reach-the-target arithmetic -- folding 0.2.0 down to a target below the
// system prompt's own size is legitimately unreachable, and no-safe-cut is the honest answer.
//
// 0.1.x has no system/message in the surface at all, so this returns 0 there.
function protectedPrefixLength(nodes, bySeq) {
  let index = 0
  while (index < nodes.length) {
    const event = bySeq.get(nodes[index])
    if (event !== undefined && event.type === 'system/message') index += 1
    else break
  }
  return index
}

// The message object carried by a surface event: user/message data IS the message, the other
// event types nest it under data.message (dsh-session:278-280).
function messageOf(event) {
  if (!event) return undefined
  if (event.type === 'user/message') return event.data
  return event.data && event.data.message
}

function sourceKindOf(event) {
  const message = messageOf(event)
  const source = message && message.source
  return source && typeof source.kind === 'string' ? source.kind : 'none'
}

// Flatten one message to plain text.
//
// Two callers want different things, so `full` selects between them:
//   - the digest/index wants a compact stub, so a folded range stays readable in-context;
//   - the archive wants the real body, because it is the only copy that survives leaving the
//     visible history (see the "never fold what we failed to archive" guard).
// A tool-result block nests its payload as {toolCallId, content:[{type:'text',text}]}, so the
// stub branch never reaches the body on its own: without `full` the archive silently kept only
// the call id, and the output became unreadable once the span left the surface.
// Verified 2026-10-11 on a real 608-message fold: bodies kept went 0/300 -> 298/298.
function textOf(message, full) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call') {
      const args = typeof block.arguments === 'string' ? ' ' + block.arguments : ''
      parts.push('[tool-call ' + String(block.name || '?') + args + ']')
    } else if (block.type === 'tool-result') {
      const stub = '[tool-result ' + String(block.toolCallId || '?') + ']'
      if (!full) parts.push(stub)
      else {
        const nested = []
        for (const inner of Array.isArray(block.content) ? block.content : []) {
          if (inner && typeof inner.text === 'string') nested.push(inner.text)
        }
        parts.push(nested.length > 0 ? stub + '\n' + nested.join('\n') : stub)
      }
    } else if (typeof block.type === 'string') parts.push('[' + block.type + ']')
  }
  return parts.join('\n')
}

// A filename-safe key for one session, so archives never collide.
function sessionKey(session, nodes) {
  let raw = ''
  try {
    const header = session.header
    if (header && typeof header.id === 'string') raw = header.id
    else if (header && header.id !== undefined) raw = String(header.id)
  } catch {
    // fall through to the seq-based key
  }
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, '')
  if (clean.length >= 4 && clean[0] !== '[') return clean
  return 'seq-' + String((nodes && nodes[0]) || 0)
}

// Append the full text of every folded node to a JSONL archive BEFORE the fold is committed.
// This is what makes the fold lossless: the visible history shrinks, the record does not.
function archiveFolded(key, shadowed, bySeq, cfg) {
  const dir = path.join(dshHome(), cfg.archiveDir)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, key + '.jsonl')
  const rows = []
  for (const seq of shadowed) {
    const event = bySeq.get(seq)
    rows.push(JSON.stringify({
      seq,
      type: event && event.type,
      src: sourceKindOf(event),
      text: textOf(messageOf(event), true),
    }))
  }
  fs.appendFileSync(file, rows.join('\n') + '\n')
  return { file, rows: rows.length }
}

// ---------------------------------------------------------------------------- tier index
//
// One marker line in every folded message tells the NEXT fold where that fold's unsampled
// index lives. Parsing it back is how the chain stays walkable after the message itself has
// been folded out of the visible history and collapsed to a single line.
const FOLD_MARK = '[fold-index]'

function foldMarker(startSeq, endSeq, count, file) {
  return FOLD_MARK + ' seqs=' + startSeq + '..' + endSeq + ' messages=' + count + ' file=' + file
}

function parseFoldMarker(text) {
  if (typeof text !== 'string') return null
  const at = text.indexOf(FOLD_MARK)
  if (at < 0) return null
  const tail = text.slice(at + FOLD_MARK.length)
  const m = /^\s+seqs=(\d+)\.\.(\d+)\s+messages=(\d+)\s+file=(.+)/.exec(tail)
  if (!m) return null
  return {
    startSeq: Number(m[1]),
    endSeq: Number(m[2]),
    messages: Number(m[3]),
    file: m[4].trim(),
  }
}

// The message `source` this host accepts.
//
// v4 (0.2.0) RETIRES the {kind:'plugin', plugin:X} wrapper. Its own migration rewrites that
// wrapper into the producer's own kind, and the native admission check refuses it outright
// (dsh-session-format-v3-to-v4/lib/index.js:123-127):
//   `format v4 message requires a producer-owned source kind`
// For a third-party plugin the canonical producer kind is `plugin:<name>` (same file, :92:
// `return \`plugin:${plugin}\``). Getting this wrong is not caught at append time -- it throws
// at ROW ADMISSION when the log is written, which WEDGES THE TURN: no turn/end, no persistence,
// and every later turn on that session hangs too. Reproduced twice on 0.2.0-rc.2.
function foldSource(session) {
  return Array.isArray(session && session.events)
    ? { kind: 'plugin', plugin: name }
    : { kind: 'plugin:' + name }
}

// Is this event a message THIS plugin wrote? Other plugins also append user/message, so the
// producer identity is what actually identifies ours -- under either generation's spelling.
function foldMessageOf(event) {
  const message = messageOf(event)
  const source = message && message.source
  if (!source) return null
  const ours = (source.kind === 'plugin' && source.plugin === name) || source.kind === 'plugin:' + name
  if (!ours) return null
  return { message, marker: parseFoldMarker(textOf(message, true)) }
}

function indexFileFor(key, cfg, startSeq, endSeq) {
  return path.join(dshHome(), cfg.indexDir, key, 'f' + startSeq + '-' + endSeq + '.md')
}

// The tier file for one fold: the UNSAMPLED index of the range, plus the tier files of any
// earlier folds that this fold covered. Written to disk only -- context gets the path.
function writeIndexTier(key, startSeq, endSeq, shadowed, bySeq, cfg, archiveFile, subPointers) {
  const file = indexFileFor(key, cfg, startSeq, endSeq)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = []
  lines.push('# dsh-history-fold tier index')
  lines.push('# session: ' + key)
  lines.push('# visible range: seqs ' + startSeq + '..' + endSeq + ' (' + shadowed.length + ' messages)')
  lines.push('# raw text of every message in this range: ' + archiveFile)
  lines.push('#')
  lines.push('# Each line below is the first ' + cfg.digestLineChars + ' chars of ONE message in this')
  lines.push('# range, UNSAMPLED. To read a message verbatim, search the raw file for its seq.')
  lines.push('#')
  if (subPointers.length > 0) {
    lines.push('## older tier files (earlier folds that this range covers)')
    for (const sub of subPointers) {
      lines.push('- seqs ' + sub.startSeq + '..' + sub.endSeq + ' (' + sub.messages + ' messages) -> ' + sub.file)
    }
    lines.push('')
  }
  lines.push('## message index')
  for (let index = 0; index < shadowed.length; index++) {
    const seq = shadowed[index]
    const event = bySeq.get(seq)
    const fold = foldMessageOf(event)
    if (fold && fold.marker) {
      lines.push('[' + index + '] fold-pointer seq=' + seq + ': older fold seqs ' +
        fold.marker.startSeq + '..' + fold.marker.endSeq + ' (' + fold.marker.messages + ' messages), index at ' + fold.marker.file)
      continue
    }
    const text = textOf(messageOf(event)).replace(/\s+/g, ' ').trim()
    const cut = text.length > cfg.digestLineChars ? text.slice(0, cfg.digestLineChars) + '...' : text
    lines.push('[' + index + '] ' + String(event && event.type) + ' (' + sourceKindOf(event) + ') seq=' + seq + ': ' + cut)
  }
  const body = lines.join('\n') + '\n'
  fs.writeFileSync(file, body)
  return { file, lines: lines.length, bytes: Buffer.byteLength(body, 'utf8') }
}

// An extractive digest: one line per folded message. Crude on purpose -- it costs nothing,
// needs no model call, and it is what keeps the conversation's continuity after the fold.
// When it overflows its budget the lines are sampled rather than truncated.
function buildDigest(shadowed, bySeq, cfg) {
  const lines = shadowed.map((seq, index) => {
    const event = bySeq.get(seq)
    const fold = foldMessageOf(event)
    if (fold && fold.marker) {
      // A fold-pointer is NEVER sampled away: it is the only surviving route from this
      // context down to that older span's tier file. Sampling it out would silently
      // orphan everything older than it.
      return { pinned: true, text: '[' + index + '] fold-pointer seq=' + seq + ': older fold seqs ' +
        fold.marker.startSeq + '..' + fold.marker.endSeq + ' (' + fold.marker.messages + ' messages), index at ' + fold.marker.file }
    }
    const text = textOf(messageOf(event)).replace(/\s+/g, ' ').trim()
    const cut = text.length > cfg.digestLineChars ? text.slice(0, cfg.digestLineChars) + '...' : text
    return { pinned: false, text: '[' + index + '] ' + String(event && event.type) + ' (' + sourceKindOf(event) + ') seq=' + seq + ': ' + cut }
  })
  const pinned = lines.filter((line) => line.pinned)
  const sized = (rows) => rows.map((row) => row.text).join('\n').length
  let step = 1
  let chosen = lines
  while (sized(chosen) > cfg.digestMaxChars && step < 64) {
    step += 1
    chosen = lines.filter((line, index) => line.pinned || index % step === 0)
  }
  if (sized(chosen) > cfg.digestMaxChars && pinned.length > 0) {
    // The pointers alone still overflow. They are cheap and they are the chain, so they
    // stay; everything else goes. (Unreachable in practice: pinned lines are one short
    // line per fold, and folds are rare.)
    chosen = pinned
  }
  const note = chosen.length < lines.length
    ? '(sampled: every ' + step + 'th of ' + lines.length + ' folded messages, plus every fold-pointer)'
    : '(all ' + lines.length + ' folded messages)'
  return note + '\n' + chosen.map((line) => line.text).join('\n')
}

function buildFoldedMessage(shadowed, bySeq, cfg, archive, tier, session) {
  const first = shadowed[0]
  const last = shadowed[shadowed.length - 1]
  const head = [
    '[' + name + '] ' + shadowed.length + ' earlier messages (surface seqs ' + first + '..' + last +
      ') were folded out of the visible history so this session stays fast.',
    'NOTHING WAS DELETED. Their full text is archived at:',
    '  ' + archive.file,
    'To read any of it verbatim, search that file with the pwsh or grep tools, for example:',
    '  rg -n "search words" "' + archive.file + '"',
    'The one-line index below is extractive, not a rewritten summary: read it to find what you',
    'need, then search the archive for the exact text. Do not guess about folded content.',
  ]
  if (tier && tier.file) {
    head.push(
      'The full UNSAMPLED index of this range is on disk at:',
      '  ' + tier.file,
      'The index below is sampled once it overflows; that file is not. It also lists the index',
      'files of any OLDER folds this range covered -- read it, then follow those paths in turn.'
    )
  }
  head.push('', foldMarker(first, last, shadowed.length, (tier && tier.file) || archive.file), '')
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: head.join('\n') + buildDigest(shadowed, bySeq, cfg) }],
    source: foldSource(session),
  }
}

function apply(ctx) {
  const disposers = []

  // HARDENING (README: "Requirements / compatibility"). A plugin that is merely
  // INCOMPATIBLE with the build it is loaded into must not be able to take the whole
  // profile down: cancanqiqi/dsh-human-subagent called a service method that does not
  // exist on this build, threw out of apply(), and the loader refused to start. So every
  // registration below is guarded, and a failure writes ONE line and DEACTIVATES the
  // plugin instead of throwing. Failure path only -- with everything present the
  // behaviour is byte for byte what it was before.
  if (!ctx || typeof ctx.on !== 'function' || typeof ctx.effect !== 'function') {
    logLine({ mark: 'deactivated', reason: 'registration-failed', step: 'services', error: 'ctx.on / ctx.effect are not available in this DSH build' })
    return
  }

  const onPreStep = async (payload, next) => {
    try {
      // The RAW key set decides whether an absolute threshold was set explicitly; see
      // readConfigFile(). readConfig() alone cannot answer that question.
      const { config: cfg, rawKeys } = readConfigFile()
      if (!cfg.enabled) return next()

      // Recorded in every log line so the first observation run also reveals what
      // payload.step / payload.turn actually mean in this DSH build.
      const step = payload && payload.step
      const turn = payload && payload.turn

      if (cfg.onlyAtTurnStart && typeof step === 'number' && step > 1) {
        return next()
      }

      const agent = payload && payload.agent
      const session = agent && agent.session
      const nodes = session && session.surface && session.surface.nodes
      if (!Array.isArray(nodes) || nodes.length === 0) return next()

      const bySeq = eventMap(session)

      // Resolve the meter FIRST: every decision below, and the profile line itself, needs it.
      const resolved = resolveMeter(ctx, payload)
      const meter = resolved.meter

      // Then the two thresholds, from the context window of the model this turn runs on.
      // `via` is merged into the same field the meter already reports so one log line answers
      // both questions, and a failed lookup never throws -- it just leaves the absolute
      // default in place, with source 'default' recorded next to it.
      let window = { windowTokens: undefined, via: 'none', reason: 'error' }
      try {
        window = await resolveWindowTokens(ctx, payload)
      } catch {
        // resolveWindowTokens contains its own catches; this is the belt-and-braces one.
      }
      const thresholds = resolveThresholds(cfg, rawKeys, window.windowTokens)
      const via = window.via === 'none' ? resolved.via : resolved.via + '|llm:' + window.via
      const triggerTokens = thresholds.trigger
      const targetTokens = thresholds.target

      if (cfg.profile) {
        try {
          logProfile(session, nodes, bySeq, meter, step, turn, via, thresholds)
        } catch (err) {
          // Diagnostics must never stop a turn, but they must never vanish either: swallowing
          // this exact error is what hid a broken meter lookup for three turns.
          logLine({ mark: 'profile-error', step, turn, via, error: String(err && err.message ? err.message : err), ...thresholdsLog(thresholds) })
        }
      }

      // The policy runs on real tokens, never on node counts: node size varies by orders of
      // magnitude, so a count is not a budget.
      if (meter === undefined) {
        logLine({ mark: 'no-meter', step, turn, nodes: nodes.length, via, reason: 'tokenMeter not reachable', ...thresholdsLog(thresholds) })
        return next()
      }

      let measurement = null
      try {
        measurement = meter.measure(session)
      } catch (err) {
        logLine({ mark: 'no-meter', step, turn, via, error: String(err && err.message ? err.message : err), ...thresholdsLog(thresholds) })
        return next()
      }

      const tokensBySeq = new Map()
      for (const node of measurement.nodes || []) {
        if (node && typeof node.seq === 'number') tokensBySeq.set(node.seq, node.tokens || 0)
      }
      const surfaceTokens = measurement.surfaceTokens || 0

      if (surfaceTokens <= triggerTokens) {
        logLine({ mark: 'idle', step, turn, nodes: nodes.length, surfaceTokens, via, ...thresholdsLog(thresholds) })
        return next()
      }

      // Fold the OLDEST run only, and only as far as the target requires. The cut before node
      // 0 is trivially balanced, which is what the real compaction engine assumes too.
      const balanced = balancedCuts(nodes, bySeq)
      const protectedCount = protectedPrefixLength(nodes, bySeq)
      const lastFoldableIdx = nodes.length - 1 - cfg.keepRecentNodes
      let endIdx = -1
      let remaining = surfaceTokens
      // The protected head never leaves the surface, so its size is subtracted up front and
      // the fold window opens just after it.
      for (let i = 0; i < protectedCount; i++) remaining -= tokensBySeq.get(nodes[i]) || 0
      for (let i = protectedCount; i <= lastFoldableIdx; i++) {
        remaining -= tokensBySeq.get(nodes[i]) || 0
        if (balanced[i + 1] && remaining <= targetTokens) { endIdx = i; break }
      }

      // A target at or above the trigger is normally unreachable by construction: the fold stops
      // as soon as the remaining surface drops to the target, and it can only drop, so no index
      // can satisfy the test -- the loop finds nothing. That is the same unreachable-target
      // condition as an over-large keepRecentNodes, and it exits through the same no-safe-cut
      // path rather than through behaviour invented for ratios. (A surface already at or below
      // the target is the degenerate exception: then the cut before node 0 satisfies it and one
      // step is folded. That is the pre-existing shape of this loop, not a ratio rule, and
      // test/ratio-tests.mjs pins both outcomes.)
      if (endIdx < 0) {
        logLine({ mark: 'no-safe-cut', step, turn, nodes: nodes.length, surfaceTokens, via, lastFoldableIdx, protectedCount, ...thresholdsLog(thresholds) })
        return next()
      }

      const shadowed = nodes.slice(protectedCount, endIdx + 1)
      const foldTokens = surfaceTokens - remaining
      if (shadowed.length < cfg.minFoldNodes || foldTokens < cfg.minFoldTokens) {
        logLine({ mark: 'no-safe-cut', step, turn, nodes: nodes.length, foldCount: shadowed.length, foldTokens, need: cfg.minFoldTokens, via, ...thresholdsLog(thresholds) })
        return next()
      }

      const startSeq = shadowed[0]
      const endSeq = shadowed[shadowed.length - 1]

      logLine({
        mark: cfg.dryRun ? 'would-fold' : 'folding',
        step,
        turn,
        nodes: nodes.length,
        surfaceTokens,
        via,
        startSeq,
        endSeq,
        foldCount: shadowed.length,
        foldTokens,
        foldPct: surfaceTokens ? Math.round((foldTokens / surfaceTokens) * 1000) / 10 : null,
        ...thresholdsLog(thresholds),
      })

      if (cfg.dryRun) return next()

      const key = sessionKey(session, nodes)
      let archive = { file: '(archive disabled)' }
      if (cfg.archive) {
        try {
          archive = archiveFolded(key, shadowed, bySeq, cfg)
        } catch (err) {
          // Never fold what we failed to archive: the archive is the only copy that survives
          // leaving the visible history.
          logLine({ mark: 'archive-failed', step, turn, error: String(err && err.message ? err.message : err) })
          return next()
        }
      }

      // Every earlier fold that this range covers becomes a pointer in the new tier file, so
      // the chain context -> tier -> older tier -> raw archive stays walkable.
      const subPointers = []
      if (cfg.indexTree) {
        for (const seq of shadowed) {
          const fold = foldMessageOf(bySeq.get(seq))
          if (fold && fold.marker) subPointers.push(fold.marker)
        }
      }
      let tier = null
      if (cfg.indexTree && cfg.indexFull) {
        try {
          tier = writeIndexTier(key, startSeq, endSeq, shadowed, bySeq, cfg, archive.file, subPointers)
        } catch (err) {
          // The archive already holds every byte, so a failed index write must not block the
          // fold. The message then points at the raw archive instead of a tier file.
          logLine({ mark: 'index-failed', step, turn, error: String(err && err.message ? err.message : err) })
          tier = null
        }
      }

      const opShape = appendFold(
        session,
        buildFoldedMessage(shadowed, bySeq, cfg, archive, tier, session),
        startSeq,
        endSeq,
        shadowed
      )

      // surfaceTokens is carried here too: 'folding' and 'would-fold' both report it, and a
      // post-hoc reader must not have to join two lines to learn what the fold started from.
      logLine({
        mark: 'folded',
        nodesBefore: nodes.length,
        folded: shadowed.length,
        surfaceTokens,
        foldTokens,
        startSeq,
        endSeq,
        archive: archive.file,
        tier: tier ? tier.file : null,
        tierLines: tier ? tier.lines : null,
        subTiers: subPointers.length,
        surfaceOpKeys: opShape,
        via,
        ...thresholdsLog(thresholds),
      })
      return next()
    } catch (err) {
      // Fail open: this plugin must never be able to break a normal turn.
      try { logLine({ mark: 'error', message: String(err && err.message ? err.message : err) }) } catch {}
      return next()
    }
  }

  try {
    disposers.push(ctx.on('agent/pre-step', onPreStep))
  } catch (err) {
    logLine({ mark: 'deactivated', reason: 'registration-failed', step: 'agent/pre-step', error: String(err && err.message ? err.message : err) })
    return
  }

  const onDispose = () => () => {
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  }

  try {
    ctx.effect(onDispose)
  } catch (err) {
    // Deactivating means leaving nothing half-registered behind.
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
    logLine({ mark: 'deactivated', reason: 'registration-failed', step: 'ctx.effect', error: String(err && err.message ? err.message : err) })
  }
}

export { name, inject, apply }
