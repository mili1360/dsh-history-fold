# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] - 2026-10-22

Two remaining risks from the 0.6.0 review, closed.

### Fixed

- **Odd session folders no longer collide.** A folder whose name is not `session-<uuid>` used to become
  the note id verbatim, so two projects that both contain a folder named `s` shared one notes folder.
  Those now get `f_<sha1(path)[0..10]>`. Verified on the live home: 71 log files, 71 unique ids.
- **No implicit session cap.** The pass used to stop after 200 logs; the default is now "every session
  found" (`maxSessions: 0`), with a positive value as an explicit opt-in.

### Notes

- 2 new tests (id collision across projects, no default cap); suite now **126**.

## [0.6.0] - 2026-10-22

Notes were one flat folder fed by whichever session log changed last, so two windows took turns
owning the same memory.

### Changed

- **Notes are per session**: `<notesDir>/<session id>/day-*.md`. Automatic recall now searches only
  its own session's folder (`ownNotesDir`) and never pulls another window's memory in. A session
  with no folder yet falls back to the shared root, so hand-written notes and pre-split layouts
  keep working.
- **`refreshNotes` mines every session log**, not only the newest, skipping logs whose
  mtime+size stamp is unchanged (stamp file `<notesDir>/.stamps.json`). Steady state costs one
  `stat` per session.
- The `recall_memory` tool can cross sessions on purpose: `searchNotes(base, kw, { recursive: true })`
  walks one level of session folders, and results name the folder they came from.

### Notes

- 4 new tests: per-session folder isolation (two sessions must not merge), idempotent re-run across
  sessions, `ownNotesDir` fallback, recursive tool search. Suite now **123**.
- Existing flat notes were migrated into `notes/<session id>/` (backup kept).

## [0.5.1] - 2026-10-22

The notes dir reached 3.6 MB across 52 files, and every turn re-read and re-lowercased all of it.

### Changed

- **`searchNotes` keeps a parsed cache keyed on (file, mtime, size).** Notes are rewritten wholesale
  whenever the session log changes, so nearly every file is unchanged between turns; the steady-state
  cost is now one `stat` per file. Measured on the real 3.6 MB / 52-file notes dir: **167 ms cold →
  5 ms warm**. Cached files that disappear from the directory are dropped, so a pruned notes dir
  cannot pin memory.
- **Scoring counts occurrences in the whole body once per keyword** instead of lowercasing every line
  per keyword, and quotes the line that mentions the winning keyword *most often* (first on a tie)
  rather than merely the first line containing it.

### Notes

- 3 new tests (stale-cache rewrite, deletion, densest-line choice); suite now 121. Verified in the
  sandbox copy as well as in the repo.

## [0.5.0] - 2026-10-22

Recall could only ever reach what had been *folded*. Everything else -- the whole session before the
first fold, and everything after the last one -- was reachable only by reading the raw log by hand.
This release makes the plugin mine that log itself.

### Added

- **`lib/notes.js`: the session log becomes memory.** On a timer (`notes.refreshMinutes`, default
  10) the module reads the newest `sessions/**/session.jsonl.zstd` and writes markdown into
  `notes.dir` (default `history-fold/notes`), which recall already searches every turn:

  - `day-YYYYMMDD.md` -- every episode of that day: what was asked, the outcome, the paths touched.
  - `events-YYYY-MM.md` -- one line per durable statement (decision, rule, install, path, root
    cause), deduped, each with its date and seq so the day file can be opened.

  A pass only runs when the log's mtime/size changed, is deferred out of any hook's critical path,
  and a failure is logged as `notes-refresh` / `module-failed` rather than taking recall down.

- **Multi-frame zstd decoding in pure Node** (`scanZstdFrames`, `decodeSessionLog`). DSH appends one
  zstd frame per write batch and `zlib.zstdDecompressSync` stops after the first frame -- measured:
  the 27.4 MB live log decodes to 183 bytes that way, versus 108 MB / 111k lines / 15,740 frames in
  1.1 s by walking frame and block headers. No Python sidecar required. A torn final frame (normal
  for a live log) costs that frame only.

