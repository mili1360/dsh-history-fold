# dsh-history-fold（中文说明）

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-community%20topic-blue)](https://github.com/topics/dsh-plugin)
[![deepseek-harness](https://img.shields.io/badge/deepseek--harness-plugin-4b6bfb)](https://github.com/topics/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> **Topics:** `dsh-plugin` · `deepseek-harness` · `history-fold` · `lossless-archive` ·
> `context-compaction` · `non-summary` · `recoverable` · `extractive-index`

> 英文主文档见 [README.md](README.md)。代码注释保持中文，本文件是完整的对照说明。

DSH 插件：把会话里**最老的一批** surface 节点折成一条消息，消息里带着**无损的本地归档**
路径，降低每轮请求带的历史 token 数。

- **装上什么都不做** ✓ 没有 `config.json` 时它不读、不写、也不记日志
- **无损** ✓ 被折的每条消息在折叠**提交之前**就已全文落盘，替换内容明确告诉模型去哪儿找
- **不改 `node_modules`** ✓ 用的是和官方压缩器同一套公开机制，DSH 升级不会把它弄坏

---
> 符号说明：**✓** = 实测确认过 · **✗** = 陷阱，别这么做 · **⚠️** = 注意 · **⇒** = 所以


## 为什么做

同一台机器上实测：一个长会话 vs 一个新会话

| | 长会话 | 新会话 |
|---|---|---|
| 历史 token | 497,141 | 少得多 |
| 输出/输入 比 | 0.20% | 0.64% |
| decode 速度 | 59 tok/s | 176 tok/s |
| 首 token 延迟 | 约 2.5 秒 | 约 2.5 秒 |

结论：**上下文长度拖慢的是「解码」，不是「首 token」** ✗
所以「上下文不影响速度」这个说法只对前半句成立。

## 怎么做的

和官方 `dsh-compaction-basic` **完全相同的机制**，一个字节的 `node_modules` 都不改：

```js
session.append('user/message', message, {
  surfaceOp: { op: 'replace', start, end },
  sourceEventSeqs: [...每一个被折的 seq...],
})
```

`dsh-session` 随后把替换节点 splice 回**被折区间的原位置**，时间顺序不变。

**触发线不是固定的 25 万 token**：默认是"上下文窗口的 `0.75`"，折到窗口的 `0.18` ✓
窗口能解析出来就按比例走，`config.json` 里显式写了绝对值则绝对值优先 ✓
详见 [配置](#配置) 里的解析顺序 ✓

### 写之前核对过的硬规则（全部来自真实源码，不是猜的）

| 规则 | 出处 |
|---|---|
| `surface.nodes` 是**普通 seq 数字数组**，不是对象 | `dsh-session` |
| `surfaceOp` 必须**恰好 3 个键** `op/start/end` | `dsh-session` |
| `sourceEventSeqs` 必须**包含每一个被折节点**、非空、每项严格小于新事件 seq | `dsh-session` |
| `user/message` 的 `data` 就是消息本体，需要 `id/role/source.kind/content` | `dsh-session` |
| 切点必须「工具调用配对平衡」 | 见下 |

「平衡」是按 `@deepseek-ai/dsh-compaction` 的 tool-pairing 规则自己重写的：
沿 surface 顺序走一遍，`assistant/message` 里的 `tool-call` 块加 N、`tool/result` 减 1，
计数为 0 的位置才是安全切点 ✓ **既不依赖 DSH 安装路径，也不会把工具调用和结果切开** ✓

## 替换内容 = 索引，不是摘要

进入上下文的那条消息是**通知 + 抽取式索引** ✗ —— 每一行都是那条消息**自己的原文前缀** ✓
**不调模型、不改写事实** ✓

```
[dsh-history-fold] 614 earlier messages (surface seqs 223995..387899) were folded out of the
visible history so this session stays fast.
NOTHING WAS DELETED. Their full text is archived at:
  <$DSH_HOME>/history-fold/archive/session-….jsonl
To read any of it verbatim, search that file with the pwsh or grep tools ...
The one-line index below is extractive, not a rewritten summary ...
(sampled: every 3th of 614 folded messages)
[0] user/message (plugin) seq=223995: This is an automatically generated checkpoint …
```

索引超预算时**抽样**（每 n 条取一条）而不是截断 ✓ 并如实写明抽样比例 ✓

## 分层索引：路径里有路径（2026-10-15）

上下文里那份索引超预算就**抽样**，而抽样步长**封顶在 64** ⇒ 折得越多，越老的那段索引越粗，
最后退化成「seqs A..B 里大概有东西」✗

所以每次折叠都多做一件事：把**没抽样的完整索引**写到磁盘，上下文里只留它的**路径** ✓

```
上下文里那条折叠消息
  |- 路径 -> $DSH_HOME/history-fold/index/<会话id>/f100-4500.md   <- 该段的完整索引（不抽样）
  |            \-- 路径 -> f20-99.md                             <- 更早那次折叠的完整索引
  |                         \-- 路径 -> f0-19.md
  \-- 路径 -> $DSH_HOME/history-fold/archive/<会话id>.jsonl       <- 全部原文
```

两条关键规则：

1. **折叠消息里带一行机器可读的标记** ✓
   `[fold-index] seqs=A..B messages=N file=<层索引路径>`
   ⇒ 下次它自己被折掉时能被解析出来，**而不是被截成 160 字符的桩** ✓
2. **这一行永不被抽样掉** ✓（抽样只抽普通消息行）
   ⇒ 否则它盖住的那段更老的记录就成了**孤儿** —— 上下文里再也没有路能走到它 ✗

于是每一层索引都靠自己那份磁盘文件活着 ✓ 上下文里只留**最短的这一层** ✓
打开一份层索引，能看到它盖住的**更老的层索引路径**（`## older tier files`）⇒
一层层往下走，最终到原文归档 ✓

**读它不花上下文** ✓ —— 不读就等于不存在，读了才付费 ✓

> ⚠️ 与官方压缩的区别仍在这里：官方每次都**重新写一份摘要**（本机实测一个会话压了 17 次，
> 每次输入都带着上一份摘要，输出新的把它盖掉）⇒ 老信息被反复重写 ✗
> 而这里是**写盘一次 + 留路径**，落盘的东西此后不再被动过 ✓

## 安全网

| 机制 | 作用 |
|---|---|
| **折之前先归档** | 被折掉的每一条消息的**全文**写进 `$DSH_HOME/history-fold/archive/<会话id>.jsonl` ✓ |
| **归档失败就不折** | 写归档抛异常 ⇒ 直接放弃这次折叠 ✓ 宁可慢也不丢 ✓ |
| **只留抽取式索引** | 替换内容**不是模型写的摘要** ✓ 没有 LLM 参与 ✓ |
| **层索引写失败不挡折叠** | 归档里已有全文 ⇒ 索引写失败只记一行 `index-failed`，照常折 ✓ 消息改指向原文归档 ✓ |
| **只动最老的一段** | 最近的 `keepRecentNodes` 个节点永不触碰 ✓ |
| **切点必须配对平衡** | 有未闭合的工具调用时绝不切 ✓ |
| **只在一轮开头折** | 步骤中间绝不折 ✓ |
| **出错一律放行** | 任何异常都 `next()` ✓ 绝不断你正常对话 ✓ |
| **默认 inert** | 没有 `config.json` ⇒ `enabled:false` + `dryRun:true` ⇒ 什么都不做 ✓ |

> ⚠️ 2026-10-11 修正：**在这之前，代码默认是 `enabled:true` + `dryRun:false`** ✗
> 与本文件和 `cordis.patch.yml` 里写的「安全默认」**完全相反** ✗
> 也就是说：一个新人 clone 下来装上，**它会立刻在 25 万 token 就开始动他的会话历史** ✓
> 已按文档承诺改成 inert，并加了测试守着这条承诺 ✓

## 配置

文件：`$DSH_HOME/dsh-history-fold/config.json`（默认 `~/.dsh/…`；**热读，改完不用重启**）

```json
{
  "enabled": false,
  "dryRun": true,
  "profile": true,
  "triggerSurfaceTokens": 250000,
  "targetSurfaceTokens": 180000,
  "triggerRatio": 0.75,
  "targetRatio": 0.18,
  "keepRecentNodes": 60,
  "minFoldNodes": 20,
  "minFoldTokens": 20000,
  "archive": true,
  "archiveDir": "history-fold/archive",
  "digestMaxChars": 30000,
  "digestLineChars": 160,
  "indexTree": true,
  "indexDir": "history-fold/index",
  "indexFull": true,
  "onlyAtTurnStart": true
}
```

要真开：把 `enabled` 改 `true`、`dryRun` 改 `false` ✓ 建议**先用 `dryRun: true` 跑一段**
看日志里的数字再决定 ✓

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关 ✓ `false` = 加载了但完全空转 |
| `dryRun` | `true` | `true` = 只看只记，绝不写 |
| `profile` | `true` | 每轮写一份体积剖析 |
| `triggerSurfaceTokens` | `250000` | 绝对触发线，**兜底用**（见下面的解析顺序）✓ 写在 `config.json` 里就优先于 `triggerRatio` |
| `targetSurfaceTokens` | `180000` | 绝对目标，**兜底用** ✓ 同上 ✓ **必须够得着**（见下） |
| `triggerRatio` | `0.75` | 可见历史超过**上下文窗口的这个比例**才折 ✓ 窗口能解析出来、且没写绝对值时用它 |
| `targetRatio` | `0.18` | 折到大约窗口的这个比例就停 |
| `keepRecentNodes` | `60` | 最近的这么多节点永不折 |
| `minFoldNodes` | `20` | 一次折得太少就不值当 |
| `minFoldTokens` | `20000` | 同上，按 token 算 |
| `archive` | `true` | 写无损归档 ✓ 别关 |
| `archiveDir` | `history-fold/archive` | 相对 `$DSH_HOME` |
| `digestMaxChars` | `30000` | 上下文里那份索引的上限 ✓ 超了**抽样不截断** |
| `digestLineChars` | `160` | 索引里每条显示多少字符 |
| `indexTree` | `true` | 写层索引、并把路径放进上下文 ✓ 关掉就退回"只有抽样索引"的旧行为 |
| `indexDir` | `history-fold/index` | 层索引目录，相对 `$DSH_HOME` |
| `indexFull` | `true` | 写**不抽样**的完整索引到磁盘 ✓ 关掉则只收集指针、不落新文件 |
| `onlyAtTurnStart` | `true` | 只在一轮开头折 |
| `logFile` | `logs/history-fold.jsonl` | 相对 `$DSH_HOME` |
| `memoryFeed` | `false` | 折完把同一份摘要 POST 到记忆库 |
| `memoryFeedUrl` | — | 例：`http://127.0.0.1:7999/memory-eternal/api` |

> ⚠️ **目标必须够得着**：至少有 `keepRecentNodes` 个节点会留下，
> 换算成 token 就是一条下限 ✓ 目标低于这条下限**永远达不到** ⇒ 每轮都记 `no-safe-cut` ✓
> （实测踩过：`keepRecentNodes: 9` + `targetSurfaceTokens: 2000` 就是这种自相矛盾）
> 目标**大于等于触发线**同样永远够不着（折到目标就停，而 surface 一开始就高于触发线）⇒
> 走的是同一条 `no-safe-cut`，没有为比例另造行为 ✓

### 两个阈值是怎么算出来的

`triggerSurfaceTokens` / `triggerRatio`（目标同理）**每轮按这个顺序、按 key 各自解析**：

1. **`config.json` 里写了这个 key** ⇒ 用这个绝对值 ✓ 写了 `triggerSurfaceTokens: 300000`
   就是 300000，窗口解析得出来也不改变它 ✓ 注意"写了"指的是**原始文件里存在这个 key**，
   不是合并后的配置对象 —— `DEFAULTS` 里也带着这两个 key，用合并对象判断的话永远命中，
   比例就永远轮不上 ✓
2. **否则，窗口能解析出来** ⇒ `floor(窗口 × 比例)` ✓ 窗口取自
   `ctx.llm.resolveModelInfo(provider, model, signal).context.contextWindow`，
   和官方 `dsh-compaction-basic` 算自己那条线用的是同一个查询 ✓
3. **否则** ⇒ 用出厂的绝对默认值，日志里写 `default` ✓

**为什么默认是 0.75 / 0.18，而且必须压在官方那条线下面。**
官方 `dsh-compaction-basic` 在 `thresholdRatio × contextWindow` 触发 —— 默认 `0.8 × 100 万` =
80 万 —— 并保留 `0.16 × 窗口`（16 万）✓ 它的替代品是**模型写的摘要**，是有损的 ✓
`0.75`（100 万窗口的 75 万）**刚好压在那条线之下**，这就是"让摘要器永远不触发"的办法；
`0.18`（18 万）对应它的 0.16 ✓ 这两个默认值就是本项目自己那套绝对值（75 万 / 18 万，
即 100 万窗口的 0.75 / 0.18）写成了比例，换个窗口也照样成立 ✓

每一条 profile / 折叠日志都带着这些字段：`windowTokens`（解析到的窗口，没有就是 `null`）、
`triggerSource` / `targetSource` = `absolute` | `ratio` | `default` ✓
比例不在 `(0, 1)` 内（`0`、`1`、`1.5`、`"0.75"`、`null`）**不会抛错、也不会变成一条坏阈值**：
按第 3 条兜底，并在同一行写 `triggerRatioInvalid` / `targetRatioInvalid` 说明原因 ✓

### 和官方压缩、以及和"叫 fold 的其他插件"的关系

| | 官方 `dsh-compaction-basic` | 本插件 | UI 折叠类插件 |
|---|---|---|---|
| 历史被换成什么 | **模型写的摘要** | **抽取式索引** + 归档路径 | 什么都不换，请求原样不动 |
| 每次折叠的成本 | 多一次模型调用 | 零，压根不调模型 | 零 |
| 原文还在吗 | ✗ 只剩摘要 | ✓ 逐字写在 `$DSH_HOME/history-fold/archive/` | n/a |
| 能找回来吗 | ✗ | ✓ 一条 `rg` 就行 | n/a |
| 改的是什么 | surface（发给模型的东西） | surface（发给模型的东西） | **显示**（长消息在界面上折起来看） |
| 触发线 | `thresholdRatio × contextWindow`，默认 80 万 | `triggerRatio × contextWindow`（0.75 ⇒ 75 万），压在官方那条线下；写了绝对 `triggerSurfaceTokens` 仍然优先 | n/a |

名字里带 `fold` 的插件，很多是**界面折叠**：把一条长消息在 UI 里折起来方便看，
**请求体一个字节都不动** ✓ 本插件恰好相反 —— 完全不碰界面，
它搬的每一个字节都是为了**下一轮请求的 token** ✓
装之前先想清楚你要的是哪一种。

同一个问题的**磁盘侧**（会话日志因为"定稿后的流式碎片永不清理"而膨胀）见
[dsh-session-vacuum](https://github.com/mili1360/dsh-session-vacuum) ✓

**判定用的是真实 token 计量器**（`ctx.tokenMeter.measure`）✓ **看不到计量器就拒绝折叠** ✓
因为节点体积差好几个数量级，**用节点数当预算是不成立的** ✓

## 日志

`$DSH_HOME/logs/history-fold.jsonl`，每行一个 JSON：

- `profile` —— 每轮一份体积剖析：`surfaceTokens`、按类型/来源的 token 分布、最大节点、
  以及各 `keepRecent` 能省多少 ✓ **策略就是照它调的** ✓
- `idle` —— 没到触发线
- `no-safe-cut` —— 到了线但找不到安全切点，或折得太少
- `no-meter` —— 看不到计量器，拒绝盲折
- `would-fold` —— dry-run 下「本来会折多少、从哪到哪、省百分之几」
- `folding` / `folded` —— 真折了（两行都带 `surfaceTokens` / `foldTokens` / `startSeq` / `endSeq`）
- `archive-failed` —— 归档写不进去 ⇒ 这次不折
- `error` —— 出错了（**一律放行**）

以上每一行都带着本轮**实际用到**的阈值，不用猜走的是哪条路：

- `trigger` / `target` —— 本轮真正用的两条线（token）
- `windowTokens` —— 解析到的上下文窗口；解析不出来就是 `null`
- `triggerSource` / `targetSource` —— `absolute`（`config.json` 里写了）/ `ratio`（`floor(窗口 × 比例)`）/ `default`（出厂绝对兜底）
- `triggerRatioInvalid` / `targetRatioInvalid` —— 只在比例不可用、按第 3 条兜底时出现且为 `true`
- `via` —— 哪条路拿到计量器、哪条路拿到 `llm`（例：`ctx.tokenMeter|llm:ctx.reflect.get/agent.options`）

## 折完之后怎么找回原文

替换内容里带着归档文件路径 ✓ 直接用普通工具搜，**不需要任何新工具** ✓
归档是每行一个 JSON：`{seq, type, src, text}` ✓

```powershell
rg -n "要找的词" "$env:USERPROFILE\.dsh\history-fold\archive\<会话id>.jsonl"
```

**更老的东西怎么找**（2026-10-15 起）：上下文里那条折叠消息还会给出**层索引路径** ✓

1. 先读它给的那份层索引（`...\history-fold\index\<会话id>\f<起始seq>-<结束seq>.md`）
2. 那份文件里 `## older tier files` 一节列着它盖住的**更早的层索引路径** ⇒ 一层层往下走
3. 走到 `## message index` 里想找的那条，拿到 `seq`，再去归档里搜那条原文 ✓

每一层都是普通 markdown ✓ 用 `read` / `rg` 就行 ✓ **不读不花上下文** ✓

## 测试

```powershell
npm test            # 四套都跑
npm run test:fold
npm run test:profile
npm run test:edge
npm run test:ratio  # 窗口比例：解析顺序、兜底、非法比例
npm run test:mutate # 故意塞回 10 个真实缺陷，要求每套都变红
```

全离线 ✓ 不碰运行中的 DSH ✓ 不碰真实 `DSH_HOME` ✓（测试里把 `DSH_HOME` 指到临时目录）
`ratio-tests` 用的 `llm` 是三行假对象 ✓ **不 import 任何真实 DSH 服务** ✓

现行规模：`fold-tests` **15 项**、`profile-tests` **8 项**、`edge-tests` **19 项**、
`ratio-tests` **31 项**；变异测试 **10 / 10 全部被抓** ✓

`ratio-tests` 覆盖：比例路径（`floor(窗口 × 比例)`，含非整数乘积向下取整）、
绝对覆盖（写了 `triggerSurfaceTokens` / `targetSurfaceTokens` 时它赢，另一个 key 仍按比例）、
窗口解析不出来的每种情形（没有 `ctx.llm`、`resolveModelInfo` 抛错、没有 `context`、
窗口为 0 / 负数 / 小数 / 字符串、agent 上没有 provider+model）、非法比例（`0`、`1`、`1.5`、
`"0.75"`、`null`、`-0.5`、`NaN`）、以及目标够不着时走既有的 `no-safe-cut`，
外加三条取 `llm` 的路径（`ctx.llm` / `ctx.reflect.get` / `payload.agent.ctx.llm`）✓

覆盖：无 `config.json` 必须 inert、关闭时不写不记、未达阈值不折、dry-run 不写、
`surfaceOp`/`sourceEventSeqs`/切点平衡逐项校验、**归档必须先于折叠且正文逐字保留**、
不在步骤中途折、surface 与日志不一致时拒绝折、有未闭合工具调用时不折、
永远调 `next()`、异常时放行并记日志 ✓

> ⚠️ **给贡献者**：`test()` **必须 `await fn()`** ✗
> 同步的框架会在任何 async 断言执行之前就打 `ok`，并且让脚本先走到 `process.exit(0)`
> ⇒ **整套测试静默变成空跑** ✓ 本项目曾经带着这个 bug 跑了很久（对外一直报「13 passed, 0 failed」，
> 修好后立刻变成「6 passed, 7 failed」）✓ 详见 `CHANGELOG.md`

## 装 / 卸

挂载点在 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: history-fold
      name: 'file:///path/to/dsh-history-fold/lib/index.js'
```

- **需要重启 DSH 才加载**
- 想临时关掉：把 `config.json` 里 `enabled` 改回 `false`（热读，不用重启）
- 想彻底卸掉：删掉上面那两行，重启 ✓ 归档目录是它唯一留下的东西

## 要求 / 兼容性

**装上之后要确认它真的在工作** ✓ 光"profile 起得来"不算数 ✗
插件可能加载得好好的、路由也活着，却把宿主弄坏 —— 我们真踩过 ✓
验收动作: **新建一个会话、发一条消息** ✓
然后看 `$DSH_HOME/logs/history-fold.jsonl` 里有没有 `profile` 行（观察模式），
或 `idle` / `would-fold` / `folded` 行 ✓
如果连新会话都建不出来 ⇒ 把上面那行挂载删掉、重启 ✓

针对 **DSH `0.1.0-rc.7`** 开发并测试 —— 这是一个**魔改版**，不是官方原版。别的版本可能把服务
或事件名改掉：本插件用到 `ctx.on`、`ctx.effect`、`ctx.tokenMeter`、`ctx.reflect`、`ctx.llm`
和 `agent/pre-step` 事件。

### DSH 0.2.0（实测 `0.2.0-rc.2`）—— 已支持

0.2.0 上完整验证过：连折三次、**每一轮都正常结束**、折叠消息**写进了盘上的
`session.v4.jsonl.zstd`**、**重启后会话重载成功并继续折**、磁盘上的层索引里也有套娃指针 ✓

0.2.0 改了四处 API，其中**三处是静默失败**：

| 改了什么 | 0.1.x | 0.2.0 | 写错的后果 |
|---|---|---|---|
| 读事件 | `session.events`，每条自带 `seq` | **没有这个成员**；日志是**位置数组**（`eventAt(seq)` 就是 `log[seq]`），另有 `snapshotEvents()` | 每个节点读成 `unknown` / 0 字节 ⇒ 永远找不到安全切点 ⇒ **永远 `no-safe-cut`，而且不报任何错** |
| 折叠范围的键 | `{op:'replace', start, end}` | `{op:'replace', **startSeq, endSeq**}` | `isReplaceOp` **直接抛错**，折叠被拒 |
| 表面头部 | 表面里没有系统消息 | **node 0 是系统提示，受保护** | 任何碰到 node 0 的 replace **直接抛错**："may be rewritten only by a system/message over exactly that node" |
| 消息的 `source` | `{kind:'plugin', plugin:X}` | **这个包装已退役**；消息必须带**生产者自己的**类型名 —— 第三方插件是 `plugin:<名字>` | `append` **成功**，然后**写盘时的行准入**抛错 ⇒ **那一轮永远不结束**、会话不再落盘、之后每一轮都卡死。**宿主一个字都不报** |

插件会**按宿主自动选** replace 的键形状和 source 拼写，并且**从受保护头部之后开始折**；
头部的 token 会留在"够不够得着目标"的算术里。日志行会写明用了哪种形状（`surfaceOpKeys`）
和跳过了几个前缀节点（`protectedCount`）。

版本对不上时，插件**不会**让 profile 起不来 ✓ 它会直接**停用**，并在
`logs/history-fold.jsonl` 里留一行：

```json
{"mark":"deactivated","reason":"registration-failed","step":"services","error":"..."}
```

**万一装上之后 profile 根本起不来**：把 `<profile>/cordis.patch.yml` 里挂载它的那几行删掉
（若你是用 `dsh.profile.bundles` 装的，就把数组里的 `"dsh-history-fold"` 去掉），然后重启：

```yaml
- insert:
    - id: dsh-history-fold
      name: 'file:///path/to/dsh-history-fold/lib/index.js'
```

## 已知边界

- 默认阈值是按 100 万上下文窗口调的 ✓ 机制本身与适配器无关，
  但**出厂绝对兜底值不是通用的** ✗ —— 这正是加比例的原因：窗口能解析出来时，
  两条线就跟着窗口走 ✓
- **`ctx.llm` 这条取值路已经在真实 DSH 上跑通了** ✓（2026-10-12 实测，沙箱实例、`web` profile）
  配置里只留比例、不放绝对键时，日志记的是
  `windowTokens:1000000` / `trigger:750000` / `target:180000` /
  `triggerSource:"ratio"` / `via:"ctx.reflect.get|llm:ctx.reflect.get/agent.options"`
  —— 也就是说它走的是 `ctx.reflect.get` 拿到 `llm`、再从 `agent.options` 取 provider/model ✓
  取值方式与 `resolveMeter()` 一致（先直接属性，再 `ctx.reflect.get`，再 `agent.ctx`），全程不抛错 ✓
  万一你的 build 三条路都不通，日志里会是 `triggerSource: "default"`，
  行为与加这个功能之前完全一致 ✓
- 折叠确实减少了模型能看到的东西 ✓ 归档保证可找回，但**不是没代价**：
  读回一次要花一次 `rg` 往返 ✓
- 目前**不与 `dsh-compaction-basic` 协同**，只是压在它的触发线之下 ✓

## 相关插件

同一套东西，三个插件各治一头 —— 都是"会话越跑越长、越贵越慢"这件事：

- **[dsh-session-vacuum](https://github.com/mili1360/dsh-session-vacuum)** —— 开机后把会话日志里
  "定稿后没人读"的流式碎片删掉，长会话加载时不再膨胀成几个 GB ✓
  （和本插件不在同一层：那个减的是磁盘上的日志，本插件减的是**每轮请求带的 token**）
- **[dsh-proactive](https://github.com/mili1360/dsh-proactive)** —— 长任务在 agent 回合结束后才跑完时，
  把它叫醒主动汇报 ✓


## 许可

MIT，见 [LICENSE](LICENSE)。
