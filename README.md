# dsh-history-fold

A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin that folds the **oldest**
part of a session's visible history into a single message backed by a **lossless local
archive**, so a long session stops paying for its entire history on every request.

- **Inert by default.** A fresh install reads nothing, writes nothing and logs nothing
  until you configure it.
- **Lossless.** Every folded message is written to a local archive *before* the fold is
  committed, and the replacement tells the model exactly where to look.
- **No `node_modules` patching.** It uses the same public surface-replacement mechanism as
  the shipped compactor, so a DSH upgrade cannot break it.

---

## Why

Measured on one machine, a long session against a fresh one:

| | long session | fresh session |
|---|---|---|
| history tokens | 497,141 | small |
| output / input ratio | 0.20% | 0.64% |
| decode speed | 59 tok/s | 176 tok/s |
| time to first token | ~2.5 s | ~2.5 s |

So context length does **not** slow the first token; it slows **decode**, because attention
runs over the whole KV cache. Shrinking the visible history is what brings the decode rate
back.

## What it does

Before a turn's first step, if the visible surface is above `triggerSurfaceTokens`, the
plugin:

1. Picks the oldest run of nodes that ends on a tool-pairing **balanced** cut, leaves at
   least `keepRecentNodes` behind, and brings the surface down to about
   `targetSurfaceTokens`.
2. **Archives** every folded node, verbatim, to
   `$DSH_HOME/history-fold/archive/<session>.jsonl`. If this write fails the fold is
   abandoned — history is never dropped without a copy on disk first.
3. Replaces that range with **one** `user/message`, using the same mechanism as the shipped
   compactor:

   ```js
   session.append('user/message', message, {
     surfaceOp: { op: 'replace', start, end },
     sourceEventSeqs: [/* every shadowed seq */],
   })
   ```

   `dsh-session` then splices the replacement into the old range's position, so chronology
   is preserved and the conversation still reads in order.

## The replacement is an index, not a summary

The message that enters the context window is a **notice plus an extractive index** — every
sampled line is the real prefix of that message's own text. **No model is called**, and
nothing is paraphrased:

```
[dsh-history-fold] 614 earlier messages (surface seqs 223995..387899) were folded out of the
visible history so this session stays fast.
NOTHING WAS DELETED. Their full text is archived at:
  /…/.dsh/history-fold/archive/session-….jsonl
To read any of it verbatim, search that file with the pwsh or grep tools, for example:
  rg -n "search words" "/…/.dsh/history-fold/archive/session-….jsonl"
The one-line index below is extractive, not a rewritten summary: read it to find what you
need, then search the archive for the exact text. Do not guess about folded content.
(sampled: every 3th of 614 folded messages)
[0] user/message (plugin) seq=223995: This is an automatically generated checkpoint …
[3] assistant/message (model) seq=224097: Now the fireWeapon for bolt does a spread burst …
```

If the index would exceed `digestMaxChars` it samples every *n*-th line rather than
truncating, and says so.

**Measured** on a real 1,210-turn session (surface 213,919 tokens):

| | |
|---|---|
| folded | 614 messages / **184,709 tokens / 86.3%** |
| marker that enters context | 30,232 characters (~7.5k tokens) — about 24:1 |
| archive written | 638 KB |
| user-authored text preserved | **verbatim** |
| assistant text preserved | verbatim (the archive is a superset — it also keeps reasoning) |

Because the archive holds the real text and the marker tells the model to search it, folded
content stays recoverable. Asked about a specific change that lived in the folded range, the
model read the archive and answered with the exact values; where content genuinely was not
in context it answered "not in context" instead of guessing.

## Install

This is a plugin for a DSH profile. Add it to the profile — the same layer every other DSH
plugin uses.

1. Make the package resolvable by your profile, then add it to the profile manifest
   `~/.dsh/profiles/<profile>/package.json`:

   ```json
   {
     "dependencies": { "dsh-history-fold": "link:/path/to/dsh-history-fold" },
     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-history-fold"] } }
   }
   ```

   Or, using the explicit patch layer, append to
   `~/.dsh/profiles/<profile>/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: history-fold
         name: 'file:///path/to/dsh-history-fold/lib/index.js'
   ```

2. **Restart DSH.** Plugin rows load at boot.

3. Nothing will happen yet — the defaults are inert. Turn it on by writing
   `~/.dsh/dsh-history-fold/config.json`:

   ```json
   { "enabled": true, "dryRun": true }
   ```

   `dryRun: true` logs what it *would* fold without writing anything. Watch
   `~/.dsh/logs/history-fold.jsonl` until the numbers look right, then set
   `"dryRun": false`.

To remove it, delete the row you added and restart. Nothing else is left behind; the archive
directory is the only thing this plugin creates.

## Configuration

