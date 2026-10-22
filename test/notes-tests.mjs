// Tests for the notes module inside dsh-history-fold.
//
// What matters here is not "does it write markdown" but:
//   - a multi-frame zstd log decodes completely (node's one-shot API only reads frame 1)
//   - a torn final frame (a live log being appended) does not lose the good frames
//   - the day file keeps the user request AND the outcome, and a secret never lands in it
//   - the event ledger only keeps lines that state something durable
//   - a second refresh with unchanged input is safe to run again
//
// Run: node test/notes-tests.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const plugin = await import('../lib/index.js')
const { scanZstdFrames, decodeSessionLog, mineNotes, newestSessionLog, refreshNotes } = plugin

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-tests-'))

let passed = 0
let failed = 0
async function test(label, fn) {
    try {
        await fn()
        passed++
        console.log('  ok   ' + label)
    } catch (err) {
        failed++
        console.log('  FAIL ' + label + ' -> ' + err.message)
    }
}

// ---------------------------------------------------------------- helpers

const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'))

function jsonl(rows) {
    return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

function makeLog(dir, chunks) {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'session.jsonl.zstd')
    fs.writeFileSync(file, Buffer.concat(chunks.map(frame)))
    return file
}

const USER = (seq, text, time) => ({ type: 'user/message', seq, time, data: { content: [{ type: 'text', text }] } })
const ASST = (seq, text, time) => ({ type: 'assistant/message', seq, time, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })

const T1 = Date.parse('2026-10-01T10:00:00')
const T2 = Date.parse('2026-10-02T10:00:00')

// ---------------------------------------------------------------- zstd frames

await test('multi-frame log decodes every frame, not just the first', () => {
    const a = jsonl([USER(1, '第一段', T1)])
    const b = jsonl([USER(2, '第二段', T2)])
    const buf = Buffer.concat([frame(a), frame(b)])
    const { frames } = scanZstdFrames(buf)
    assert.equal(frames.length, 2)
    const text = decodeSessionLog(buf)
    assert.ok(text.includes('第一段'), 'frame 1 text missing')
    assert.ok(text.includes('第二段'), 'frame 2 text missing')
})

await test('a torn final frame keeps the complete ones', () => {
    const good = frame(jsonl([USER(1, '完整的一帧', T1)]))
    const torn = frame(jsonl([USER(2, '被截断的一帧', T2)])).subarray(0, 12)
    const { frames, tornStart } = scanZstdFrames(Buffer.concat([good, torn]))
    assert.equal(frames.length, 1)
    assert.equal(typeof tornStart, 'number')
    assert.ok(decodeSessionLog(Buffer.concat([good, torn])).includes('完整的一帧'))
})

await test('a non-zstd buffer is rejected, not silently empty', () => {
    assert.throws(() => scanZstdFrames(Buffer.from('not zstd at all')))
})

// ---------------------------------------------------------------- mining

await test('day file keeps the request and the outcome', () => {
    const text = jsonl([
        USER(10, '帮我看看这个报错', T1),
        ASST(11, '结论：根因是路径里混了中文，已改成纯 ASCII。', T1 + 1000),
    ])
    const r = mineNotes(text, { events: true })
    assert.equal(r.stats.userMessages, 1)
    assert.equal(r.stats.assistantReplies, 1)
    const day = [...r.days.entries()].find(([n]) => n.startsWith('day-20261001'))
    assert.ok(day, 'no day file for 2026-10-01')
    assert.ok(day[1].includes('帮我看看这个报错'))
    assert.ok(day[1].includes('根因是路径里混了中文'))
    assert.ok(day[1].includes('seq 10'))
})

await test('steer/inject turns are not counted as the human', () => {
    const text = jsonl([
        { type: 'user/message', seq: 1, time: T1, data: { source: { kind: 'steer' }, content: [{ type: 'text', text: '内部注入' }] } },
        USER(2, '真正的提问', T1),
    ])
    const r = mineNotes(text)
    assert.equal(r.stats.userMessages, 1)
    const md = [...r.days.values()][0]
    assert.ok(!md.includes('内部注入'))
})

await test('a secret never reaches the notes', () => {
    const text = jsonl([USER(1, '我的 key 是 sk-abcdef1234567890 你看着办', T1)])
    const md = [...mineNotes(text).days.values()][0]
    assert.ok(!md.includes('sk-abcdef1234567890'))
    assert.ok(md.includes('<redacted>'))
})