### Fixed

- **Embedding-dimension drift no longer ranks garbage.** The cache is validated against the query
  vector's length, so vectors from a different model are rebuilt instead of scoring every row at
  ~0.1 (measured 0.115 before, 0.669 after).
- The background vector builder wrote its cache to a path missing the model name, so a completed
  build was never read again. It now goes through the same `cachePathOf` as every other reader and
  writer.

### Notes

- 13 new tests (`test/notes-tests.mjs`; suite now 118). Sandbox run logged
  `notes-refresh ok:true ms:165 written:4` inside a real DSH process.

## [0.4.0] - 2026-10-18

Recall stopped being a keyword grep and became an actual retrieval layer.

### Added

- **Semantic retrieval through a local embedding service** (`lib/semantic.js`).
  Config `recall.semantic.endpoint` (default `http://127.0.0.1:8021/v1/embeddings`) and `model`.
  Vectors are cached next to each archive as `<archive>.<model>.vec.json`, keyed per row, so a fold
  only embeds the new rows. A large backlog is embedded in the background: the hook uses whatever
  is already cached and never waits. Any failure falls back to the gram matcher, so a stopped
  embedding service changes nothing but quality.

  The rule is *relative*, not a fixed cutoff: bge-small scores Chinese chat in a narrow 0.45-0.60
  band, so the best row must clear `minScore` **and** beat the median by `minMargin`.

- **`recall_memory(query, limit)` -- an explicit door.** The hook decides what to inject on its
  own; this lets the model ask. Registered when the build exposes `ctx.tools` (hence the new
  `export const inject = ['tools']`). A missing archive answers `hits: 0` instead of throwing.
  It uses looser thresholds than the hook (0.35, no margin), because the caller asked and can
  judge the results.

- **Two queries per search**: the raw sentence and the keyword join, merged by best score.
  Measured on the real archive, each won different questions.

### Changed

- The keyword gate only skips genuinely short messages (<12 chars after stripping meme captions).
  Embeddings take the whole sentence, so a sentence with few extractable keywords is still
  searchable; the gram matcher still requires `minKeywords`, because it has nothing else.
- The injected block now tells the model that `recall_memory` exists, so an injection is a door
  rather than a dead end.

### Fixed

- A skipped recall logs why (`recall-skip` with the shape of the visible tail), instead of looking
  identical to a broken plugin.
- Question words and repeated-character spam are not search terms; any 2-gram that appears inside
  a stopword is dropped too (`为什么` no longer becomes `为什` / `么是`).
- Meme captions (`[表情: ...]`) never become search terms, and an archive row that only carries
  one cannot count as a hit.
- The vector cache is keyed by model name: mixing bge-small (512-dim) and bge-base (768-dim)
  vectors ranked everything at 0.08.

## [0.3.0] - 2026-10-18

The plugin now has two modules. `lib/fold.js` is the fold, unchanged in behaviour; `lib/recall.js`
is new and does the thing the fold's index has always promised but never delivered: it actually
goes and looks.

### Added

- **A second module: automatic recall (`lib/recall.js`).**

  The fold replaces old history with an index that says "the full text is archived at …". Whether
  anyone ever follows that pointer was left to the model's judgement — and measurement settled
  it: this plugin had been loaded for ten days with `folding` at 0 and nobody ever opened its
  log. A mechanism that depends on remembering to use it is not a mechanism.

  So on each turn's first step, recall takes the user's message, extracts keywords (latin words
  plus overlapping 2-character CJK grams, with a stopword list), greps the session's own archive
  and optionally a directory of markdown notes, and injects at most `maxChars` of excerpts — each
  one tagged with the path of its source. Nothing is injected on chit-chat, and every skip that
  is not obvious writes a `recall-skip` line explaining itself.

  It prefers `agent.inject()` over `agent.steer()`: both deliver at the next step
  (`dsh-agent-loop`: `steer` wakes the driver, `inject` does not), and we are already inside a
  running turn, so there is nothing to wake.

