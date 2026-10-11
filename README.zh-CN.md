# dsh-history-fold（中文说明）

> 英文主文档见 [README.md](README.md)。代码注释保持中文，本文件是完整的对照说明。

DSH 插件：把会话里**最老的一批** surface 节点折成一条消息，消息里带着**无损的本地归档**
路径，降低每轮请求带的历史 token 数。

- **装上什么都不做** ✓ 没有 `config.json` 时它不读、不写、也不记日志
- **无损** ✓ 被折的每条消息在折叠**提交之前**就已全文落盘，替换内容明确告诉模型去哪儿找
- **不改 `node_modules`** ✓ 用的是和官方压缩器同一套公开机制，DSH 升级不会把它弄坏

---

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

## 安全网

| 机制 | 作用 |
|---|---|
| **折之前先归档** | 被折掉的每一条消息的**全文**写进 `$DSH_HOME/history-fold/archive/<会话id>.jsonl` ✓ |
| **归档失败就不折** | 写归档抛异常 ⇒ 直接放弃这次折叠 ✓ 宁可慢也不丢 ✓ |
| **只留抽取式索引** | 替换内容**不是模型写的摘要** ✓ 没有 LLM 参与 ✓ |
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
  "keepRecentNodes": 60,
  "minFoldNodes": 20,
  "minFoldTokens": 20000,
  "archive": true,
  "archiveDir": "history-fold/archive",
  "digestMaxChars": 30000,
  "digestLineChars": 160,
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
| `triggerSurfaceTokens` | `250000` | 可见历史超过它才折 |
| `targetSurfaceTokens` | `180000` | 折到大约这么多就停 ✓ **必须够得着**（见下） |
| `keepRecentNodes` | `60` | 最近的这么多节点永不折 |
| `minFoldNodes` | `20` | 一次折得太少就不值当 |
| `minFoldTokens` | `20000` | 同上，按 token 算 |
| `archive` | `true` | 写无损归档 ✓ 别关 |
| `archiveDir` | `history-fold/archive` | 相对 `$DSH_HOME` |
| `digestMaxChars` | `30000` | 上下文里那份索引的上限 ✓ 超了**抽样不截断** |
| `digestLineChars` | `160` | 索引里每条显示多少字符 |
| `onlyAtTurnStart` | `true` | 只在一轮开头折 |
| `logFile` | `logs/history-fold.jsonl` | 相对 `$DSH_HOME` |
| `memoryFeed` | `false` | 折完把同一份摘要 POST 到记忆库 |
| `memoryFeedUrl` | — | 例：`http://127.0.0.1:7999/memory-eternal/api` |

> ⚠️ **`targetSurfaceTokens` 必须够得着**：至少有 `keepRecentNodes` 个节点会留下，
> 换算成 token 就是一条下限 ✓ 目标低于这条下限**永远达不到** ⇒ 每轮都记 `no-safe-cut` ✓
> （实测踩过：`keepRecentNodes: 9` + `targetSurfaceTokens: 2000` 就是这种自相矛盾）

### 和官方压缩的关系

官方 `dsh-compaction-basic` 在 `thresholdRatio × contextWindow` = `0.8 × 100 万` = **80 万**触发，
保留 `0.16 × window` = **16 万** ✓ 它的替换内容**是模型写的摘要，有损** ✗
把本插件的触发线压在 80 万以下，**官方的有损摘要就永远不会触发** ✓

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

## 折完之后怎么找回原文

替换内容里带着归档文件路径 ✓ 直接用普通工具搜，**不需要任何新工具** ✓
归档是每行一个 JSON：`{seq, type, src, text}` ✓

```powershell
rg -n "要找的词" "$env:USERPROFILE\.dsh\history-fold\archive\<会话id>.jsonl"
```

## 测试

```powershell
npm test            # 两套都跑
npm run test:fold
npm run test:profile
```

全离线 ✓ 不碰运行中的 DSH ✓ 不碰真实 `DSH_HOME` ✓（测试里把 `DSH_HOME` 指到临时目录）

现行规模：`fold-tests` **15 项**、`profile-tests` **8 项** ✓

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

## 已知边界

- 默认阈值是按 100 万上下文窗口调的 ✓ 机制本身与适配器无关，
  但**默认阈值不是通用的** ✗
- 折叠确实减少了模型能看到的东西 ✓ 归档保证可找回，但**不是没代价**：
  读回一次要花一次 `rg` 往返 ✓
- 目前**不与 `dsh-compaction-basic` 协同**，只是压在它的触发线之下 ✓

## 许可

MIT，见 [LICENSE](LICENSE)。
