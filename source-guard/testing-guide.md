# testing-guide.md — source-guard（`adg-source-guard` 源码守卫插件）

用例全表与未观测项。路由见 [AGENTS.md](AGENTS.md)，设计见 [design.md](design.md)。

## 用例总表

用例 ID：`D-*` = `test/policy.test.mjs`（纯函数：成败分流策略）；`W-*` = `test/plugin.test.mjs`（假 ctx 接线）；`M-*` = 真实挂载验证（重启 dsh 后人工/会话内核验）。

| ID | 测什么 | 怎么测 | 对应不变量 | 类型 |
|---|---|---|---|---|
| D1 | 管辖判据：顶层 run_code 命中 | `node --test test`（`governs` 用例组） | I2 | `[机检]` |
| D2 | 非 run_code 一律不命中（read / write / bash / 大小写变形 / 缺失） | 同上 | I2 | `[机检]` |
| D3 | PTC 子分发不命中（`parent` 为 token 或对象） | 同上 | I2 | `[机检]` |
| D4 | `exec` 缺形状（null / undefined / 字符串 / 数字）不抛错、不命中 | 同上 | I2 | `[机检]` |
| D5 | 意图读取：`arguments.description` 取到并 trim；缺失 / 非字符串 / 整体非对象返回空串 | `intentOf` 用例组 | I2 | `[机检]` |
| D6 | 成功路径：意图块前置（文本以 `\n` 结尾）+ 原有正文，顺序与引用都不变 | `applyPolicy` 用例 | I4 / I9 | `[机检]` |
| D7 | 意图块形状：恰好 `{type:'text', text}` 两个键；缺省不带尾换行 | `successPrefixBlocks` 用例 | I4 / I9 | `[机检]` |
| D8 | 意图缺失且前缀为空时不出任何块，正文与平台默认逐字相同 | `applyPolicy` 用例 | I4 | `[机检]` |
| D8b | 意图缺失时 `successPrefixBlocks` 返回空数组（不出现"已执行代码："字样） | `successPrefixBlocks` 用例 | I4 | `[机检]` |
| D9 | `result` 无 content 数组时只出意图块，不抛错 | 同上 | I6 | `[机检]` |
| D10 | 失败路径：`isError:true` 原样返回，不加任何东西 | 同上 | I1 | `[机检]` |
| D11 | 失败路径：即使上游决策已带 content 也逐块相等不动它 | 同上 | I1 | `[机检]` |
| D12 | 非 accept 决策（block / feedback）原样返回 | 同上 | I2 | `[机检]` |
| D13 | 带 `value` 的 accept 原样返回（平台禁止 value+content 同取） | 同上 | I3 | `[机检]` |
| D14 | 非管辖 exec（别的工具 / 子分发）的决策原样返回 | 同上 | I2 | `[机检]` |
| D15 | `decision` 不是对象（null / undefined / 字符串 / 0）时原样返回 | 同上 | I6 | `[机检]` |
| D16 | `additionalContexts` / `meta` 等字段随决策透传 | 同上 | I4 | `[机检]` |
| D17 | 决策自带 content 时接在说明块之后，不覆盖上游正文（意图块文本带 `\n`） | 同上 | I4 / I9 | `[机检]` |
| D18 | 契约常量形状：`TOOL_NAME === 'run_code'`、`FAILURE_PREFIX === ''`、`SUCCESS_PREFIX === ''`（前缀句默认关闭） | 契约常量用例 | I2 | `[机检]` |
| D21 | 意图块在有正文时自带换行结尾；无正文（缺省 / `followedByBody:false`）时不带 | `successPrefixBlocks` 用例 | I9 | `[机检]` |
| D22 | 下游空串拼接后意图与正文之间仍有换行（边界不靠块） | `applyPolicy` 用例 | I9 | `[机检]` |
| W1 | 契约三件套：`name === 'adg-source-guard'` / `inject === ['tools']` / `apply` 是函数 | 假 ctx 用例 | I7 | `[机检]` |
| W2 | 挂载：恰好注册一个 `tools/post-execute` 监听器，`{prepend:true}`，effect 标签在位 | 同上 | I7 | `[机检]` |
| W3 | 调用：`next()` 之后成功 run_code 被改写（意图块文本以 `\n` 结尾 + 原正文），`next()` 只被调一次 | 同上 | I4 / I9 | `[机检]` |
| W3b | 调用：意图缺失时只回平台正文（与未装插件逐字相同，不多一个块） | 同上 | I4 | `[机检]` |
| W3c | 调用：正文缺失但有意图时只出意图块（不造空 content 数组） | 同上 | I6 | `[机检]` |
| W3d | 接线层：下游空串拼接后意图与正文之间仍有换行 | 同上 | I9 | `[机检]` |
| W4 | 调用：失败结果原样返回 `next()` 的决策（接线层也守住 R1） | 同上 | I1 | `[机检]` |
| W5 | 调用：非 run_code 原样返回 | 同上 | I2 | `[机检]` |
| W6 | 卸载：effect 返回的 disposer 移除监听器 | 同上 | I7 | `[机检]` |
| W7 | 策略抛错时不外抛：落一条 warn 并返回 `next()` 的决策 | 同上 | I6 | `[机检]` |
| M1 | 真实运行期：成功的 run_code 结果正文多出「已执行代码：<当次 description>」一行（前缀句默认不出现） | 重启 dsh → 新 Adg 对话 → 让模型跑一次成功 run_code | I4 / design 未观测① | `[人]` |
| M2 | 真实运行期：失败的 run_code 结果与未装本插件时逐字相同 | 同一次会话里让模型跑一次会抛错的 run_code | I1 | `[人]` |
| M3 | 子代理的 run_code 也被覆盖（全局层注册的预期行为） | 派一个子代理，让它在自己会话里跑成功 run_code | design 未观测② | `[人]` |
| M4 | 其它工具的结果一个字节都没动 | 同一次会话里读文件 / 搜索，对比装前装后 | I2 | `[人]` |

