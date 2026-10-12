// Mutation testing: break the plugin on purpose and prove the suite notices.
//
// A green suite proves nothing on its own -- this project shipped a suite that ran zero
// assertions for weeks and still printed "13 passed, 0 failed". This script is the antidote:
// each mutation is a small, plausible reintroduction of a real defect, and the suite must go
// red for every one of them.
//
// Run: npm run test:mutate
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { fileURLToPath } = require('url');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'lib', 'index.js');
const SUITES = [
  path.join(ROOT, 'test', 'fold-tests.mjs'),
  path.join(ROOT, 'test', 'profile-tests.mjs'),
  path.join(ROOT, 'test', 'edge-tests.mjs'),
  path.join(ROOT, 'test', 'ratio-tests.mjs'),
];

const original = fs.readFileSync(LIB, 'utf8');

// Each entry reintroduces one defect that has actually existed or could plausibly exist.
const MUTATIONS = [
  {
    name: 'archive drops tool-result bodies again',
    from: 'textOf(messageOf(event), true)',
    to: 'textOf(messageOf(event))',
  },
  {
    name: 'DEFAULTS become live-by-default (a fresh install would start folding)',
    from: '  enabled: false,\n  // Set false to fold for real. While true the plugin only observes and logs.\n  dryRun: true,',
    to: '  enabled: true,\n  dryRun: false,',
  },
  {
    name: 'the mid-turn guard is removed',
    from: "if (cfg.onlyAtTurnStart && typeof step === 'number' && step > 1) {",
    to: 'if (false) {',
  },
  {
    name: 'the worth-folding floor (minFoldNodes / minFoldTokens) is ignored',
    from: 'if (shadowed.length < cfg.minFoldNodes || foldTokens < cfg.minFoldTokens) {',
    to: 'if (false) {',
  },
  {
    name: 'the trigger comparison becomes strict (< instead of <=)',
    // anchor updated when the thresholds became resolvable: the comparison itself is byte for
    // byte what it always was, only `cfg.triggerSurfaceTokens` became `triggerTokens`.
    from: 'if (surfaceTokens <= triggerTokens) {',
    to: 'if (surfaceTokens < triggerTokens) {',
  },
  {
    name: 'the tool-pairing balance requirement is dropped',
    // anchor updated for the same reason as the trigger comparison above: the balance check is
    // unchanged, only cfg.targetSurfaceTokens became the resolvable targetTokens.
    from: 'if (balanced[i + 1] && remaining <= targetTokens) { endIdx = i; break }',
    to: 'if (remaining <= targetTokens) { endIdx = i; break }',
  },
  {
    name: 'an explicit absolute key no longer beats the ratio (precedence inverted)',
    from: "  if (explicit !== undefined) return { value: explicit, source: 'absolute' }\n",
    to: '',
  },
  {
    name: 'the raw-file key check becomes a merged-config check (DEFAULTS would always win)',
    from: 'rawKeys instanceof Set && rawKeys.has(key)',
    to: "key in cfg",
  },
  {
    name: 'an invalid ratio is accepted instead of falling back',
    from: '  return typeof value === \'number\' && Number.isFinite(value) && value > 0 && value < 1 ? value : undefined',
    to: '  return value === undefined ? undefined : value',
  },
  {
    name: 'the context window is trusted without validation',
    // A fractional or absurd window must not become a threshold: dsh-llm validates
    // contextWindow as a positive INTEGER, so a non-integer here means the value is not
    // capacity data at all.
    from: "      if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && Number.isInteger(contextWindow) && contextWindow > 0) {",
    to: '      if (true) {',
  },
];

function runSuite(file) {
  try {
    const out = execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function summary(out) {
  const line = out.trim().split('\n').filter((l) => /passed/.test(l)).pop();
  return line ? line.trim() : '(no summary)';
}

console.log('dsh-history-fold mutation test\n');
console.log('baseline (unmutated):');
for (const s of SUITES) {
  const r = runSuite(s);
  console.log('  ' + path.basename(s).padEnd(20) + summary(r.out) + '  exit=' + r.code);
  if (r.code !== 0) {
    console.log('\nABORT: the baseline is not green, so a "caught" verdict would be meaningless.');
    process.exit(2);
  }
}

console.log('\nmutations:');
let caught = 0;
let skipped = 0;
for (const m of MUTATIONS) {
  if (original.indexOf(m.from) < 0) {
    console.log('  SKIP   ' + m.name + '   (anchor text not found)');
    skipped++;
    continue;
  }
  fs.writeFileSync(LIB, original.replace(m.from, m.to));
  try {
    const broke = SUITES.some((s) => runSuite(s).code !== 0);
    if (broke) { caught++; console.log('  CAUGHT ' + m.name); }
    else console.log('  MISSED ' + m.name + '   <-- no test covers this');
  } finally {
    fs.writeFileSync(LIB, original);
  }
}

fs.writeFileSync(LIB, original);
const restored = runSuite(SUITES[0]);

console.log('\n=== verdict ===');
console.log('  ' + caught + ' caught / ' + skipped + ' skipped / ' + MUTATIONS.length + ' mutations');
console.log('  lib restored, fold-tests exit=' + restored.code);
if (caught + skipped !== MUTATIONS.length) {
  console.log('\n  some mutations were NOT caught: the suite has a hole there.');
  process.exit(1);
}
// A SKIP is not a pass. An anchor that stopped matching means that defect is no longer being
// tested at all -- and the script would otherwise print "every mutation was caught" while a
// mutation never ran. This happened: two anchors in this very file went stale in the same
// commit that moved the expressions they pointed at.
if (skipped > 0) {
  console.log('\n  ' + skipped + ' mutation(s) were SKIPPED: an anchor no longer matches lib/index.js,');
  console.log('  so that defect is not being tested. Fix the anchor -- a skip is not a pass.');
  process.exit(1);
}
console.log('\n  every mutation was caught: the suite reacts to real defects.');