`$DSH_HOME/dsh-history-fold/config.json` (falling back to `~/.dsh/…`). **It is re-read on
every turn**, so edits apply without a restart.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. `false` ⇒ loaded but completely idle. |
| `dryRun` | `true` | `true` ⇒ observe and log only, never write. |
| `profile` | `true` | Write one size/profile line per turn. |
| `triggerSurfaceTokens` | `250000` | Fold only above this much visible history. |
| `targetSurfaceTokens` | `180000` | Fold down to about this much. Must be reachable — see below. |
| `keepRecentNodes` | `60` | Never fold the most recent this-many nodes. |
| `minFoldNodes` | `20` | Refuse to fold fewer nodes than this. |
| `minFoldTokens` | `20000` | Refuse to fold fewer tokens than this. |
| `archive` | `true` | Write the lossless pre-fold archive. Leave this on. |
| `archiveDir` | `history-fold/archive` | Relative to `$DSH_HOME`. |
| `digestMaxChars` | `30000` | Cap on the in-context index. Over budget ⇒ sample, never truncate. |
| `digestLineChars` | `160` | Characters of each sampled message shown in the index. |
| `onlyAtTurnStart` | `true` | Fold only before a turn's first step, never mid-turn. |
| `logFile` | `logs/history-fold.jsonl` | Relative to `$DSH_HOME`. |
| `memoryFeed` | `false` | Post the same digest to a memory service after each fold. |
| `memoryFeedUrl` | — | e.g. `http://127.0.0.1:7999/memory-eternal/api`. |

> **`targetSurfaceTokens` must be reachable.** At least `keepRecentNodes` nodes always stay,
> which is at least that many steps' worth of tokens. A target below that floor can never be
> met and the plugin will log `no-safe-cut` every turn.

### Relation to the built-in compactor

`dsh-compaction-basic` compacts at `thresholdRatio × contextWindow` — `0.8 × 1,000,000`, so
800k — and keeps `0.16 × window` (160k). Its replacement is a **model-written summary**,
which is lossy. Keeping this plugin's trigger well below 800k is what stops that summarizer
from ever firing.

## Log

`$DSH_HOME/logs/history-fold.jsonl`, one JSON object per line:

| `mark` | Meaning |
|---|---|
| `profile` | Per-turn size/token breakdown, plus what each candidate `keepRecent` would save. |
| `profile-error` | Profiling itself failed. |
| `idle` | Below `triggerSurfaceTokens`; nothing to do. |
| `would-fold` | `dryRun` — this is what *would* have been folded. |
| `folding` / `folded` | A real fold started / committed. Both carry `surfaceTokens`, `foldTokens`, `startSeq`, `endSeq`. |
| `no-safe-cut` | No balanced cut reaches the target, or the minimums were not met. |
| `no-meter` | The token meter was unreachable, so it refused to fold blind. |
| `archive-failed` | The archive write failed, so the fold was abandoned. |
| `error` | Anything else. The hook always fails open — a turn is never blocked. |
| `fed` | The digest was posted to the memory service (`memoryFeed`). |

## Safety model

- **Inert by default.** With no config file, nothing is read, written or logged.
- **Archive before fold.** A fold commits only after its full text is on disk.
- **Balanced cuts only.** A tool call never crosses a fold boundary.
- **Balanced failures only.** A missing token meter, an unreachable session or an archive
  error all skip the fold and log it, rather than guessing.
- **Turn boundary only.** `onlyAtTurnStart` keeps a fold from ever landing mid-turn.
- **Nothing is paraphrased.** The index is extraction; only the pointer message is
  synthetic, and it is labelled `source.kind = 'plugin'`.

## Tests

```bash
npm test            # both suites
npm run test:fold
npm run test:profile
```

They run fully offline: no DSH, no network, no API key, and a throwaway `DSH_HOME` under
`os.tmpdir()`. The archive fix and the fresh-install safety contract both have regression
tests, each confirmed with a negative control (reintroducing the defect turns the suite red;
restoring the fix turns it green).

> **For contributors:** `test()` **must** `await fn()`. A synchronous harness reports `ok`
> before any async assertion runs, and lets the script reach `process.exit(0)` first — which
> silently turns the whole suite into a no-op. This project shipped that bug for a while; see
> `CHANGELOG.md` for the failure mode and how it was detected.

## Limitations

- Tuned and measured against DeepSeek Harness on Windows with a 1,000,000-token context
  window. The mechanism is adapter-agnostic; the default thresholds are not.
- Token counts come from DSH's `tokenMeter`. If it is unavailable the plugin does nothing —
  by design.
- Folding reduces what the model sees. The archive keeps it recoverable, but reading it back
  costs a `rg` round-trip.
- It does not (yet) coordinate with `dsh-compaction-basic`; it simply stays below its
  trigger.

## License

MIT — see [LICENSE](LICENSE).

中文说明见 [README.zh-CN.md](README.zh-CN.md)。