## 沙箱注意

仓库工作区里跑：`cd source-guard && node --test --test-isolation=none test`。本模块测试零副作用：不写盘、不起进程、不碰真会话、不联网。

## 漂移检测

- 插件名 ↔ insert 行 id：`source-guard/index.mjs` 的 `export const name` 与 `source-guard/cordis.patch.yml` 的 `- id:` 逐字一致（R7）。判据：`node -e "const a=await import('./index.mjs');const y=require('fs').readFileSync('cordis.patch.yml','utf8');const m=y.match(/- id: (\S+)/);console.log(a.name===m[1])"` 打印 `true`。
- 事件名与 prepend Flag：`index.mjs` 里 `ctx.on('tools/post-execute', ..., { prepend: true })` 一字不差（W2 钉住）。
- 管辖判据与工具名：`lib/policy.mjs` 的 `TOOL_NAME` 与 `governs()` 同步（D18 + D1/D2 钉住）；改判据必须同步 D 系列。
- 本模块不 import 任何 `@deepseek-ai/*` 包（R5 的一半）：判据是 `grep -c "@deepseek-ai" index.mjs lib/policy.mjs` 为 0。
- **未观测**：稳定副本 ↔ profile 副本是否随 `install.*` 全量对齐（新文件要重跑安装 —— notify 侧已实测过同形机制的这一坑）；量法：加一个新文件后跑 `install.ps1`，核对 `<profile>/node_modules/adg-source-guard/` 里出现该文件。

## 覆盖边界（不许越界宣称）

单元测试证明不了监听器真的接到运行期（那是 cordis 运行期行为，归 M1–M3）；M 系列是抽样，证明不了**每次** run_code 都被改写。安装脚本的三格断言只证明包在位，不证明监听器注册成功 —— 后者只能看 M1。**M2 的"逐字相同"只覆盖 `tool/result` 的 content**：`tool/call` 的 `arguments`（源码全文）平台没有改写点，本插件从头到尾不碰它（design.md 第 1 节）。
