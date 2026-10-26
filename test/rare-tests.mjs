// Tests for the precise recall layer (lib/rare.js): the curated entity map, the auto-built
// table, and the rare identifier search. Fixtures are created in a temp dir, so these tests
// never depend on the machine's real notes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { searchRare, readEntityMap, rebuildAutoMap, looksLikeIdentifier } from '../lib/rare.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
    if (cond) { pass += 1; console.log('  ok   ' + name) }
    else { fail += 1; console.log('  FAIL ' + name + (extra ? ' -- ' + extra : '')) }
}

const today = (() => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return 'day-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.md'
})()

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-rare-'))
const sid = 'session-test'
const notesDir = path.join(root, sid)
fs.mkdirSync(notesDir, { recursive: true })

fs.writeFileSync(path.join(notesDir, 'day-20260101.md'), [
    '# 20260101',
    '## 不是保底，是450金币买的一个箱子',
    '开箱就出 Tiger-Maus，直接领走。',
    '',
    '## 凭据保险箱',
    '用的是 dpapi，不是明文。',
].join('\n'), 'utf8')

fs.writeFileSync(path.join(notesDir, 'day-20260102.md'), [
    '## 随便聊聊',
    '今天天气不错。',
].join('\n'), 'utf8')

// today's file must never be treated as memory
fs.writeFileSync(path.join(notesDir, today), [
    '## 正在做的事',
    'Tiger-Maus 又出现了一次，就在今天。',
].join('\n'), 'utf8')

const mapFile = path.join(root, 'entity-map.json')
fs.writeFileSync(mapFile, JSON.stringify([
    { key: 'tiger-maus', file: 'day-20260101.md', line: 2, title: '不是保底，是450金币买的一个箱子' },
    { key: '凭据保险箱', file: 'day-20260101.md', line: 6, title: '凭据保险箱' },
]), 'utf8')

const cfg = { maxHits: 3, maxDf: 2, mapFile }

console.log('rare: entity map')

ok('map file is parsed', readEntityMap(mapFile).length === 2)
ok('keys are lowercased', readEntityMap(mapFile)[0].key === 'tiger-maus')
ok('a missing map file is empty, not a throw', readEntityMap(path.join(root, 'nope.json')).length === 0)

{
    const r = searchRare(notesDir, '那个 tiger-maus 怎么来的？', cfg)
    ok('a mapped term is found by the table', r.reason === 'map-hit' && r.hits.length === 1)
    ok('the table hit points at the right line', r.hits[0].line === 2)
}

{
    const r = searchRare(notesDir, '凭据保险箱是什么加密的', cfg)
    ok('a Chinese table key works', r.reason === 'map-hit' && r.hits[0].file === 'day-20260101.md')
}

console.log('rare: identifiers')

ok('dashes make a name', looksLikeIdentifier('tiger-maus'))
ok('digits make a name', looksLikeIdentifier('bge-small-zh-v1.5'))
ok('inner capitals make a name', looksLikeIdentifier('peekPx'))
ok('plain prose is not a name', !looksLikeIdentifier('injection'))

{
    // no table entry: only the rare-identifier path can answer
    const noMap = { maxHits: 3, maxDf: 2 }
    const r = searchRare(notesDir, 'tiger-maus 到底是怎么回事', noMap)
    ok('a rare identifier finds the section without the table', r.reason === 'rare-hit' && r.hits.length > 0)
    ok('and it is not the today file', r.hits.every((h) => !String(h.file).endsWith(today)))
}

console.log('rare: refusals')

{
    const r = searchRare(notesDir, '今天天气怎么样', cfg)
    ok('a chat question returns nothing', r.hits.length === 0 && r.reason === 'no-identifier')
}
{
    const r = searchRare(notesDir, '有点牛逼啊', cfg)
    ok('2-gram junk returns nothing', r.hits.length === 0)
}
{
    const r = searchRare(notesDir, 'injection delivered the note', cfg)
    ok('prose English words never trigger', r.hits.length === 0)
}
{
    // a term that exists only inside today's file must not be served as memory
    const r = searchRare(notesDir, 'Tiger-Maus 又出现了一次', { maxHits: 3, maxDf: 1 })
    ok('today-only matches are not memory', r.hits.every((h) => !String(h.file).endsWith(today)))
}

console.log('rare: auto table')

{
    // The auto table is generated from the notes: a name-shaped term the human typed into a
    // heading, occurring in at most maxDf files. The fixture therefore needs a heading that
    // itself names something -- a body mention is not enough (that is the whole point).
    const autoNotes = path.join(root, 'auto-session')
    fs.mkdirSync(autoNotes, { recursive: true })
    fs.writeFileSync(path.join(autoNotes, 'day-20260104.md'), [
        '## Tiger-Maus 那次是怎么来的',
        '开箱出的。',
    ].join('\n'), 'utf8')
    const autoFile = path.join(root, 'entity-map.auto.json')
    const built = rebuildAutoMap(autoNotes, autoFile, { maxDf: 2, limit: 50 })
    ok('the auto table is written', built.written > 0, JSON.stringify(built))
    const rows = readEntityMap(autoFile)
    ok('it keeps the dashed identifier', rows.some((r) => r.key === 'tiger-maus'), JSON.stringify(rows.map((r) => r.key)))
    ok('it does not keep plain prose', !rows.some((r) => r.key === 'injection'))
}

{
    // a heading that carries a credential keeps its location but withholds the wording
    const secretDir = path.join(root, 'secret-session')
    fs.mkdirSync(secretDir, { recursive: true })
    fs.writeFileSync(path.join(secretDir, 'day-20260103.md'), [
        '## 账号密码 wotb2026 记牢了',
        '存起来了。',
    ].join('\n'), 'utf8')
    const secretFile = path.join(root, 'entity-map.secret.json')
    rebuildAutoMap(root, secretFile, { maxDf: 4, limit: 50 })
    const secretRows = readEntityMap(secretFile).filter((r) => String(r.file).includes('day-20260103'))
    ok('a credential heading is still indexed', secretRows.length > 0, JSON.stringify(secretRows))
    ok('but its wording is withheld', secretRows.every((r) => !/wotb2026/.test(r.title)))
}

fs.rmSync(root, { recursive: true, force: true })
console.log('\nrare: ' + pass + ' passed, ' + fail + ' failed')
if (fail > 0) process.exit(1)
