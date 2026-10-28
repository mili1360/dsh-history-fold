## What this release is

A one-line config mistake can make this plugin look installed and working while folding nothing —
forever. That happened here, for three weeks. 0.8.2 makes that failure loud.

## The bug that motivated it

`triggerSurfaceTokens` was 750000 against a 1000000-token window. It parses, it is positive, and it
logs `idle` on every turn — so nothing anywhere says "this will never fire". And it never did:

- the threshold meant a **real** prompt of ~1.31M tokens, i.e. more than the window itself;
- DSH's own compactor (`dsh-compaction-basic`, `thresholdRatio` 0.8) therefore always reached the
  history first, at 800k, and rewrote it into a model-written summary;
- the log reported `45%, still idle` the whole way, which reads exactly like "not needed yet".

The number that hid the problem: DSH's `surfaceTokens` under-reports this machine's
Chinese-heavy history by a measured **1.75x** — `452,024` surface = `790,915` real prompt tokens,
stable across 35 consecutive turns (ratio 1.737–1.769). A trigger tuned in surface units sits
~1.75x higher in real tokens than it looks.

## What changed

### The shipped default was the same bug, one level up

`triggerRatio` defaulted to `0.75`. That ratio multiplies **DSH's meter**, not the real request, so
`0.75 × 1,000,000` meant a *real* prompt of ~1.31M tokens — past the window, and far past the
compactor's 0.8 line. Every install that did not set an absolute `triggerSurfaceTokens` (the common
case) inherited a threshold that could never be reached.

| key | was | now | why |
|---|---|---|---|
| `triggerRatio` | `0.75` | **`0.33`** | 0.33 × 1M = 330k meter ≈ 578k real, ~222k real tokens clear of the compactor's 800k |
| `targetRatio` | `0.18` | **`0.14`** | below the compactor's own 0.16 retain ratio |
| `emergencyTriggerRatio` | `0.8` | **`0.42`** | the old value was ~1.4× the window in real tokens: a second chance that could never arrive |
| `emergencyTriggerSurfaceTokens` | `800000` | **`320000`** | same reason, absolute form |

An explicit `triggerSurfaceTokens` / `targetSurfaceTokens` in `config.json` still wins — absolute
keys are untouched. On English-heavy history the meter tracks the real count closely, so a ratio
this low folds earlier than strictly necessary; that is the deliberate direction, since folding
early costs one archive write and folding late costs the original text.

### Unreachable thresholds are announced

`resolveThresholds()` now reports, and the plugin logs once per distinct resolved pair:

| warning | meaning |
|---|---|
| `trigger-behind-native-compaction` | at or above `window * 0.8`: DSH's compactor gets there first, so this plugin never runs |
| `trigger-at-or-above-window` | at or above the window: unreachable, full stop |
| `target-not-below-trigger` | nothing can ever be folded |

Each named condition is one grep away instead of three weeks away. No window resolved, no claim
made — an unknown context window produces no warning rather than a guessed one.

Tests: `ratio` suite 31 → **36**, including a case that reproduces the exact shipped
`750000 / 1M` pair and asserts it is announced. All 7 suites green.

## Install

```bash
dsh plugin add --profile web https://github.com/mili1360/dsh-history-fold/releases/download/v0.8.2/dsh-history-fold-0.8.2.tgz
```

## Honest limitations

- The warning tells you the threshold cannot work; it does not pick a better one for you. On a 1M
  window with Chinese-heavy history, `triggerSurfaceTokens: 300000` is the value this install now
  uses (≈528k real, 52.8%), comfortably below the native 80% line.
- The 1.75x ratio is measured on one machine's content mix. It is stable within that mix, not a
  universal constant — treat it as calibration evidence, not a conversion you can reuse blindly.
- Threshold warnings need a DSH restart to load (plugin modules are read at boot). The thresholds
  themselves stay hot-read, so folding behaviour changes without a restart.