await test('event ledger keeps durable lines and drops chatter', () => {
    const text = jsonl([
        USER(1, '以后不要再用右键管理员运行', T1),
        ASST(2, '好', T1),
        ASST(3, '根因找到了：那个提权进程没死，占着安装锁。', T1),
        ASST(4, '哈哈好的', T1),
    ])
    const r = mineNotes(text, { events: true })
    const md = [...r.events.values()][0] || ''
    assert.ok(md.includes('以后不要再用右键管理员运行'), 'rule missing')
    assert.ok(md.includes('根因找到了'), 'root cause missing')
    assert.ok(!md.includes('哈哈好的'), 'chatter leaked into the ledger')
})

await test('meme markers and CRLF are stripped from the text', () => {
    const text = jsonl([USER(1, '真的吗\r\n[表情: 泪奔]', T1)])
    const md = [...mineNotes(text).days.values()][0]
    assert.ok(md.includes('真的吗'))
    assert.ok(!md.includes('[表情:'))
})

// ---------------------------------------------------------------- io

await test('refreshNotes writes each session into its own folder', () => {
    const home = path.join(tmp, 'home1')
    const sessDir = path.join(home, 'sessions', 'proj', 'session-abc')
    makeLog(sessDir, [jsonl([USER(1, '第一个问题', T1), ASST(2, '结论：已经装好了，路径是 E:\\tools\\x.exe。', T1)]), jsonl([USER(3, '第二个问题', T2)])])

    const r = refreshNotes({ home })
    assert.equal(r.ok, true)
    const base = path.join(home, 'history-fold', 'notes')
    // Per-session isolation: this session's notes must NOT sit in the shared root.
    assert.ok(fs.statSync(path.join(base, 'abc')).isDirectory(), 'per-session folder missing')
    const files = fs.readdirSync(path.join(base, 'abc'))
    assert.ok(files.some((f) => f.startsWith('day-20261001')), 'day file for 10-01 missing')
    assert.ok(files.some((f) => f.startsWith('day-20261002')), 'day file for 10-02 missing')
    assert.ok(files.some((f) => f.startsWith('events-2026-10')), 'event file missing')
    const day2 = fs.readFileSync(path.join(base, 'abc', files.find((f) => f.startsWith('day-20261002'))), 'utf8')
    assert.ok(day2.includes('第二个问题'))

    // Two sessions stay separate.
    const otherDir = path.join(home, 'sessions', 'proj', 'session-xyz')
    makeLog(otherDir, [jsonl([USER(9, '另一个窗口的问题', T2)])])
    refreshNotes({ home })
    const abc = fs.readdirSync(path.join(base, 'abc')).join(',')
    assert.ok(!abc.includes('另一个'), 'session folders merged')
    assert.ok(fs.readdirSync(path.join(base, 'xyz')).some((f) => f.startsWith('day-')), 'second session not mined')
})

await test('a second refresh over the same log is idempotent', () => {
    const home = path.join(tmp, 'home1')
    const base = path.join(home, 'history-fold', 'notes', 'abc')
    const name = fs.readdirSync(base).find((f) => f.startsWith('day-20261001'))
    const before = fs.readFileSync(path.join(base, name), 'utf8')
    const r = refreshNotes({ home })
    assert.equal(r.ok, true)
    const after = fs.readFileSync(path.join(base, name), 'utf8')
    assert.equal(before, after)
})

await test('newestSessionLog ignores backup copies by name', () => {
    const home = path.join(tmp, 'home2')
    const dir = path.join(home, 'sessions', 'p', 's')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), frame('x'))
    fs.writeFileSync(path.join(dir, 'session.jsonl.zstd.bak'), frame('y'))
    fs.writeFileSync(path.join(dir, 'session.jsonl.zstd.orig'), frame('z'))
    const found = newestSessionLog(home)
    assert.ok(found && found.file.endsWith('session.jsonl.zstd') && !found.file.endsWith('.bak'))
})

await test('a corrupt log reports a reason instead of throwing', () => {
    const home = path.join(tmp, 'home3')
    const dir = path.join(home, 'sessions', 'p', 's')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), Buffer.from('garbage'))
    const r = refreshNotes({ home })
    // The pass still succeeds overall (one bad log must not stop the others), but nothing is mined
    // and the reason names the decode failure.
    assert.equal(r.ok, true)
    assert.equal(r.mined, 0)
    assert.ok(String(r.reason).startsWith('decode-failed'), 'reason was: ' + r.reason)
})

await test('no session log at all is a quiet no-op', () => {
    const r = refreshNotes({ home: path.join(tmp, 'empty-home') })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no-session-log')
})

// ---------------------------------------------------------------- summary

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\nnotes: ' + passed + ' passed, ' + failed + ' failed')
if (failed) process.exit(1)
