# dsh-history-fold

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-community%20topic-blue)](https://github.com/topics/dsh-plugin)
[![deepseek-harness](https://img.shields.io/badge/deepseek--harness-plugin-4b6bfb)](https://github.com/topics/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> **Topics:** `dsh` · `dsh-plugin` · `deepseek-harness` · `history-fold` · `lossless-archive` ·
> `context-compaction` · `non-summary` · `recoverable` · `extractive-index`

**Is a long DSH session costing you more on every single turn — and getting slower while it
does?**

Every request re-sends the whole visible history, and a context window is billed by the token.
A conversation a few hundred turns deep pays for all of them, every time, whether or not any of
it is still relevant.

This plugin folds the **oldest** part of that visible history into a single message backed by a
**lossless local archive** — the request gets smaller, and nothing is thrown away.

- **Inert by default.** A fresh install reads nothing, writes nothing and logs nothing
  until you configure it.
- **Lossless.** Every folded message is written to a local archive *before* the fold is
  committed, and the replacement tells the model exactly where to look.
- **No `node_modules` patching.** It uses the same public surface-replacement mechanism as
  the shipped compactor, so a DSH upgrade cannot break it.
- **Also works on DSH 0.2.x** (`0.2.0-rc.2`, `0.2.1-rc.2`), which changed four things this plugin
  depends on — two of which fail silently. See
  [DSH 0.2.x](#dsh-02x-0200-rc2--021-rc2--supported) for what changed and how each was measured.
- **Declares what it supports.** `engines.dsh` is set to `>=0.1.0-rc.2 <0.3.0-0`, so a loader that
  checks compatibility can tell you *before* mounting it rather than after it misbehaves.

---

## What's new in 0.8.0 — it learned when *not* to interrupt you

Recall only helps if it fires at the right moment. The old gate was a regex: if the message
contained a rare identifier or a word like "last time", go look something up. Measured against
**659 hand-labelled turns** from this project's own 4,906-message history, that regex fired on
**22% of turns that did not need it** — a wall of old notes arriving in the middle of ordinary
conversation.

0.8.0 adds a **659-example classifier** (character n-grams + logistic regression, `lib/gate.js` +
`model/gate-model.json`) that reviews the rule's decision:

| Measured on 659 hand-labelled real turns | Rule alone | With the classifier |
|---|---|---|
| Turns that genuinely need the archive, admitted | 49/87 (56%) | **51/87 (59%)** |
| Turns that do **not**, falsely triggered | 126/572 (**22.0%**) | **43/572 (7.5%)** |

Both numbers move the right way — which is the only reason it ships. A filter that bought precision
by giving up recall would have been useless here.

Then the whole decision chain was run over **all 3,431 usable user messages** in that history,
three ways:

| Route | Fires | Fire rate | Tokens injected |
|---|---|---|---|
| 0.7 behaviour (strict) | 670 | 19.5% | ≈709k |
| 0.8 rules, no classifier | 2,377 | **69.3%** | ≈2.59M |
| **0.8 + classifier** | **289** | **8.4%** | **≈316k** |

Without the classifier the plugin was injecting old notes on **one message out of three**.
With it, the fire rate lands in the 10–15% band where the annotated data says real demand is —
and the injected volume drops **8×**.

The properties that made it shippable rather than merely interesting:

- **1.3 MB, zero dependencies.** Plain JS over a JSON weight table: no ONNX, no runtime, no Python,
  no network call, no API cost. Inference is sub-millisecond; total recall overhead is 44–53 ms.
- **A filter, not an oracle.** It sits on top of the existing rules and can only *veto* them when it
  is confident a turn is noise. Explicit recall intent ("what did we decide last time…") never
  reaches it.
- **Missing model = unchanged behaviour.** If `model/gate-model.json` is absent or unreadable the
  layer is skipped and the rules decide exactly as in 0.7. Nothing is silently disabled, nothing
  silently enabled.
- **Trained on this project's own conversations**, not a public benchmark. That is also its limit —
  see [Limitations](#limitations).

Also in 0.8.0: note scoring is TF-IDF weighted (top-3 on 20 rewritten questions went **7 → 12**),
`recall.strict` no longer silently abandons a question, and every injection logs the question plus
the note files it hit — the raw material for training on real usage later.

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

Before a turn's first step, if the visible surface is above the trigger — `triggerRatio ×
contextWindow`, or an explicit absolute `triggerSurfaceTokens`, see
[how the thresholds are resolved](#how-the-two-thresholds-are-resolved) — the plugin:

1. Picks the oldest run of nodes that ends on a tool-pairing **balanced** cut, leaves at
   least `keepRecentNodes` behind, and brings the surface down to about the target
   (`targetRatio × contextWindow`, default `0.18`).
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

**If that fold did not land, there is a second chance.** When the next turn still finds the
surface at or above `emergencyTriggerRatio` (0.8 of the window, 800k on a 1M window), the
normal attempt clearly did not bring it down — `keepRecentNodes` covered the whole foldable
span, the `minFold*` floors refused a small fold, or an archive write failed and the fold was
abandoned. The plugin then retries with the recent window cut back to
`emergencyKeepRecentNodes` (12) and the floors lowered to `emergencyMinFoldNodes` /
`emergencyMinFoldTokens`. It is the same bounded fold: the same archival of every node, the
same refusal to split a tool-call/tool-result pair. It just stops being polite about how much
history it holds back — and every line of that fold carries `emergency: true` in the log, so a
reader can tell the two paths apart afterwards.

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

## Nested paths: a path inside a path

The in-context index is **sampled** once it overflows, and the sampling step is capped at 64 —
so the more often a session folds, the coarser the index of its oldest spans becomes, until an
old span is reduced to "somewhere in seqs A..B". That is the part that does not scale.

So every fold now does one more thing: it writes the **unsampled** index of the range to disk
and leaves only its **path** in context.

```
the folded message in context
  |- path -> $DSH_HOME/history-fold/index/<session>/f100-4500.md  <- full index of that range
  |            \-- path -> f20-99.md                              <- an earlier fold's full index
  |                         \-- path -> f0-19.md
  \-- path -> $DSH_HOME/history-fold/archive/<session>.jsonl      <- the raw text of everything
```

Two rules make the chain hold:

1. **Each folded message carries a machine-readable marker:**
   `[fold-index] seqs=A..B messages=N file=<tier index path>`. When that message is itself
   folded later, the marker is parsed back out — so the older span is represented by a
   **pointer**, not by a 160-character stub of an index.
2. **That line is never sampled away.** Sampling drops ordinary message lines only. Dropping a
   fold-pointer would silently *orphan* everything older than it: nothing left in context
   could reach it.

Every tier file is self-contained on disk, and it lists the tier files of any **older** folds
that it covers (`## older tier files`). Context keeps the shortest layer; walking down the
paths reaches the raw text. Reading a tier file costs nothing until it is read — and it is
never read unless it is needed.

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

One command, straight from the repository:

```bash
dsh plugin add --profile web github:mili1360/dsh-history-fold
```

> **Install from git, not npm.** This package is not on the npm registry yet, so
> `npm install dsh-history-fold` will 404. The git form above is the supported path and is what
> the maintainer uses; it resolves the repo directly and needs no registry at all.

Prefer a pinned, immutable artifact? Every release ships its tarball, no registry involved:

```bash
dsh plugin add --profile web https://github.com/mili1360/dsh-history-fold/releases/download/v0.8.1/dsh-history-fold-0.8.1.tgz
```

That resolves the package over git, adds it to the profile's `dependencies`, and registers
the bundle in `dsh.profile.bundles` on its own — verified on `0.2.0-rc.2`. Then **restart
DSH**: a registered bundle is only picked up at boot.

Works the same way from a local clone, if you would rather build from source:

```bash
git clone https://github.com/mili1360/dsh-history-fold.git
dsh plugin add --profile web ./dsh-history-fold
```

<details>
<summary>Doing it by hand instead</summary>

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

3. **It is already on.** The shipped defaults fold for real — but only above `triggerRatio`
   (0.75 of the model's context window), which sits just below the built-in compactor's 0.8, and
   every folded node is archived verbatim before it leaves the visible history. Installing it
   therefore does not leave the request untouched: it profiles from the first turn and folds once
   a window is 75% full.

   To watch it without letting it write anything, create
   `~/.dsh/dsh-history-fold/config.json`:

   ```json
   { "dryRun": true }
   ```

   `dryRun: true` logs what it *would* fold without writing anything. Watch
   `~/.dsh/logs/history-fold.jsonl` until the numbers look right, then set
   `"dryRun": false` again (or delete the file and the default takes over).

To remove it, delete the row you added and restart. Nothing else is left behind; the archive
directory is the only thing this plugin creates.

</details>

## Requirements / compatibility

**After installing, confirm it actually works — a profile that boots is not proof.**
A plugin can load cleanly, serve its routes and still break the host; we have seen exactly
that. So the acceptance test is: **create a new session and send it one message**, then check
`$DSH_HOME/logs/history-fold.jsonl` for a `profile` line (observer mode) or an
`idle` / `would-fold` / `folded` line. If new sessions cannot be created at all, remove
the mount line above and restart.

Developed and tested against DSH **`0.1.0-rc.7`** — a **customised** build, not a stock
upstream release. Another version may register its services or name its events differently:
this plugin touches `ctx.on`, `ctx.effect`, `ctx.tokenMeter`, `ctx.reflect`, `ctx.llm` and the
`agent/pre-step` event.

### DSH 0.2.x (`0.2.0-rc.2`, `0.2.1-rc.2`) — supported

Verified on 0.2.0 end to end: three consecutive folds, every turn completing, the folded
message persisted to `session.v4.jsonl.zstd`, the session reloaded after a restart and kept
folding, and the nested tier link present on disk.

On 0.2.1-rc.2 the plugin was mounted into a clean profile in its own `DSH_HOME` and came up
(log line `{"mark":"boot","plugin":"dsh-history-fold","version":"...","tools":true}`), which
also proves `ctx.tools` is available there. Its hook signatures are unchanged in 0.2.1-rc.2:
`tools/pre-execute (exec, next)`, `tools/post-execute (exec, result, next)`,
`session/event (session, event)`. One thing to know: **`agent/pre-step` does not exist in
0.1.0-rc.8 at all** (the string appears only in comments there) and does exist in 0.2.1 — so a
listener on it is inert on 0.1.x and becomes live after the upgrade.

Four of its API changes had to be handled, and three of them fail **silently**:

| what changed | 0.1.x | 0.2.0 | if you get it wrong |
|---|---|---|---|
| event accessor | `session.events`, entries carry `seq` | **no such member**; the log is positional (`eventAt(seq)` is `log[seq]`), plus `snapshotEvents()` | every node reads as `unknown` / 0 bytes, no cut is ever balanced, `no-safe-cut` forever — **no error** |
| surface-replace range | `{op:'replace', start, end}` | `{op:'replace', **startSeq, endSeq**}` | `isReplaceOp` **throws**: the fold is rejected |
| surface head | no system message in the surface | **node 0 is the system prompt and is protected** | any replace reaching node 0 **throws**: "may be rewritten only by a system/message over exactly that node" |
| message `source` | `{kind:'plugin', plugin:X}` | **that wrapper is retired**; a message needs a producer-owned kind — `plugin:<name>` for a third-party plugin | the append **succeeds**, then ROW ADMISSION throws when the log is written ⇒ the turn **never ends**, the session stops persisting, and every later turn hangs too. Nothing is logged |

The plugin picks the replace shape and the source spelling by host, and starts the fold *after*
the protected head; the head's tokens stay in the reach-the-target arithmetic. Log lines name
what was used (`surfaceOpKeys`) and how many leading nodes were skipped (`protectedCount`).

If your build does not match, the plugin **deactivates and says so** — it does **not** stop the
profile from booting. Nothing is registered, and one line lands in
`logs/history-fold.jsonl`:

```json
{"mark":"deactivated","reason":"registration-failed","step":"services","error":"..."}
```

**If the profile will not start at all after installing**, remove the mounted lines from
`<profile>/cordis.patch.yml` (or drop `"dsh-history-fold"` from `dsh.profile.bundles`, if that
is how you installed it) and restart:

```yaml
- insert:
    - id: dsh-history-fold
      name: 'file:///path/to/dsh-history-fold/lib/index.js'
```

## Configuration

`$DSH_HOME/dsh-history-fold/config.json` (falling back to `~/.dsh/…`). **It is re-read on
every turn**, so edits apply without a restart.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` ⇒ loaded but completely idle. |
| `dryRun` | `false` | `true` ⇒ observe and log only, never write. |
| `profile` | `true` | Write one size/profile line per turn. |
| `triggerSurfaceTokens` | `250000` | Absolute trigger, as a fallback — see the resolution order below. Explicit here ⇒ wins. |
| `targetSurfaceTokens` | `180000` | Absolute target, as a fallback. Explicit here ⇒ wins. Must be reachable — see below. |
| `triggerRatio` | `0.75` | Fold only above this fraction of the model's context window. Scales with the window; used whenever the window resolves and no absolute key is set. |
| `targetRatio` | `0.18` | Fold down to about this fraction of the window. |
| `emergencyTriggerRatio` | `0.8` | Second chance. Still at or above this fraction of the window at the next turn ⇒ the normal attempt did not land, so retry with the relaxed limits below. |
| `emergencyTriggerSurfaceTokens` | `800000` | Absolute form of the second chance, used when the window cannot be resolved. Never allowed below the normal trigger. |
| `emergencyKeepRecentNodes` | `12` | How much recent history the retry is still allowed to protect (the smaller of this and `keepRecentNodes` wins). |
| `emergencyMinFoldNodes` | `4` | Retry floor on node count. |
| `emergencyMinFoldTokens` | `2000` | Retry floor on folded tokens. |
| `keepRecentNodes` | `60` | Never fold the most recent this-many nodes. |
| `minFoldNodes` | `20` | Refuse to fold fewer nodes than this. |
| `minFoldTokens` | `20000` | Refuse to fold fewer tokens than this. |
| `archive` | `true` | Write the lossless pre-fold archive. Leave this on. |
| `archiveDir` | `history-fold/archive` | Relative to `$DSH_HOME`. |
| `digestMaxChars` | `30000` | Cap on the in-context index. Over budget ⇒ sample, never truncate. |
| `digestLineChars` | `160` | Characters of each sampled message shown in the index. |
| `indexTree` | `true` | Write the tier index and name its path in context. Off ⇒ the old sample-only behaviour. |
| `indexDir` | `history-fold/index` | Tier index directory, relative to `$DSH_HOME`. |
| `indexFull` | `true` | Write the **unsampled** index to disk. Off ⇒ collect pointers but write no new file. |
| `onlyAtTurnStart` | `true` | Fold only before a turn's first step, never mid-turn. |
| `logFile` | `logs/history-fold.jsonl` | Relative to `$DSH_HOME`. |
| `memoryFeed` | `false` | Post the same digest to a memory service after each fold. |
| `memoryFeedUrl` | — | e.g. `http://127.0.0.1:7999/memory-eternal/api`. |
| `notes.enabled` | `true` | Mine the session log into `notes.dir` on a timer. Off ⇒ no mining at all. |
| `notes.dir` | `history-fold/notes` | Where the markdown lands. Relative to `$DSH_HOME` unless absolute. |
| `notes.refreshMinutes` | `10` | How often the log's mtime/size is checked. A pass runs only when it changed. |
| `notes.events` | `true` | Also write `events-YYYY-MM.md` (the durable-statement ledger). |
| `notes.minEventScore` | `3` | Strictness of the ledger. Raise to 4 for fewer, cleaner lines. |
| `notes.startDelayMs` | `45000` | First pass waits this long so boot is never slowed. |
| `notes.maxLogMB` | `600` | Safety valve: a bigger log is skipped rather than read into the heap. |
| `recall.strict` | `false` | `true` ⇒ the precise layer (entity map / rare identifiers) is tried first. **Since 0.8.0 this no longer ends the turn when it finds nothing** — it falls back to the broad path. Set `recall.fallback: false` for the pre-0.8 “inject nothing” behaviour. |
| `recall.fallback` | `true` | `false` ⇒ a strict-mode miss injects nothing (old behaviour). |
| `recall.fallbackMinChars` | `12` | A message shorter than this only falls back when it carries recall intent (see `recall.gateThreshold`). |
| `recall.gateThreshold` | `0.45` | Confidence the bundled classifier must reach for a plain question to proceed. Lower ⇒ more lookups and more noise; `0` disables the filter. The model is `model/gate-model.json`; if it is missing the layer is skipped and rules apply unchanged. |
| `recall.gateModel` | *(bundled)* | Override the classifier path. |
| `recall.titleWeight` | `2` | Multiplier when a matched term also appears in a `##` heading. |
| `recall.entityMapFile` | `dsh-history-fold/entity-map.json` | JSON table of `{key, file, line, title}`. A key that appears in the user's message serves that exact location, no scoring. Edit the file to teach it a topic. |
| `recall.rareMaxDf` | `2` | A rare identifier must appear in at most this many note files to be used as a locator. |
| `recall.entityMapAutoFile` | `dsh-history-fold/entity-map.auto.json` | The **auto-built** table. Rebuilt from the notes, never hand-edited. |
| `recall.autoMapMinutes` | `30` | Rebuild the auto table when it is older than this. |
| `recall.autoMapMaxDf` | `4` | The auto table may be broader than the live scan, because a table hit is exact by construction. |
| `recall.autoMapLimit` | `600` | Cap on auto-table rows (keeps the per-turn lookup cheap). |

> `notes.*` is read when the plugin loads, so changes to it need a restart; everything else on this
> table is re-read every turn.

### How a recall hit is chosen

Three routes, tried in this order, and the first one that produces anything wins:

1. **Entity map** — `recall.entityMapFile` is plain JSON: `{"key":"tiger-maus","file":"day-20261024.md","line":1709,"title":"…"}`.
   If `key` appears in the user's message (case-insensitive), that location is served. Deterministic,
   zero scoring. Extend it by editing the file; no restart needed.
2. **Rare identifiers** — a term shaped like a name (digits, dots, dashes, or an inner capital,
   length ≥ 5) that appears in at most `recall.rareMaxDf` note files. The reasoning is measured:
   `tiger-maus` lives in 2 files while "how/previous/that" live in all of them, so ranking by
   occurrence buries the only term that could locate anything.
3. **Keyword/embedding fallback** — the previous behaviour, and it is noisy by nature (2-gram
   cutting turns "有点牛逼啊" into `呲牛/牛逼/逼啊`). Set `recall.strict: true` to turn it off
   entirely: then an injection only ever happens when route 1 or 2 found something.

Two rules apply to every route:

- **The current turn's words, not the previous turn's.** The claimed `payload.messages` are read
  first; `agent/pre-step` runs before the message reaches `session.events`.
- **Today's own note file is never served.** Reading back what was written minutes ago is
  self-reference, not memory.

#### The table builds itself

`entity-map.auto.json` is generated from `notes.dir` and rebuilt whenever it is older than
`recall.autoMapMinutes`. The signal is narrow on purpose: a name-shaped term (digits, dots, dashes,
inner capitals, length 4-24) that the human typed **into a `##` heading**, occurring in at most
`recall.autoMapMaxDf` note files. Scanning body text instead produced 3,032 candidates, almost all
of them code symbols, file names and function names; headings are the user's own words, and that
cuts it to a couple of hundred useful ones.

The hand-written table is still read first and is never overwritten. One guard applies to both:
a heading containing a credential (密码 / 口令 / password / token / key) keeps its location but its
wording is replaced with `(含凭据，标题已隐藏)`, because titles are injected into the model's context.

### Mining the session log into notes
Folding only ever covers what has been folded. `lib/notes.js` closes that gap: it decodes the newest
`$DSH_HOME/sessions/**/session.jsonl.zstd` (concatenated zstd frames, decoded in pure Node) and
writes two kinds of markdown into `notes.dir`, which recall searches alongside the archive:

- `day-YYYYMMDD.md` — one section per episode: **用户** request, **结论** outcome, **路径** touched.
- `events-YYYY-MM.md` — one line per durable statement (decision, rule, install, path, root cause),
  deduped, each carrying its date and seq so the day file can be opened.

Measured on a 27.4 MB log: 15,740 frames → 108 MB / 111k events in ~1.1 s, and a refresh pass
writes ~50 files in 4-5 s. Secrets (`sk-…`, `Bearer …`, `ghp_…`) are redacted before anything is
written, so a key that was pasted into the conversation never lands in a note.


> **`targetSurfaceTokens` / `targetRatio` must be reachable.** At least `keepRecentNodes` nodes
> always stay, which is at least that many steps' worth of tokens. A target below that floor can
> never be met and the plugin will log `no-safe-cut` every turn. A target at or above the trigger
> is unreachable by construction (the fold stops *at* the target, and the surface only ever
> starts above the trigger), and exits through the same `no-safe-cut` line.

### How the two thresholds are resolved

`triggerSurfaceTokens` / `triggerRatio` (and the same pair for the target) resolve in this
order, per key, every turn:

1. **The key is present in `config.json`.** `triggerSurfaceTokens: 300000` means 300000 — an
   explicit absolute value beats the ratio, even when the context window is perfectly
   resolvable. "Present" means present in the raw file, not in the merged config object:
   `DEFAULTS` carries these keys too, so a merged-object check would always find one and the
   ratios would never apply at all.
2. **Otherwise, if the context window resolves:** `floor(window × ratio)`. The window comes
   from `ctx.llm.resolveModelInfo(provider, model, signal).context.contextWindow` — the same
   lookup `dsh-compaction-basic` uses for its own `thresholdRatio × contextWindow`.
3. **Otherwise:** the shipped absolute default, and the log line says `default`.

The ratio is what scales. A fixed 250000 can never be reached on a 128k-window model, so the
plugin silently does nothing there; on a 1M window it is only a quarter of capacity, so the
compactor gets there first.

**Verified on a real DSH instance** (2026-10-12, `web` profile, a 1M-window model): with a
config that carries no absolute key, a turn logged `windowTokens:1000000`, `trigger:750000`,
`target:180000`, `triggerSource:"ratio"` and
`via:"ctx.reflect.get|llm:ctx.reflect.get/agent.options"` — so `llm` was reached through
`ctx.reflect.get` and the provider/model came from `agent.options`. If none of the three lookup
paths work in your build, the line says `triggerSource: "default"` and the behaviour is exactly
what it was before this feature existed.

**Why `0.75` / `0.18`, and keep the trigger just under the compactor's line.**
`dsh-compaction-basic` fires at `thresholdRatio × contextWindow` — `0.8 × 1,000,000`, so 800k —
and retains `0.16 × window` (160k). Its replacement is a **model-written summary**, which is
lossy. `0.75` (750k of a 1M window) folds just *below* that line, which is what stops the
summarizer from ever firing; `0.18` (180k) mirrors its 0.16 retain ratio. Both defaults are
this project's own absolute settings — 750k and 180k, i.e. `0.75` and `0.18` of a
1,000,000-token window — expressed as fractions so they survive a change of window.

Every profile and fold line reports what happened: `windowTokens` (the resolved window, or
`null`), and `triggerSource` / `targetSource` = `absolute` | `ratio` | `default`. A ratio
outside `(0, 1)` — `0`, `1`, `1.5`, `"0.75"`, `null` — never throws and never becomes a broken
threshold: it falls back to rule 3 and the line also carries `triggerRatioInvalid` /
`targetRatioInvalid` so the reason is visible.

### Relation to the built-in compactor, and to the other "fold"-named plugins

| | built-in `dsh-compaction-basic` | this plugin | UI-fold plugins |
|---|---|---|---|
| What replaces the history | a **model-written summary** | an **extractive index** + an archive pointer | nothing — the request is untouched |
| Cost per fold | one extra model call | none, no model call at all | none |
| Is the original kept | no — the summary is all that survives | yes, verbatim, in `$DSH_HOME/history-fold/archive/` | n/a |
| Recoverable | no | yes, with one `rg` over the archive | n/a |
| What it changes | the surface (what the model is sent) | the surface (what the model is sent) | the **display** (long messages collapsed in the UI) |
| Trigger | `thresholdRatio × contextWindow`, 800k by default | `triggerRatio × contextWindow` (0.75 ⇒ 750k), just below the compactor's line; an absolute `triggerSurfaceTokens` still overrides it | n/a |

> **Keep the trigger below the compactor's line.** `dsh-compaction-basic` fires at
> `thresholdRatio × contextWindow` — `0.8 × 1,000,000`, so 800k — and keeps `0.16 × window`
> (160k). Its replacement is a model-written summary, which is lossy. Folding first is what
> stops that summarizer from ever firing at all. This is exactly why the default is
> `triggerRatio: 0.75` and not `0.8`: it scales with the window and still sits under the line.

A plugin with `fold` in its name is often a **display** fold: it collapses a long message in
the UI so it is easier to read, and leaves the request payload exactly as it was. This plugin
is the opposite — it does not touch the UI at all, and every byte it moves is aimed at the
tokens sent on the *next* request. Decide which of the two you actually want before installing.

For the on-disk side of the same problem — session logs growing because finalised streaming
fragments are never removed — see
[dsh-session-vacuum](https://github.com/mili1360/dsh-session-vacuum).

## Log

`$DSH_HOME/logs/history-fold.jsonl`, one JSON object per line:

| `mark` | Meaning |
|---|---|
| `profile` | Per-turn size/token breakdown, plus what each candidate `keepRecent` would save. |
| `profile-error` | Profiling itself failed. |
| `idle` | Below the trigger; nothing to do. |
| `would-fold` | `dryRun` — this is what *would* have been folded. |
| `folding` / `folded` | A real fold started / committed. Both carry `surfaceTokens`, `foldTokens`, `startSeq`, `endSeq`. |
| `no-safe-cut` | No balanced cut reaches the target, or the minimums were not met. |
| `no-meter` | The token meter was unreachable, so it refused to fold blind. |
| `archive-failed` | The archive write failed, so the fold was abandoned. |
| `error` | Anything else. The hook always fails open — a turn is never blocked. |
| `fed` | The digest was posted to the memory service (`memoryFeed`). |

Every one of these lines also carries the resolved thresholds, so no reader has to guess which
of the three paths ran:

| Field | Meaning |
|---|---|
| `trigger` / `target` | The two thresholds actually used this turn, in tokens. |
| `windowTokens` | The resolved context window, or `null` when it could not be established. |
| `triggerSource` / `targetSource` | `absolute` (explicit in `config.json`), `ratio` (`floor(window × ratio)`), or `default` (the shipped absolute fallback). |
| `triggerRatioInvalid` / `targetRatioInvalid` | Present and `true` only when the configured ratio was unusable and rule 3 was applied instead. |
| `via` | Which path reached the token meter, and which reached `llm` (e.g. `ctx.tokenMeter|llm:ctx.reflect.get/agent.options`). |

## Safety model

- **Inert by default.** With no config file, nothing is read, written or logged.
- **Archive before fold.** A fold commits only after its full text is on disk.
- **Balanced cuts only.** A tool call never crosses a fold boundary.
- **Balanced failures only.** A missing token meter, an unreachable session or an archive
  error all skip the fold and log it, rather than guessing.
- **Turn boundary only.** `onlyAtTurnStart` keeps a fold from ever landing mid-turn.
- **Nothing is paraphrased.** The index is extraction; only the pointer message is
  synthetic, and it is labelled `source.kind = 'plugin'`.
- **A failed index write never blocks a fold.** The archive is written first and holds every
  byte, so an index error is logged as `index-failed` and the fold proceeds; the message then
  names the raw archive instead of a tier file.

## Tests

```bash
npm test              # all four suites
npm run test:fold     # fold policy and the archive
npm run test:profile  # the per-turn size profile
npm run test:edge     # boundaries: thresholds, floors, odd surfaces, hostile config
npm run test:ratio    # window-ratio thresholds: precedence, fallbacks, invalid ratios
npm run test:mutate   # reintroduce eleven real defects and require the suite to catch each
npm run test:all      # npm test + mutation testing
```

They run fully offline: no DSH, no network, no API key, and a throwaway `DSH_HOME` under
`os.tmpdir()`. `ratio-tests` uses a three-line fake `llm`, never a real DSH service.

| Suite | Cases | Covers |
|---|---|---|
| `fold-tests` | 15 | the fold itself: span, provenance, balance, archive-before-fold, the archive body fix, the fresh-install contract |
| `profile-tests` | 8 | the per-turn size profile |
| `edge-tests` | 20 | exact-threshold behaviour, unreachable targets, both worth-folding floors, `keepRecentNodes` extremes, unclosed tool pairs, empty/degenerate surfaces, a tiny digest budget, an unreachable feed, hostile and corrupt config, a hostile `ctx` (missing or refusing services), a second fold in one session |
| `ratio-tests` | 31 | the ratio path, the absolute override, every way the window can fail to resolve, invalid ratios, and the unreachable-target path |

**Mutation testing** is the reason to trust the green. A passing suite proves nothing on its
own — this project shipped a suite that ran *zero* assertions for weeks while printing
`13 passed, 0 failed`. `npm run test:mutate` reintroduces eleven defects that have really
existed or could plausibly exist (the dropped tool-result body, live-by-default settings, a
removed mid-turn guard, an ignored worth-folding floor, a strict trigger comparison, a dropped
tool-pairing balance requirement, an inverted absolute/ratio precedence, a merged-config key
check that would let `DEFAULTS` always win, an accepted invalid ratio, an unvalidated context
window, a removed registration guard that would let a hostile `ctx` throw out of `apply()`) and
fails unless the suite goes red for every one. Current result: **11 / 11**.

> **For contributors:** `test()` **must** `await fn()`, in every suite. A synchronous harness
> reports `ok` before any async assertion runs and lets the script reach `process.exit(0)`
> first, which silently turns the whole suite into a no-op. See `CHANGELOG.md` for the full
> story and how it was detected.

### Verified end to end

Beyond the unit suites, the fold has been run end to end against a real 1,210-turn session
(surface 213,919 tokens): **15 consecutive folds**, each verifying that every folded message
body appears verbatim in the archive (`456/456` bodies, `299` tool results, in a 608-message
fold), plus a second fold in the same session, a reload after a DSH restart, and a recall
test where the answer was a random string planted so that it existed nowhere on disk — the
model found it by searching the archive, and said plainly that it was not in its visible
context.

Two limits worth knowing:

- **The in-context index is not a summary you can rely on for detail.** It was 29,937
  characters in that test, and the model did not locate a specific string inside it. Actual
  recall comes from the archive plus the notice telling the model to search it. The index
  tells the model *what exists*, not *what it said*.
- **Anything that makes DSH's token meter throw disables folding silently.** The plugin logs
  `no-meter` and skips the turn (fail open, nothing is lost), and the official compactor
  depends on the same meter. A session-sidecar pruner that emitted `placeholder` blocks was
  observed to cause exactly this; it is off by default and unrelated to the live path.


## Limitations

- Tuned and measured against DeepSeek Harness on Windows with a 1,000,000-token context
  window. The mechanism is adapter-agnostic; the shipped absolute fallbacks are not — which is
  what the ratios are for. When the window resolves, the thresholds scale with it.
- **Whether `ctx.llm` is really reachable from this plugin's context has not been confirmed
  against a live DSH.** The lookup mirrors `resolveMeter()` (direct property, then
  `ctx.reflect.get`, then the agent's own composed context) and never throws, but if no path
  works in your build the plugin logs `triggerSource: "default"` and behaves exactly as it did
  before this feature existed.
- Token counts come from DSH's `tokenMeter`. If it is unavailable the plugin does nothing —
  by design.
- Folding reduces what the model sees. The archive keeps it recoverable, but reading it back
  costs a `rg` round-trip.
- It does not (yet) coordinate with `dsh-compaction-basic`; it simply stays below its
  trigger.

## Related plugins

Three small DSH plugins, each aimed at one part of the same problem — a session that gets
expensive and slow the longer it runs:

- **[dsh-session-vacuum](https://github.com/mili1360/dsh-session-vacuum)** — deletes the dead
  streaming fragments out of session logs at startup, so loading a long session stops expanding
  into gigabytes. (Different layer from this plugin: that one shrinks the log on disk, this one
  shrinks what each request carries.)
- **[dsh-proactive](https://github.com/mili1360/dsh-proactive)** — wakes the agent when a long
  background task finishes after the turn has ended, so it reports back on its own.


## License

MIT — see [LICENSE](LICENSE).

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

---

**If this made a session usable again, a ★ is what lets the next person find it.** Discovery
here is ranked by stars — the plugin directories and GitHub's own search both sort by them — so
a reader who was helped is the only thing that moves that number. Bug reports and "this did not
work on my build" are just as valuable: they are the only reason the compatibility section above
is worth anything.