- **Meme captions are never search terms.** Live measurement: a one-word reply carrying
  `[表情: 室内实景背景，女仆装半身…]` produced the keywords 表情/室内/内实/实景/景背/背景 and
  pulled back three archived meme captions. Archive rows are now scored against the text with
  captions stripped, so a node that only carries one cannot count as a hit.

### Changed

- **One plugin, two files, with separate failure domains.** `lib/index.js` applies both modules
  with independent `try/catch` blocks and logs `module-failed` when either throws: the fold
  failing is the worst case (lost history), recall failing is a missed hint, and one must never
  cause the other. Each module has its own `enabled`.
- `recall` configuration lives under a `recall` key in the same `config.json`; the fold's keys are
  untouched, so existing installations keep working without edits.

### Fixed

- `lastUserText` reads `data`, `data.message` and `data.payload`, and accepts `text`, `content`
  as a string, or a content array. The first live run produced no recall lines at all because a
  shape it did not recognise returned `""` and the handler skipped in silence.

## [Unreleased]

### Changed

- **The shipped defaults are no longer inert: `enabled: true`, `dryRun: false`.**

  The old defaults (`enabled: false`, `dryRun: true`) meant that installing this plugin changed
  nothing at all — the very thing it exists to do, keeping the request small, could only begin
  after a reader found the config file, wrote two keys and restarted. A plugin whose whole
  purpose is to fold should not install itself into a no-op. Reporting it as "safe by default"
  hid that: there is no such thing as safety in a plugin that never acts.

  What actually bounds the fold was always elsewhere, and it still does: the fold can only fire
  above `triggerRatio` (0.75 of the model's context window, just below the built-in compactor's
  0.8), every folded node is archived verbatim **before** the fold, and a failed archive write
  aborts the fold instead of losing history. So the default now means "act only in the last
  quarter of a window, and never lose a byte" rather than "never act".

  Two consequences worth stating plainly:

  - **A fresh install profiles from the first turn and writes to
    `~/.dsh/logs/history-fold.jsonl`.** Nothing else is created until a window is 75% full.
  - `dryRun: true` is still supported and now means what it says — observe without writing.
    A config that omits these keys inherits the new defaults; a config that sets them
    explicitly is unaffected, so no existing installation changes behaviour on upgrade.

### Added

- **A second chance at 0.8 of the window: `emergencyTriggerRatio`.**

  A bounded fold above the trigger cannot normally fail to land: it takes the oldest run all
  the way to `lastFoldableIdx` in one step. Three narrow things can still leave the surface
  climbing — `keepRecentNodes` covering the entire foldable span, `minFold*` refusing a small
  fold, or an archive write aborting the fold by design. Where automatic compaction is turned
  off (a preset with `compaction-basic` at `auto: false`), that gap has no backstop at all.

  So when the next turn still finds the surface at or above `emergencyTriggerRatio` (0.8, i.e.
  800k of a 1M window), the fold is retried with `emergencyKeepRecentNodes` (12 instead of 60)
  and the floors lowered to `emergencyMinFoldNodes` / `emergencyMinFoldTokens` (4 / 2000). The
  mechanism is unchanged — verbatim archive first, no split of a tool-call/tool-result pair,
  still only at a turn's first step — it just holds less recent history back. Every line from
  that path carries `emergency: true`, and the resolved line is clamped to `max(emergency,
  trigger)` so the second chance can never fire alongside the first.

  Pinned by two tests: one where the recent window blocks the normal attempt and the retry
  folds, and its control where the same session sits below the emergency line and must be left
  alone.

## [0.2.2] - 2026-10-15

