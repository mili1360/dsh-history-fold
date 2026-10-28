# dsh-history-fold 0.8.1

A correctness release. If you installed from git before this, **you want this one** — the previous
version could fail silently on any host without DSH's own `node_modules`.

## Fixed: injection no longer hard-depends on `@deepseek-ai/dsh-llm`

Building the injected message imported that package. It exists inside a DSH installation but not in
this repository, so outside such an installation retrieval succeeded and then the injection threw:

```
Cannot find package '@deepseek-ai/dsh-llm' imported from lib/recall.js
```

Nothing reached the model, nothing was logged to the user, and it kept CI red since 0.6.4 while
passing on a machine that happened to have DSH installed. A missing package now falls back to a
minimal message constructor. **On a real DSH host nothing changes** — the package is always there.

Found with `test/diagnose-recalls.mjs`, which prints platform, home, archive listing, extracted
keywords, direct `searchArchive` hits and the last log line. The numbers up to `hits: 1` were fine;
the failure showed up one line later.

## Fixed: unit tests no longer depend on the trained model

`recall.gate: false` disables the classifier layer, and the test harness now sets it by default — the
decision logic is tested against fixed input instead of whatever `model/gate-model.json` currently
contains. The classifier got its own tests: the bundled model loads and separates obvious cases, and
a missing model file degrades to "no opinion" instead of blocking recall.

## Install

```bash
dsh plugin add --profile web github:mili1360/dsh-history-fold
```

Or, without git resolving a branch, straight from this release's tarball:

```bash
dsh plugin add --profile web https://github.com/mili1360/dsh-history-fold/releases/download/v0.8.1/dsh-history-fold-0.8.1.tgz
```

Restart DSH afterwards — a bundle is only registered at boot.

## What is in 0.8.x

See the [0.8.0 notes](https://github.com/mili1360/dsh-history-fold/releases/tag/v0.8.0) for the
classifier that decides whether a plain question deserves a lookup (mis-triggers 22.0% → 7.5% on 659
hand-labelled turns; full 3,431-message run: fire rate 69.3% → 8.4%, injected volume −8×).
