// ============================================================
//  dsh-history-fold —— 入口：两个模块，各自独立
// ============================================================
//  fold.js   把老历史折成索引（原文进 archive）
//  recall.js 每轮自动去 archive / 笔记里检索，命中就注入一小段
//
//  为什么分模块而不是一个文件：
//    fold 出错 = 丢历史（最坏），recall 出错 = 少一段提示。
//    塞进一个文件时，一条关键词切分的小 bug 就能拖垮折叠路径，
//    而且出事时不知道该怪谁。所以：
//      - 两个 apply 各自 try/catch，一个倒了另一个照跑
//      - 折叠用配置文件的顶层键，回忆只读 `recall` 段
//      - 各自有 enabled
//
//  ASCII ONLY on purpose -- this box runs a GBK code page.
// ============================================================

import * as fold from './fold.js'
import * as recall from './recall.js'
import * as notes from './notes.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Read our own version for the boot line. Wrapped: a missing package.json must never take
// the plugin down, it only loses one field in a log line.
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
function pluginVersion() {
    try {
        return String(JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8')).version || '')
    } catch {
        return ''
    }
}

export const name = fold.name

// The recall_memory tool needs ctx.tools, and Cordis only exposes a service the plugin declares.
// Without this line registration fails with: cannot get property "tools" without inject (seen live
// 2026-10-18 10:40:55, right after the tool was added).
//
// `commands` was added 2026-10-30 for the /fold command. The same rule applies: without declaring
// it, ctx.commands is undefined inside apply() and the command cannot register. fold.js checks for
// ctx.commands before using it, so a host that lacks the registry simply skips the command rather
// than failing to load.
export const inject = ['tools', 'commands']

export function apply(ctx) {
    // The explicit door (recall_memory). Registered separately from the hook: if the tool API
    // is missing in some build, the hook keeps working and vice versa.
    try {
        recall.registerRecallTool(ctx, {
            name,
            home: fold.dshHomeForRecall,
            readConfig: fold.readConfigForRecall,
            log: fold.logLineForRecall,
        })
    } catch (err) {
        try {
            fold.logLineForRecall({ mark: 'module-failed', module: 'tool', error: String((err && err.message) || err) })
        } catch { /* nothing left */ }
    }

    // Main product first: if anything is going to be alive, it is the fold.
    // A swallowed exception here would be invisible AND fatal: the plugin would simply do
    // nothing, with no line anywhere saying why. So both failures are logged.
    try {
        fold.apply(ctx)
    } catch (err) {
        try {
            fold.logLineForRecall({ mark: 'module-failed', module: 'fold', error: String((err && err.message) || err) })
        } catch { /* nothing left to do */ }
    }
    try {
        recall.register(ctx, {
            name,
            home: fold.dshHomeForRecall,
            readConfig: fold.readConfigForRecall,
            log: fold.logLineForRecall,
        })
    } catch (err) {
        try {
            fold.logLineForRecall({ mark: 'module-failed', module: 'recall', error: String((err && err.message) || err) })
        } catch { /* nothing left to do */ }
    }

    // notes: mine the whole session log into notes/ (day files + event ledger) on a timer.
    // Third try/catch for the same reason as the others -- mining must never take recall down.
    try {
        notes.register(ctx, {
            home: fold.dshHomeForRecall,
            notes: (fold.readConfigForRecall().notes) || {},
        }, fold.logLineForRecall)
    } catch (err) {
        try {
            fold.logLineForRecall({ mark: 'module-failed', module: 'notes', error: String((err && err.message) || err) })
        } catch { /* nothing left to do */ }
    }

    // One line saying "this plugin really came up, inside THIS host". Without it, a plugin
    // that loads and then does nothing looks exactly like one that never loaded at all --
    // which is precisely the ambiguity we hit when checking the plugin against a newer dsh
    // (2026-10-24). host/version are recorded so the log itself answers "which runtime?".
    try {
        // A disabled plugin must stay completely quiet -- the tests check that no log line at
        // all appears, and "disabled but still chatting in the log" was exactly the kind of
        // half-off state this plugin exists to avoid.
        const liveCfg = fold.readConfigForRecall()
        if (liveCfg.enabled !== false) {
            fold.logLineForRecall({
                mark: 'boot',
                plugin: name,
                version: pluginVersion(),
                host: process.version,
                dsh: process.env.DSH_VERSION || '',
                tools: Boolean(ctx && ctx.tools),
            })
        }
    } catch { /* logging must never break a load */ }
}

// Re-exported so tests and a REPL can reach the pure functions without importing
// the module file directly.
export {
    extractKeywords,
    searchArchive,
    searchNotes,
    formatBlock,
    lastUserText,
    snippetOf,
    isRepetitiveRun,
    registerRecallTool,
    buildRecallTool,
    noteCacheSize,
    noteCacheClear,
    ownNotesDir,
} from './recall.js'

// The semantic layer lives in its own module; re-export it so tests can reach it directly.
export { semanticSearch, archiveVectors, SEM_DEFAULTS } from './semantic.js'

// Notes/mining module: pure functions only, so tests can feed it a string of JSONL.
export { scanZstdFrames, decodeSessionLog, mineNotes, newestSessionLog, allSessionLogs, refreshNotes, NOTES_DEFAULTS } from './notes.js'
