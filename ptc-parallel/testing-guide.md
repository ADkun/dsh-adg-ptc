# testing-guide.md — ptc-parallel（`adg-ptc-parallel` 并行执行提示插件）

用例全表与未观测项。路由见 [AGENTS.md](AGENTS.md)，设计见 [design.md](design.md)。

## 用例总表

用例 ID：`G-*` = 判定逻辑（`isPtcAgent`）；`S-*` = 正文常量；`L-*` = 动态工具清单（分类 → 渲染 → 组装）；`W-*` = 接线层（假 ctx）；`C-*` = 文件契约（防漂移）；`M-*` = 真实挂载验证（重启 dsh 后在会话内核验）。

| ID | 测什么 | 怎么测 | 对应不变量 | 类型 |
|---|---|---|---|---|
| G1 | 判定：`tools` 服务不存在 ⇒ false | `node --test test`（G1 用例） | I1 / I2 | `[机检]` |
| G2 | 判定：`tools.get` 抛错（PTC runtime 缺失等）⇒ false 且不外抛 | 同上 | I2 | `[机检]` |
| G3 | 判定：`get` 返回 undefined（native scope）⇒ false | 同上 | I1 | `[机检]` |
| G4 | 判定：返回 run_code 定义 ⇒ true，且调用的正是 `tools.get('run_code', agent)`（scope 就是 agent 自己） | 同上 | I1 | `[机检]` |
| G5 | 判定：缺 ctx / 缺 agent / `ctx.get` 不是函数 ⇒ false（判据缺失不注入） | 同上 | I2 | `[机检]` |
| S1 | 正文：非空、含关键锚点（`Promise.all` / `run_code`） | 同上 | I3 | `[机检]` |
| S2 | 正文：讲的是**判据与机制**（并发 / 独占 / 上限），不写死上限数字 | 同上 | I3 / I10 | `[机检]` |
| S3 | **防回归（硬断言）**：`GUIDE_TEXT` 与 `CLASSIFICATION_NOTE` 里**不得出现任何工具名**（判定用的名字集合写在测试文件的 `TOOL_NAME_PATTERN` 里，本文档不抄一份 —— 抄一份就成第二份漂移源） | 同上 | I10 | `[机检]` |
| S4 | 过渡句：`CLASSIFICATION_NOTE` 非空，且说明清单是"现算"的 | 同上 | I10 | `[机检]` |
| L1 | 分类：有 `isConcurrencySafe` ⇒ 可并发；没有 ⇒ 独占；`run_code` 自己不进任何一列 | 同上（L1 用例） | I11 / I12 | `[机检]` |
| L2 | 分类：两列都按名称排序（输出稳定，不随迭代顺序抖） | 同上 | I12 | `[机检]` |
| L3 | 分类：`isConcurrencySafe` 存在但不是函数 ⇒ 归独占（形状不对就兜底） | 同上 | I11 | `[机检]` |
| L4 | 分类：只回答"有没有声明"，**绝不调用** `isConcurrencySafe`（无参探测会误判必填参数的工具） | 同上 | I11 | `[机检]` |
| L5 | 分类：入参不是可迭代集合 ⇒ 两列都空（不猜、不补默认值） | 同上 | I11 | `[机检]` |
| L6 | 渲染：两列各出一行、工具名用反引号包着；空列不渲染；两列都空返回空串 | 同上 | I12 / I13 | `[机检]` |
| L7 | 组装：混合定义 ⇒ 指引 + 过渡句 + 两列清单（清单里**不出现** `run_code`） | 同上 | I10 / I12 | `[机检]` |
| L8 | 组装：`tools` 服务不存在 ⇒ 只返回 `GUIDE_TEXT`（没有清单） | 同上 | I13 | `[机检]` |
| L9 | 组装：`view` 抛错 ⇒ 只返回 `GUIDE_TEXT`，不外抛 | 同上 | I13 | `[机检]` |
| L10 | 组装：可见工具为空 ⇒ 只返回 `GUIDE_TEXT`（清单整节不渲染） | 同上 | I13 | `[机检]` |
| L11 | 组装：scope 原样传给 `tools.view`（拿到的是那个 agent 自己的视图） | 同上 | I7 | `[机检]` |
| W1 | 契约三件套：`name === 'adg-ptc-parallel'` / `inject === ['systemPrompt']` / `apply` 是函数 | 同上 | I4 | `[机检]` |
| W2 | 挂载：恰好注册一个 `agent/created` 监听器，effect 标签 `adg-ptc-parallel.section()` 在位 | 同上 | I4 | `[机检]` |
| W3 | 调用：PTC 呈现的 agent 在**自己的 scope** 上注册了 section（name `adg:ptc-parallel` / order `810` / 取不到清单时 `text()` === GUIDE_TEXT） | 同上 | I7 / I13 | `[机检]` |
| W4 | 调用：非 PTC 呈现的 agent 一个 section 都不注册 | 同上 | I6 | `[机检]` |
| W5 | 调用：payload 里没有 agent 时不注册、也不抛错 | 同上 | I5 | `[机检]` |
| W6 | 调用：判定抛错时不外抛，且不注册（异常一律当"不是 PTC"） | 同上 | I2 / I5 | `[机检]` |
| W7 | 卸载：effect 返回的 disposer 移除监听器 | 同上 | I9 | `[机检]` |
| W8 | 调用：section 的 `text` 是 **provider**（吃 context），清单随组装现算 | 同上 | I14 | `[机检]` |
| C1 | 契约：`cordis.patch.yml` 的 insert id === `adg-ptc-parallel` === `index.mjs` 的 `export const name` | 同上（读文件做文本断言） | I1 | `[机检]` |
| C2 | 契约：`package.json` 的 name / main / `dsh.bundle.patch` 与实现一致 | 同上 | I1 | `[机检]` |
| C3 | 契约：`index.mjs` 源码里出现 section name `'adg:ptc-parallel'` 与 order `810` | 同上 | I7 | `[机检]` |
| C4 | 契约：`index.mjs` 的 `text` 是吃 context 的 provider，不是常量字符串 | 同上 | I14 | `[机检]` |
| M1 | 真实运行期：PTC 会话的系统提示词里出现「## PTC 并行执行（一次 run_code 里多做）」段 | 重启 dsh → 新建 Adg 对话 → 让模型读一次自己的系统提示词 | I7 | `[人]` |
| M2 | 真实运行期：**子代理**的系统提示词里也有这一段（判据是按 scope 的呈现模式逐 agent 判定，子代理也算） | 同一次会话里派一个子代理，看它的系统提示词 | I6 / design 未观测② | `[人]` |
| M3 | 真实运行期：非 PTC 会话（native 呈现）里**没有**这一段 | 在一个 native 模式的会话里读系统提示词 | I1 | `[人]` |
| M4 | 真实运行期：动态清单出现在系统提示词里，且两列与该 agent 的工具面对得上 | 同一次会话里让模型读一次自己的系统提示词，核对清单里的工具名 | I10 / design 未观测③ | `[人]` |
| M5 | 真实运行期：模型读完之后，一次 `run_code` 里**并行**发出了无依赖的多个子调用 | 同一次会话里让模型干一件有多步独立读取的活，数一轮 `run_code` 里的子调用个数 | design 未观测⑤ | `[人]` |

