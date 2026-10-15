# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-15

### Added

- **Nested tiered index: a path inside a path.** The in-context index is sampled once it
  overflows `digestMaxChars`, and the sampling step is capped at 64 — so the more often a
  session folds, the coarser the index of its oldest spans becomes, ending at "somewhere in
  seqs A..B". Every fold now also writes the **unsampled** index of its range to
  `<indexDir>/<session>/f<start>-<end>.md` and leaves only that path in context. Each folded
  message carries a machine-readable marker (`[fold-index] seqs=A..B messages=N file=<path>`),
  so when it is itself folded later it becomes a **pointer line** instead of a 160-character
  stub of an index — and that pointer line is **never sampled away**, because dropping it would
  orphan every older span. A tier file also lists the tier files of the older folds it covers
  (`## older tier files`), so the chain context → tier → older tier → raw archive is walkable.
  New keys `indexTree` (default `true`), `indexDir` (`history-fold/index`) and `indexFull`
  (default `true`). A failed index write is logged as `index-failed` and does **not** block the
  fold: the archive already holds every byte, and the message then points at the raw archive.
  Three new edge tests: the tier file is written and named, the second fold nests the first
  tier, and fold-pointer lines survive sampling (baseline 74 tests → 77; mutation suite still
  11/11).

- **Window-relative thresholds: `triggerRatio` and `targetRatio`.** The two thresholds were
  absolute token counts tuned for one window size: `250000` can never be reached on a
  128k-window model (the plugin silently did nothing at all), and on a 1M window it is only a
  quarter of capacity, so the shipped compactor gets there first. Both keys take a fraction of
  the model's context window, defaulting to `triggerRatio: 0.75` and `targetRatio: 0.18` —
  this project's own absolute settings (750k / 180k) expressed relative to a 1,000,000-token
  window. `0.75` sits just under `dsh-compaction-basic`'s line (`thresholdRatio ×
  contextWindow`, `DEFAULT_THRESHOLD_RATIO = .8`, so 800k), which is what keeps its lossy
  model-written summary from ever firing; `0.18` mirrors its `DEFAULT_RETAIN_RATIO` of `.16`.
  The window comes from `ctx.llm.resolveModelInfo(provider, model, signal).context.contextWindow`
  — the same lookup the compactor uses for its own threshold — reached by the same three-path
  fallback `resolveMeter()` already uses (direct property, `ctx.reflect.get`, `agent.ctx`), so
  a missing service can never throw.
- **A documented resolution order, per key.** (1) The key is present in the raw `config.json`,
  so an explicit `triggerSurfaceTokens` / `targetSurfaceTokens` wins. (2) Otherwise, if the
  window resolves, `floor(window × ratio)`. (3) Otherwise the shipped absolute default. Two
  consequences worth stating plainly: the shipped absolute defaults **no longer apply** to any
  turn where the window resolves and no absolute key was set, and a ratio outside `(0, 1)` —
  `0`, `1`, `1.5`, `"0.75"`, `null`, `NaN` — never throws and never becomes a broken threshold;
  it falls back to rule 3 and the log line says so.
- **Observability for the resolved thresholds.** Every profile and fold log line now carries
  `windowTokens` (the resolved window, or `null`), `triggerSource` / `targetSource`
  (`absolute` | `ratio` | `default`), the resolved `trigger` / `target` in tokens, and —
  only when a configured ratio was unusable — `triggerRatioInvalid` / `targetRatioInvalid`.
  Without these there is no way to tell from the log which of the three paths ran.
- **`test/ratio-tests.mjs`**, a fourth suite (31 cases) covering the ratio path, the absolute
  override, every way the window can fail to resolve, invalid ratios, all three `llm` lookup
  paths, and the unreachable-target path. It uses a fake `ctx`/`agent` and a three-line fake
  `llm`; no real DSH service is imported. Wired into `npm test` as `npm run test:ratio`.
- **Mutation coverage for the new logic**, and for the precedence bug it exists to prevent:
  an inverted absolute/ratio precedence, a merged-config key check (which would let `DEFAULTS`
  always win and the ratios never apply), an accepted invalid ratio, and an unvalidated context
  window. `test/mutations.cjs` now runs 11 mutations across 4 suites.
- **Verified on a real DSH instance**, not only against fakes (2026-10-12, `web` profile, a
  1M-window model, sandbox instance). With a config carrying no absolute key, a turn logged
  `windowTokens:1000000`, `trigger:750000`, `target:180000`, `triggerSource:"ratio"`,
  `targetSource:"ratio"` and `via:"ctx.reflect.get|llm:ctx.reflect.get/agent.options"` — i.e.
  `llm` resolved through `ctx.reflect.get` and the provider/model through `agent.options`. The
  two resolved thresholds equal the absolute pair this project itself has been running with
  (750000 / 180000), which is where the default ratios come from.

### Changed

- **Hardening: `apply()` can no longer take a profile down.** Both registrations are now
  guarded. A build that lacks `ctx.on` / `ctx.effect`, or that refuses the registration, gets
  ONE line in `logs/history-fold.jsonl` (`mark: "deactivated"`, `reason:
  "registration-failed"`, the failing `step`, and the error) and the plugin deactivates
  instead of throwing out of `apply()` into the loader. The trigger was a real third-party
  plugin (`cancanqiqi/dsh-human-subagent`) whose `apply()` threw
  `Cannot read properties of undefined (reading 'register')` and stopped a whole DSH profile
  from booting. A failure in the second registration also disposes the first, so
  "deactivated" never leaves a half-live listener behind. Nothing on the success path
  changed; `README.md` / `README.zh-CN.md` now carry a *Requirements / compatibility* section.
- **Two regression tests for it**: a new case in `test/edge-tests.mjs` ("apply() returns
  normally when the context is hostile, and records the deactivation", five hostile contexts
  including missing services), and an 11th mutation in `test/mutations.cjs` that removes the
  `ctx.on` guard. Verified by hand, not just by the green suite: with each guard removed
  separately the new case goes red (`19 passed, 1 failed`), and with them restored it is green
  again (`20 passed, 0 failed`). The mutation harness reports 11 caught / 0 skipped.
- **Two mutation anchors updated** in `test/mutations.cjs`, because the two expressions they
  anchor on were refactored to take a resolved threshold: `if (surfaceTokens <=
  cfg.triggerSurfaceTokens)` became `if (surfaceTokens <= triggerTokens)`, and the balanced-cut
  check's `cfg.targetSurfaceTokens` became `targetTokens`. The comparisons themselves are byte
  for byte unchanged and both mutations are still caught; only the anchor text moved. The
  alternative — keeping dead indirection in `lib/index.js` purely to hold an anchor in place —
  would have been worse.

### Notes

- **Not verified against a live DSH.** Whether `ctx.llm` is reachable from this plugin's
  context was confirmed only by reading the shipped sources, not by running it. If no path
  resolves in a given build, the log records `triggerSource: "default"` and behaviour is
  exactly what it was before this change.
- `enabled: false` / `dryRun: true` are unchanged: the safe-by-default contract is intact, and
  a fresh install with no `config.json` still does nothing at all.

## [0.1.0] - 2026-10-11

First release. It folds, it archives, and the archive is verified to be lossless
against a real 608-message fold.

### Added

- **Folding.** Before a turn's first step, when the visible surface exceeds
  `triggerSurfaceTokens`, the oldest balanced run of nodes is replaced by a single
  `user/message` that carries a compact extractive index. The replacement uses the same
  mechanism as the shipped `dsh-compaction-basic`
  (`surfaceOp: { op: 'replace', start, end }` + `sourceEventSeqs`), so it takes the old
  range's position and chronology is preserved. No `node_modules` file is touched.
- **Pre-fold archive.** Every folded node is appended, verbatim, to
  `$DSH_HOME/history-fold/archive/<session>.jsonl` *before* the fold is committed. If the
  archive write fails, the fold is abandoned rather than losing history.
- **Extractive index.** The index line for each sampled node is the real prefix of its own
  text, not a model-written summary. No model call is made and nothing is rewritten.
- **Size profiling.** `profile: true` writes one per-turn line with node counts, byte and
  token breakdown by event type, and what each candidate `keepRecent` value would save.
- **Optional memory feed.** `memoryFeed` posts the same digest to a memory service
  (`POST <memoryFeedUrl>/write`) after a fold, so a folded span stays searchable from the
  assistant's own long-term memory.

### Fixed

- **The archive dropped tool-result bodies.** `textOf()` handled a `tool-result` block by
  emitting only `[tool-result <callId>]` and never descending into the block's nested
  `content`, so the archive kept a 46-character reference where the real output could be
  thousands of characters — while the same file's own comment claimed the archive was "the
  only copy that survives leaving the visible history". The archive now writes the body;
  the in-context index still uses the short stub, so per-turn context did not grow.
  Measured on a real 608-message fold: bodies preserved went from `0/300` to `298/298`,
  all message bodies from `161/461` to `456/456`, the archive from 653 KB to 947 KB, and
  the marker that enters context from 30,232 to 29,937 characters.
- **The documented safe default was not the actual default.** The `SAFETY` block promised
  that a fresh install "changes nothing at all", but `DEFAULTS` shipped
  `enabled: true` / `dryRun: false`, so installing the plugin started rewriting the
  conversation history at 250k tokens with no configuration. The defaults are now
  `enabled: false` / `dryRun: true`, matching the documentation and the `cordis.patch.yml`
  comments. Existing configs that set these keys explicitly are unaffected.
- **`folded` log lines omitted `surfaceTokens`**, although `folding` and `would-fold` both
  reported it, so a reader could not compute the post-fold remainder from one line.

### Tests

- **The test suite never ran its async assertions.** `test()` called `fn()` without
  `await`, while every case was written `await test(..., async () => { ... })`; the script
  therefore reached `process.exit(0)` before a single assertion executed, and reported
  `13 passed, 0 failed` unconditionally. `test()` is now `async` and awaits. Fixing it
  revealed **7 real failures** that had been invisible; a comparison run with the
  pre-fix library produced the identical 7 failures, so they were pre-existing and not
  caused by the folding changes.
- **The fixture contradicted its own config.** `targetSurfaceTokens: 2000` was
  unreachable given `keepRecentNodes: 9` (at least 3 fixture steps, 3150 tokens, always
  remain), so `pickEndIndex` returned `-1` and every fold case logged `no-safe-cut`
  instead of `folded`. Raised to `4000`.
- **Added regression tests** for the archive body fix and for the fresh-install safety
  contract. Both were confirmed with negative controls: reintroducing each defect turns
  the suite red, restoring the fix turns it green.
- **Added `test/edge-tests.mjs`** (19 cases) for the boundaries that matter when a plugin
  rewrites conversation history: exact-threshold behaviour (`<=`, not `<`), unreachable
  targets, both worth-folding floors, `keepRecentNodes` of 0 and larger than the surface,
  an unclosed tool call that must never be cut across, empty and single-node surfaces, a
  surface node missing from the event log, a tiny digest budget, an unreachable feed URL,
  unknown and wrong-typed config keys, a corrupt config file, `enabled:false` with
  `dryRun:false`, and a second fold in the same session.
- **Added `test/mutations.cjs`** (`npm run test:mutate`): it reintroduces six real defects
  one at a time — the dropped tool-result body, live-by-default settings, a removed
  mid-turn guard, an ignored worth-folding floor, a strict trigger comparison, and a
  dropped tool-pairing balance requirement — and fails unless the suite catches every one.
  Current result: **6 / 6 caught**. A green suite on its own proves nothing; this is what
  makes the green meaningful.

