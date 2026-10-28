// 临时诊断：在 CI（Linux）上到底哪一步断了。本地 Windows 全过、CI 挂 4 个，靠猜没用。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const plugin = await import('../lib/index.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'))
process.env.DSH_HOME = tmp

const archiveDir = path.join(tmp, 'history-fold', 'archive')
fs.mkdirSync(archiveDir, { recursive: true })
fs.writeFileSync(path.join(archiveDir, 'session-r1.jsonl'),
    JSON.stringify({ seq: 1, type: 'user/message', text: '当时把 history-fold 的触发线定在 750k' }) + '\n')

const q = 'history-fold 的触发线是多少'
const cfg = { recursive: true, maxNoteHits: 8, snippetChars: 200 }
const kw = plugin.extractKeywords(q, cfg)
console.log('platform :', process.platform)
console.log('node     :', process.version)
console.log('DSH_HOME :', process.env.DSH_HOME)
console.log('archive  :', archiveDir)
console.log('files    :', fs.readdirSync(archiveDir))
console.log('keywords :', JSON.stringify(kw))
console.log('kw count :', kw.length)
const hits = plugin.searchArchive(path.join(archiveDir, 'session-r1.jsonl'), kw, cfg)
console.log('hits     :', hits.length)
if (hits.length) console.log('first    :', JSON.stringify(hits[0]).slice(0, 160))

// 再走一遍完整 hook，看它自己怎么判
const writeConfig = (c) => {
    const dir = path.join(tmp, 'dsh-history-fold')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(c))
}
writeConfig({ enabled: true, recall: { enabled: true, dryRun: false, minIntervalMs: 0, gate: false } })
const handlers = []
plugin.apply({
    get tokenMeter() { return undefined },
    on(e, f) { if (e === 'agent/pre-step') handlers.push(f) },
    effect() {},
})
const userMsg = { id: 'u1', role: 'user', content: [{ type: 'text', text: q }], source: { kind: 'user' } }
const session = {
    header: { id: 'session-r1' },
    events: [{ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: q }], source: { kind: 'user' } } }],
    surface: { nodes: [0] },
}
const next = async () => ({ kind: 'enter', messages: [userMsg] })
let decision = null
for (const h of handlers) {
    const out = await h({ agent: { session }, step: 1, turn: 1, messages: [userMsg] }, next)
    if (out && Array.isArray(out.messages)) decision = out
}
const injected = ((decision && decision.messages) || []).filter((m) => m && m.source && m.source.kind === 'plugin')
console.log('injected :', injected.length)
const logFile = path.join(tmp, 'logs', 'history-fold.jsonl')
if (fs.existsSync(logFile)) {
    console.log('last log :', fs.readFileSync(logFile, 'utf8').trim().split('\n').pop())
}
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(0)