## 沙箱注意

仓库工作区里跑：`cd ptc-parallel && node --test --test-isolation=none test`（本机普通沙箱下 `node --test test` 也全绿，32 个用例）。本模块测试零副作用：不写盘、不起进程、不碰真会话、不联网。假 ctx 只实现 `apply()` 真正用到的 `effect` / `on` / `get`，不 import cordis。

## 漂移检测

- 插件名 ↔ insert 行 id：`ptc-parallel/index.mjs` 的 `export const name` 与 `ptc-parallel/cordis.patch.yml` 的 `- id:` 逐字一致（R6）。判据：`node -e "const a=await import('./index.mjs');const y=require('fs').readFileSync('cordis.patch.yml','utf8');const m=y.match(/- id: (\S+)/);console.log(a.name===m[1])"` 打印 `true`（C1 已把它钉住）。
- section 名 / order：`index.mjs` 里 `name: 'adg:ptc-parallel'` 与 `order: 810` 一字不差（C3 钉住）。改 order 时**同时**核对平台自己的 PTC-only 段（800）与文件引用段（900）还在原位，否则这段话会插到不该插的位置。
- 判定口径：`lib/guide.mjs` 的 `isPtcAgent()` 与 `RUN_CODE_NAME = 'run_code'` 是唯一判定处；改判据必须同步 G 系列（G1–G5）。
- **正文里的工具名**：S3 钉住"正文与过渡句不得出现任何工具名"。加任何工具名进 `GUIDE_TEXT` / `CLASSIFICATION_NOTE` 都会让 S3 变红 —— 这正是要的效果（工具清单必须现算，不许写死）。
- 分类口径：`classifyVisibleTools()` 与平台调度器同源（"有 `isConcurrencySafe` ⇒ 可并发"）。升级 dsh 后若平台改了分类规则（例如改成看别的字段），要同步 `classifyVisibleTools` 与 L 系列。
- 本模块不 import 任何 `@deepseek-ai/*` 包（I8）：判据是 `grep -c "@deepseek-ai" index.mjs lib/guide.mjs` 为 0。
- **未观测**：稳定副本 ↔ profile 副本是否随 `install.*` 全量对齐（新文件要重跑安装 —— notify 侧已实测过同形机制的这一坑）；量法：加一个新文件后跑 `install.ps1`，核对 `<profile>/node_modules/adg-ptc-parallel/` 里出现该文件。

## 覆盖边界（不许越界宣称）

单元测试证明不了监听器真的接到运行期（那是 cordis 运行期行为，归 M1–M3）。M 系列是抽样，证明不了**每个** PTC agent 都拿到了这一段。L 系列证明的是**分类与渲染逻辑**，不证明 dsh 运行期 `tools.view(scope)` 给出的 `visible` 就是模型真正能用的那套（L11 只证明 scope 原样传下去了）。安装脚本的三格断言只证明包在位，不证明 section 注册成功 —— 后者只能看 M1。**这段话是提示词，不是机制闸门**：M5 只能说"读完之后模型更常并行发"，不能推出"模型一定并行"。
