# dsh-history-fold 0.8.0 — it learned when *not* to interrupt you

Recall only helps if it fires at the right moment.

The old trigger was a regular expression: if the message contained a rare identifier, or words like
"last time", go dig through old notes. Measured against **659 hand-labelled turns** taken from this
project's own 4,906-message history, that regex fired on **22% of turns that did not need it** — a
wall of old notes arriving in the middle of ordinary conversation.

0.8.0 adds a small classifier that reviews the rule's decision.

## The numbers

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

Without the classifier the plugin was injecting old notes on **one message out of three**. With it,
the fire rate lands in the 10–15% band where the annotated data says real demand is, and injected
volume drops **8×**.

## Why it is shippable

- **1.3 MB, zero dependencies.** Plain JS over a JSON weight table: no ONNX, no runtime, no Python,
  no network call, no API cost. Sub-millisecond inference; 44–53 ms total recall overhead.
- **A filter, not an oracle.** It sits on top of the existing rules and can only *veto* them when
  confident a turn is noise. Explicit recall intent never reaches it.
- **Missing model = unchanged behaviour.** No `model/gate-model.json` → the layer is skipped and the
  rules decide exactly as in 0.7. Nothing silently disabled, nothing silently enabled.
- **Reproducible.** Every number above came from scripts in the development repository: the label
  sets, the active-learning selection, the cross-validation, and the 3,431-message benchmark.

## Also in 0.8.0

- **Note scoring is TF-IDF weighted** instead of raw hit counts. Ranking had been rewarding long
  files and 2-gram fragments (`的卡`, `个学` appear dozens of times in a long day file) while a
  decisive rare name got the same weight. Top-3 on 20 rewritten questions: **7 → 12**.
- **`recall.strict` no longer silently abandons a question.** The log showed 192 skips against 590
  injections — roughly a third of questions never woke retrieval at all. Set
  `recall.fallback: false` for the old behaviour.
- **Each injection now logs the question and the note files it hit** (`q` / `paths`), which is the
  raw material for training on real usage rather than on hand-written samples.

## Honest limitations

- The classifier is trained on **one person's conversations**. It transfers poorly to a different
  writing style — treat the numbers above as "what the method is worth", not as a promise.
- Its ceiling is the framework: it sees **one sentence**, while "should this be looked up" depends on
  what the conversation was just about. A context-coverage feature is the obvious next step and is
  **not implemented**.
- Adding more training data is already **saturated**: going from 659 to 1,118 labels (+70%) moved
  held-out AUC only 0.710 → 0.726.
- Not on npm yet — install from git.

**Full changelog:** [CHANGELOG.md](https://github.com/mili1360/dsh-history-fold/blob/main/CHANGELOG.md)