### Fixed

- **The npm tarball now ships `test/`.** The `files` field left it out, so the suites were
  missing from the published package while both READMEs tell a reader to run `npm test` to
  check the install — an instruction that could not have worked for anyone installing from
  npm. First release on npm, so 0.2.1 was never published; this ships as 0.2.2 instead of
  re-pointing an existing tag.

## [0.2.1] - 2026-10-15

### Fixed

- **Four DSH 0.2.0 API changes are handled** (found live on `0.2.0-rc.2`, sandbox #2 /
  port 3082, where a fold really does get applied):
  1. **The event accessor moved.** 0.1.x exposes `session.events`, an array whose entries carry
     their own `seq`. 0.2.0 has no such member (only a private `eventsSnapshot`); its log is
     POSITIONAL — `eventAt(seq)` is literally `log[seq]` — with `snapshotEvents()` for a frozen
     copy. `eventMap()` now tries all three. Before the fix the profile line read
     `byType:{"unknown":{"n":20,"bytes":0}}`: every node unresolvable, which makes
     `balancedCuts` refuse every cut, so the plugin logged `no-safe-cut` forever and **never
     folded once** — with no error anywhere.
  2. **The surface-replace range keys were renamed.** 0.1.x wants `{op:'replace', start, end}`;
     0.2.0's `isReplaceOp` wants exactly `{op, startSeq, endSeq}` and **throws** on anything
     else. Both validations run before the event reaches the log, so `appendFold()` picks the
     shape by host (`session.events` present ⇒ 0.1.x) and keeps the other as a fallback; the
     log line records which one worked as `surfaceOpKeys`.
  3. **0.2.0 protects node 0.** It puts the system prompt in the surface and refuses any
     replace that reaches it (`dsh-session`: "node 0 holds the system prompt and may be
     rewritten only by a system/message over exactly that node"). The fold now starts after
     that head, and the head's tokens stay in the reach-the-target arithmetic — folding below
     the system prompt's own size is legitimately `no-safe-cut`.

  Four new edge tests pin these (positional log, `startSeq`/`endSeq`, the old `start`/`end`
  shape, and the protected head). Suite: 81 passed (was 77).

  4. **v4 RETIRES the `{kind:'plugin', plugin:X}` message source — and refuses it at ROW
     ADMISSION, not at append.** `dsh-session-format-v3-to-v4` states it outright:
     `format v4 message requires a producer-owned source kind` (its `source()`, which rejects
     `kind === 'plugin'`), and its own migration rewrites that wrapper into the producer's kind,
     which for a third-party plugin is **`plugin:<name>`** (`producerKind()`, `:92`:
     `return \`plugin:${plugin}\``). The failure is the worst kind: `session.append` returns
     normally, the archive and tier file are written, the new surface is live — and then the
     turn never ends. `sessionStats.turns` stops incrementing, `projections.asOfSeq` runs ahead
     of the persisted log, `session.v4.jsonl.zstd` is never rewritten again, and **every later
     turn on that session hangs too**. Nothing is logged by the host, and the same fold with
     `source.kind === 'user'` completed every turn — that is how the field was isolated.
     `foldSource()` now emits `plugin:<name>` on v4 and keeps the old wrapper on 0.1.x, and
     `foldMessageOf()` recognises BOTH spellings (without that, a v4-spelled earlier fold is not
     recognised, so the nesting silently never happens — `subTiers` stays 0).

  Seven new edge tests pin these. Suite: 84 passed (was 77).

  Verified end to end on `0.2.0-rc.2` (sandbox #2, port 3082): three consecutive folds, every
  turn completing (`turn/end` for turns 1–19), the archive and tier files written, the folded
  message **persisted** to `session.v4.jsonl.zstd`, the session **reloaded after a restart and
  kept folding**, and the nested tier link present on disk (`fold-pointer` inside
  `## older tier files`).

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

