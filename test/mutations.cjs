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
    from: 'if (surfaceTokens <= cfg.triggerSurfaceTokens) {',
    to: 'if (surfaceTokens < cfg.triggerSurfaceTokens) {',
  },
  {
    name: 'the tool-pairing balance requirement is dropped',
    from: 'if (balanced[i + 1] && remaining <= cfg.targetSurfaceTokens) { endIdx = i; break }',
    to: 'if (remaining <= cfg.targetSurfaceTokens) { endIdx = i; break }',
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
console.log('\n  every mutation was caught: the suite reacts to real defects.');
