# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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
