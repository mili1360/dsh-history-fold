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
//   enabled: false  -> the plugin is loaded but completely idle.
//   dryRun:  true   -> observe and log only; never writes anything.
//   Both are the defaults, so installing this plugin changes nothing at all until the user
//   reads the log and turns it on deliberately.
//
// ASCII ONLY on purpose -- this box runs a GBK code page.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const name = 'dsh-history-fold'
const inject = []

const DEFAULTS = {
  // SAFE BY DEFAULT: a fresh install with no config.json is completely inert. Folding
  // rewrites what the model sees, so a plugin must never start doing that on install.
  // Turn it on deliberately: enabled=true, dryRun=false.
  // Live configs that already set these explicitly are unaffected by the defaults.
  enabled: false,
  // Set false to fold for real. While true the plugin only observes and logs.
  dryRun: true,
  // Write one size/profile line per turn.
  profile: true,
  // Fold only while the visible history is above this many tokens.
  // dsh-compaction-basic compacts at 0.8 * contextWindow (800k here) and retains 0.16
  // (160k). Staying below that line is what stops the lossy summarizer from ever firing.
  triggerSurfaceTokens: 250000,
  // Fold down to about this many tokens of visible history.
  targetSurfaceTokens: 180000,
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

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
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
function eventMap(session) {
  const bySeq = new Map()
  if (Array.isArray(session.events)) {
    for (const event of session.events) {
      if (event && typeof event.seq === 'number') bySeq.set(event.seq, event)
    }
  }
  return bySeq
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

// One observation line per turn: where the tokens actually are, and what folding would save.
// Never throws into the caller; diagnostics must never stop a turn.
function logProfile(session, nodes, bySeq, meter, step, turn, via) {
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

  const out = { mark: 'profile', step, turn, via, nodes: nodes.length, totalBytes, byType }

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

// An extractive digest: one line per folded message. Crude on purpose -- it costs nothing,
// needs no model call, and it is what keeps the conversation's continuity after the fold.
// When it overflows its budget the lines are sampled rather than truncated.
function buildDigest(shadowed, bySeq, cfg) {
  const lines = shadowed.map((seq, index) => {
    const event = bySeq.get(seq)
    const text = textOf(messageOf(event)).replace(/\s+/g, ' ').trim()
    const cut = text.length > cfg.digestLineChars ? text.slice(0, cfg.digestLineChars) + '...' : text
    return '[' + index + '] ' + String(event && event.type) + ' (' + sourceKindOf(event) + ') seq=' + seq + ': ' + cut
  })
  let step = 1
  let chosen = lines
  while (chosen.join('\n').length > cfg.digestMaxChars && step < 64) {
    step += 1
    chosen = lines.filter((_, index) => index % step === 0)
  }
  const note = chosen.length < lines.length
    ? '(sampled: every ' + step + 'th of ' + lines.length + ' folded messages)'
    : '(all ' + lines.length + ' folded messages)'
  return note + '\n' + chosen.join('\n')
}

function buildFoldedMessage(shadowed, bySeq, cfg, archive) {
  const first = shadowed[0]
  const last = shadowed[shadowed.length - 1]
  const header = [
    '[' + name + '] ' + shadowed.length + ' earlier messages (surface seqs ' + first + '..' + last +
      ') were folded out of the visible history so this session stays fast.',
    'NOTHING WAS DELETED. Their full text is archived at:',
    '  ' + archive.file,
    'To read any of it verbatim, search that file with the pwsh or grep tools, for example:',
    '  rg -n "search words" "' + archive.file + '"',
    'The one-line index below is extractive, not a rewritten summary: read it to find what you',
    'need, then search the archive for the exact text. Do not guess about folded content.',
    '',
  ].join('\n')
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: header + buildDigest(shadowed, bySeq, cfg) }],
    source: { kind: 'plugin', plugin: name },
  }
}

function apply(ctx) {
  const disposers = []

  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const cfg = readConfig()
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

      if (cfg.profile) {
        try {
          logProfile(session, nodes, bySeq, meter, step, turn, resolved.via)
        } catch (err) {
          // Diagnostics must never stop a turn, but they must never vanish either: swallowing
          // this exact error is what hid a broken meter lookup for three turns.
          logLine({ mark: 'profile-error', step, turn, via: resolved.via, error: String(err && err.message ? err.message : err) })
        }
      }

      // The policy runs on real tokens, never on node counts: node size varies by orders of
      // magnitude, so a count is not a budget.
      if (meter === undefined) {
        logLine({ mark: 'no-meter', step, turn, nodes: nodes.length, via: resolved.via, reason: 'tokenMeter not reachable' })
        return next()
      }

      let measurement = null
      try {
        measurement = meter.measure(session)
      } catch (err) {
        logLine({ mark: 'no-meter', step, turn, via: resolved.via, error: String(err && err.message ? err.message : err) })
        return next()
      }

      const tokensBySeq = new Map()
      for (const node of measurement.nodes || []) {
        if (node && typeof node.seq === 'number') tokensBySeq.set(node.seq, node.tokens || 0)
      }
      const surfaceTokens = measurement.surfaceTokens || 0

      if (surfaceTokens <= cfg.triggerSurfaceTokens) {
        logLine({ mark: 'idle', step, turn, nodes: nodes.length, surfaceTokens, trigger: cfg.triggerSurfaceTokens })
        return next()
      }

      // Fold the OLDEST run only, and only as far as the target requires. The cut before node
      // 0 is trivially balanced, which is what the real compaction engine assumes too.
      const balanced = balancedCuts(nodes, bySeq)
      const lastFoldableIdx = nodes.length - 1 - cfg.keepRecentNodes
      let endIdx = -1
      let remaining = surfaceTokens
      for (let i = 0; i <= lastFoldableIdx; i++) {
        remaining -= tokensBySeq.get(nodes[i]) || 0
        if (balanced[i + 1] && remaining <= cfg.targetSurfaceTokens) { endIdx = i; break }
      }

      if (endIdx < 0) {
        logLine({ mark: 'no-safe-cut', step, turn, nodes: nodes.length, surfaceTokens, target: cfg.targetSurfaceTokens, lastFoldableIdx })
        return next()
      }

      const shadowed = nodes.slice(0, endIdx + 1)
      const foldTokens = surfaceTokens - remaining
      if (shadowed.length < cfg.minFoldNodes || foldTokens < cfg.minFoldTokens) {
        logLine({ mark: 'no-safe-cut', step, turn, nodes: nodes.length, foldCount: shadowed.length, foldTokens, need: cfg.minFoldTokens })
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
        target: cfg.targetSurfaceTokens,
        startSeq,
        endSeq,
        foldCount: shadowed.length,
        foldTokens,
        foldPct: surfaceTokens ? Math.round((foldTokens / surfaceTokens) * 1000) / 10 : null,
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

      session.append('user/message', buildFoldedMessage(shadowed, bySeq, cfg, archive), {
        surfaceOp: { op: 'replace', start: startSeq, end: endSeq },
        sourceEventSeqs: shadowed.slice(),
      })

      // surfaceTokens is carried here too: 'folding' and 'would-fold' both report it, and a
      // post-hoc reader must not have to join two lines to learn what the fold started from.
      logLine({ mark: 'folded', nodesBefore: nodes.length, folded: shadowed.length, surfaceTokens, foldTokens, startSeq, endSeq, archive: archive.file })
      return next()
    } catch (err) {
      // Fail open: this plugin must never be able to break a normal turn.
      try { logLine({ mark: 'error', message: String(err && err.message ? err.message : err) }) } catch {}
      return next()
    }
  }))

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  })
}

export { name, inject, apply }
