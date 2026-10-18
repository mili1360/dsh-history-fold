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

export const name = fold.name

export function apply(ctx) {
    // Main product first: if anything is going to be alive, it is the fold.
    try {
        fold.apply(ctx)
    } catch {
        /* one module failing must not take the other down */
    }
    try {
        recall.register(ctx, {
            name,
            home: fold.dshHomeForRecall,
            readConfig: fold.readConfigForRecall,
            log: fold.logLineForRecall,
        })
    } catch {
        /* recall is an add-on: it failing must never affect the fold */
    }
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
} from './recall.js'
