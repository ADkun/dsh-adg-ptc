---
title: tools 模块测试指南
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-05
---

# tools 模块测试指南

对象与不变量见 [`design.md`](design.md)（本文件不复制它的内容，只给用例与判据）。**判据一律是"跑哪条命令、看哪一行输出、期望什么退出码"，不是任何一次运行的读数**：生成物字节数、`allow` 项数、警告条数、报告行数都会随 persona 或 composition 的每一次编辑漂移，只作为当场读数用来核"这次改动动了什么"，**不许当锚**。

准备动作（下称"夹具 A"）：把 `preset/agent.cordis.yml` 复制到临时文件，只改副本，绝不改仓库里的那份。**读写一律走 UTF-8 感知的工具**（node 的 `fs.readFileSync(p,'utf8')`，或本仓库的 read / edit 工具）：那份文件是 UTF-8 **无 BOM**，Windows PowerShell 的 `Get-Content` / `Set-Content` 会按 ANSI 误读成乱码并改变行数，届时校验器会报出一份看着像"委派行全丢了"的假报告。

## 用例总表

用例 ID：`T-*` = `check-preset.mjs`，`G-*` = `gen-preset-bundle.mjs`，`F-*` = `check-bundle-flavor.mjs` 与四种味道，`P-*` = 探测与味道映射（`has-bundle.mjs` / `resolve-flavor.mjs`），`R-*` = 人工 review 项。「对应不变量」列沿用 [`design.md`](design.md) 的 I1..I9 与两个状态机（`KnobRow →` / `ExitStatus →`）。

| 用例 | 对象 | 断言内容 | 对应不变量/迁移 | 载体 |
|---|---|---|---|---|
| T-1 | `allow` 里的策略性越界名 | 给夹具 A 的委派行（`- id: agent` 那一段，本身刻意不写 `allow`）临时补一段 `allow:` 并加 `agent`、`delegate`、`set_child_permission`、`bash`、`read_image`、`subagent_codex`、`workflow`、`ralph`，逐个跑 `node tools/check-preset.mjs <夹具>` | I1 | 机检：`agent` / `delegate` / `set_child_permission` / `bash` / `read_image` / `subagent_codex` 各自只出现一条 `WARN`、退出码 `0`；`workflow` / `ralph` 各一条 `ERROR`（这两个名字不在 composition 的注册面里）、退出码 `1` |
| T-2 | `allow` 里的未注册名 | 同上加 `not_a_tool_name` | I1 | 机检：`ERROR ... allow 里的 "not_a_tool_name" 不是本组合注册过的工具名`，退出码 `1` |
| T-3 | 委派行不唯一 | 复制 `- id: agent` 那一行块（同 `toolName` 两条） | I1 | 机检：`ERROR … 有 2 个 toolName: agent 的委派入口（…）：委派入口必须唯一，能力面由 delegate 在委派时给`、退出码 `1` |
| T-4 | `FACTORY_DEFAULTS` 的用法 | 全文检索 `check-preset.mjs`，查是否存在"取值 == 期望值"的比较 | I2 | 人：`FACTORY_DEFAULTS` 只参与摘要打印，不出现在任何 `fail()` 分支 |
| T-5 | 显式写回的合法覆盖 | 夹具 A 的 `compaction-basic` 写回 `thresholdRatio: 0.9` / `retainRatio: 0.05` | I2 | 机检：无 `ERROR`；摘要里对应键标成 `（已覆盖）` |
| T-6 | 旋钮行存在性 | 从夹具 A 删掉 `- id: tool-result-pruner` 那一行块 | I3 / `KnobRow →` 命中 0 条 | 机检：`ERROR ... 找不到 tool-result-pruner 行`，退出码 `1` |
| T-7 | 期望包名 | 把 `- id: tool-web` 那行的 `name:` 改成别的包名 | I3 / `declared → declared` 滞留 | 机检：`ERROR ... name 应为 <期望包名>` |
| T-8 | 行被关掉 | 在 `- id: tool-web` 行同级加 `disabled: true` | I3 | 机检：`ERROR ... 被 disabled: true 关掉了` |
| T-9 | 重复 id | 复制一整块 `- id: tool-web` 行块（同 id 两条） | I3 / `KnobRow →` 命中 ≥ 2 条 | 机检：`ERROR ... 命中 2 条 ... 哪一行生效不可判定`，且**不再**对第一条做取值比较 |
| T-10 | 旋钮键的位置 | 把 `fetchMaxOutputChars` 提到与 `name:` 同级 | I4 / `declared → declared` 滞留 | 机检：`ERROR ... 被提到与 name: 同级` |
| T-11 | 旋钮键嵌得更深 | 把 pruner 的 `thresholdChars` 嵌到 `config: > someBlock: > thresholdChars` | I4 | 机检：`ERROR ... 写在了 ...，不是直接挂在 config: 下` |
| T-12 | ratio 不变量 | `compaction-basic` 写 `thresholdRatio: 0.6` + `retainRatio: 0.7` | I5 | 机检：`ERROR ... retainRatio 0.7 必须小于 thresholdRatio 0.6` |
| T-13 | ratio 范围 | `compaction-basic` 写 `thresholdRatio: 1.5` | I5 | 机检：`ERROR ... 超出 (0,1]` |
| T-14 | 正整数 | pruner 写 `thresholdChars: 8192` + `headChars: 4.5` | I5 | 机检：`ERROR ... 不是十进制正整数` |
| T-15 | `fetchMaxOutputChars` 上界 | `tool-web` 写 `fetchMaxOutputChars: 250000` | I5 | 机检：`ERROR ... 超过 200000 ... 整行挂载失败` |
| T-16 | `fetchMaxOutputChars` 的 WARN 档 | `tool-web` 写 `fetchMaxOutputChars: 24000` 与 `65000` 各跑一次 | I5 | 机检：`24000` 无 `ERROR` 且**无** `> 60000` 的 WARN；`65000` 无 `ERROR` 但有那条 WARN |
| T-17 | 未知键点名 | `tool-web` 的 `config:` 下加 `fetchMaxOutpuChars: 1000`（拼错一个字母） | I6 | 机检：`ERROR ... config 里的 "fetchMaxOutpuChars" 不是 <期望包名> 认识的键`，行号指向该键所在行 |
| T-18 | pruner 算式必须带 39 字符标记 | pruner 写 `thresholdChars: 4096` + `headChars: 2048` + `tailChars: 2010` | I7 | 机检：`ERROR ... headChars + 标记(39) + tailChars = 4097 超过 thresholdChars 4096`（只看 `head+tail` = 4058 < 4096 会漏报，这正是该用例的存在理由） |
| T-19 | 同样的输入、摘要与判错一致 | 用 `PRUNER_MARKER_CHARS = 39` 为常量比较 T-18 与一个合法例的摘要行 | I7 | 机检：摘要里 `标记 39` 与实际算式一致；改常量必须同时改动摘要与判错 |
| T-20 | WARN 不是失败 | 干净副本上只制造一条 WARN（如 `allow` 加 `bash`） | I8 / `ExitStatus →` `passed(0)` | 机检：退出码 `0`，末行形如 `通过：0 个错误，1 个警告`（条数是当场读数） |
| T-21 | `exit 0` 的语义 | 检索 [`design.md`](design.md)、[`AGENTS.md`](AGENTS.md)、`preset/AGENTS.md` 里"校验通过 = 已挂载"这类等价写法 | I9 | 人：三处都必须保留"不是 YAML 解析器 / 不证明挂载"的限定语 |
| T-22 | 目标缺省 | 不带参数跑 `node tools/check-preset.mjs` | `ExitStatus →` `target-resolved` | 机检：目标解析为 `<repo>/preset/agent.cordis.yml`，退出码 `0` |
| T-23 | 目标给路径 | 传夹具 A 的绝对路径与相对路径各一次 | `ExitStatus →` `target-resolved` | 机检：校验的是那一份文本；退出码随该文本内容而定 |
| T-24 | 目标不存在 | 传一个不存在的路径 | `ExitStatus →` `unreadable(2)` | 机检：stderr 一行 `无法读取 ...`、stdout 无报告摘要、退出码 `2` |
| T-25 | 目标是目录 | `node tools/check-preset.mjs tools` | `ExitStatus →` `unreadable(2)` | 机检：stderr `无法读取 ...：不是普通文件`、退出码 `2`（必须在 `readFileSync` 之前用 `statSync().isFile()` 拦下：目录在 Windows 上会被读到垃圾字节而不是报错） |
| T-26 | 失败收尾 | 夹具 A 里制造至少一条 `ERROR` | `ExitStatus →` `failed(1)` | 机检：逐条打印 `ERROR ...`；末行 `不通过：<N> 个错误`；退出码 `1` |
| T-27 | 不取第一条了事 | 读代码确认"命中多行后直接 `continue`" | 禁止的迁移 | 人：代码里不存在"命中多行时取第一条继续比较"的路径 |
| G-1 | 生成器基本契约 | 干净仓库跑 `node tools/gen-preset-bundle.mjs` | — | 机检：退出码 `0`；stdout 报输出目录 + `cordis.patch.yml <字节数> 字节 / <N> 个顶层子插件条目（preset id=adg, order=20）`（字节数与条目数是当场读数），末行是"下一步：装进 profile"的提示；产物两份文件都在 |
| G-2 | 无随机性 | 同一条命令连跑两次，比对产物 | — | 机检：两份产物逐字节相同（只读源、只写这两个文件） |
| G-3 | `preset.yml` 缺显示名 | 临时副本里删掉 `preset/preset.yml` 的 `name:` 行后跑生成器 | — | 机检：退出码 `1`，stderr 报 `preset/preset.yml 里没有可用的 name: <显示名>` |
| G-4 | `order` 不是数字 | `preset/preset.yml` 写 `order: abc` | — | 机检：退出码 `1`，stderr 报 `order 不是数字` |
| G-5 | 首行不是数组项 | 把 `preset/agent.cordis.yml` 第一条有效行改成不是 `- ` 开头 | — | 机检：退出码 `1`，stderr 报"第一条有效行不是 `- ` 开头的数组项" |
| G-6 | 制表符 / CR 行尾 | 往 `preset/agent.cordis.yml` 里塞一个制表符，另一次塞一个 CR 行尾，各跑一次 | — | 机检：都退出码 `1`（YAML 缩进不允许 tab；CR 会让缩进块带上 `\r`） |
| G-7 | 生成物形状 | 读一份产物 | — | 人：一行 `insert:` → Loader 行 `id: preset-adg-ptc` / `name: '@deepseek-ai/dsh-agent-preset'` / `config:` 里 `id` + `name` + `description`（有才写）+ `order` + `plugins:`；条目缩进 10 空格；标量一律双引号（JSON 转义是合法 YAML） |
| G-8 | 分工不混用 | 判"该用哪个脚本" | — | 人：`check-preset.mjs` 管 `agent.cordis.yml` 的**语义硬约束**，生成器管**形状与嵌缩进**；谁都不覆盖对方 |
| G-9 | 生成物的运行期效果 | 装进 profile 后看真实挂载 | — | **未观测**：见文末「未观测」 |
| F-0 | 四种味道的生成 + 断言 | `node tools/gen-preset-bundle.mjs bundle/adg-plain && node tools/check-bundle-flavor.mjs bundle/adg-plain/cordis.patch.yml plain`；把旗标与目录换成 `--with-billion-context`+`bili`、`--with-save-token`+`save-token`、两个旗标+`bili+save-token` 各跑一遍 | — | 机检：**八条命令全退出码 `0`**。改了 `tools/flavors.mjs`、`tools/gen-preset-bundle.mjs` 或 `preset/agent.cordis.yml` 就必须四条全跑：`check-preset.mjs` 只看源文件，产物是它的盲区 |
| F-1 | 逐味道的注入断言 | 看 F-0 四条断言各自的报告行 | — | 机检：`plain` 那份没有那段说明；`bili` / `save-token` / `bili+save-token` 该有的组全 `ALL`，不该有的组会是 `<组>:LEAK` 加一条 `ERROR`。名字个数是当场读数（看两个味道的报告行相减即可核），不写死 |
| F-2 | 说明里名字的次序 | 读生成物里那段说明的原文 | — | **这一条不是机检断言**：`check-bundle-flavor.mjs` 把说明**按分词集合**（`noteTokens`）比对，不校验说明里的先后；报告行里的组次序是脚本自己按 `GROUP_ORDER` 生成的，看到它有序只证明脚本自己。要核说明里的次序只能人去读那份生成物（人） |
| F-3 | `compaction-basic` 的 `auto` | 报告里的 `compaction-basic[auto=…]` 行 | — | 机检：`plain` / `save-token` 报 `auto=未写`；`bili` / `bili+save-token` 报 `auto=false`（这个键只在 bili 组激活时注入） |
| F-4 | 负例：错味道 | 拿 bili 产物按 `plain` 断 | — | 机检：退出码 `1`；报告两行 `context-tools[LEAK]` 与 `compaction-basic[auto=false]`；两条 `ERROR`（`味道 plain 不该有 **本会话的上下文工具 说明：它的 profile 里那些名字根本不存在，写了只会让 tools_note 多几条"未生效"`、`compaction-basic：味道 plain 不该有 config.auto（没挂 bili 时它是唯一的压缩手段），实际 auto: false`）；末行 `不通过：2 个错误（plain 味道 / 2 行报告）`。**走的是「不该有说明」那一条**，不是「某个组漏了」那条（`plain` 的注入组集合是空的） |
| F-5 | 负例：漏注入 | 拿 plain 产物按 `save-token` 断 | — | 机检：退出码 `1`；报告两行 `context-tools[0 token]=save-token:NONE` 与 `compaction-basic[auto=未写]`；**两条** `ERROR`（`味道 save-token 要求调度 persona 里有 **本会话的上下文工具 说明（要求调度者每次委派带上 save_token_expand），实际一段都没有`、`味道 save-token 要求 save-token 组的 save_token_expand 全在那段说明里，实际 一个都没有`）；末行 `不通过：2 个错误（save-token 味道 / 2 行报告）` |
| F-6 | 负例：未知味道键 | `node tools/check-bundle-flavor.mjs bundle/adg-plain/cordis.patch.yml nope` | — | 机检：退出码 `2`、stderr `未知的味道键：nope（可用：plain / bili / save-token / bili+save-token）` |
| F-7 | `notInjected` 的名字 | 读 `check-bundle-flavor.mjs` 与 `flavors.mjs` 的 `NEVER_INJECTED = notInjectedFor(GROUP_ORDER)` | — | 人：`acp_cache` 出现在任何味道里都应报 `ERROR …：那段说明里出现 acp_cache：它们不在任何注入清单里（gen 脚本与 tools/flavors.mjs 的清单需对齐）` |
| F-8 | 手写注入名进源文件（反向守卫） | 夹具 A 的委派行（`- id: agent` 那一段，本身刻意不写 `allow`）临时补一段 `allow:`，在末尾分别加 `save_token_expand`、`acp_cache`、`compress` 三行，各跑一次 `node tools/check-preset.mjs <夹具>` | I1 的推论 | 机检：三条都退出码 `1`、末行 `不通过：1 个错误，<N> 个警告`；报错文本里点名该名字、说明它是构建期注入的名字，并指回对应的生成旗标（`acp_cache` 那条例外：括注里多一句"gen 的注入清单里**没有**这个，需要它请改 `tools/flavors.mjs` 里 billion-context 组的 `tools`"）。名字清单由校验器从 `tools/flavors.mjs` **推导**，不另抄 |
| F-9 | 手写 `config.auto` 进源文件 | 在夹具 A 的 `compaction-basic` 行 `config:` 下加 `auto: false`，跑校验器与 `node tools/gen-preset-bundle.mjs --with-billion-context <临时出目录>` | — | 机检：两条都退出码 `1`（校验器报"构建期注入的键"；生成器拒绝叠加第二份 `config`）。这个键在插件的 `allowedKeys` 里，所以它必须**单独**一条规则挡住，不能靠"未知键"那条 |
| F-10 | 生成物里委派行恰好一条 | 拿一份产物按它自己的味道断 | — | 机检：``ERROR 委派行应当恰好一条 `- id: agent`，实际 N 条``、退出码 `1` |
| P-1 | 逐组探测 | `node tools/has-bundle.mjs ~/.dsh/profiles <profile...>`（缺省探测 billion-context），再换 `--package=dsh-plugin-save-token` 问同一批 profile | — | 机检：每 profile 一行 `<name>\t<0\|1>`、**退出码恒 0**（挂没挂是数据，不是错误）；缺参数退出码 `2` |
| P-2 | 键 → 目录 → 旗标 | `node tools/resolve-flavor.mjs --billion-context --save-token`，另跑 `--billion-context`、`--save-token`、无参数各一次 | — | 机检：一行三列 TSV `<味道键>\t<稳定目录名>\t<gen 旗标>`；四组都退出码 `0`，旗标列与味道键对应的组集合一致 |
| P-3 | 两个入口的旗标不是一套 | `node tools/resolve-flavor.mjs --with-save-token`（把 gen 的旗标传给它） | — | 机检：退出码 `2`、stderr `不认识的旗标 --with-save-token（可用：--billion-context --save-token；味道键共 plain / bili / save-token / bili+save-token）` —— 前者表示"装着该组"，后者表示"生成时带上该组" |
| P-4 | 补丁文件名来源 | `node -p "require('<profile>/node_modules/<包名>/package.json').dsh.bundle.patch"` | — | 机检：应打印该包自己声明的补丁文件名（`dsh-plugin-save-token` 是 `./cordis.patch.yml`）；`flavors.mjs` 的 `probeBundle` 从包自己的 `package.json` 读，读不到才退回 `dsh.bundle.patch.yml`。写死历史名会把装了它的 profile 判成"没装"。位置按环境变量读（`$env:USERPROFILE` 或 `${DSH_HOME}`），账户名以本机为准 |
| P-5 | 未知味道键不静默降级 | 读 `flavors.mjs` 的 `parseFlavorKey` | — | 人：未知键**抛错**，不返回 `plain`（静默降级会让安装脚本把错味道的产物选给 profile） |

## 迁移矩阵

### `KnobRow`：`declared → validated`

唯一入口 `readRowBlock()` + `EXPECTED_ROWS` 三个结构守卫。`declared` 只表示"命中了 `- id:`"，不代表取值已判；`validated` 不代表运行期生效。

| 迁移 | 触发条件 | 期望结果 | 载体 |
|---|---|---|---|
| （无状态）→ `declared` | `- id:` 以期望前缀命中，且命中恰好 1 条 | 行进入候选；继续读 `config:` 路径 | 机检：T-1 / T-5 的通过路径 |
| （无状态）→ 报错终止该行 | 命中 0 条 | `fail(EXPECTED_ROWS[i].missingRow)` | 机检：T-6 |
| （无状态）→ 报错终止该行 | 命中 ≥ 2 条 | `fail(... 命中 N 条 ... 不可判定)`；**跳过**后续取值比较 | 机检：T-9 |
| `declared` → `declared`（滞留） | `name:` 与期望包名不符 | `fail(... name 应为 ...，实际 ...)`；不再前进 | 机检：T-7 |
| `declared` → `declared`（滞留） | 行内 `disabled: true` | `fail(... 被 disabled: true 关掉了 ...)` | 机检：T-8 |
| `declared` → `validated` | 行存在、包名正确、未 disabled、id 唯一 | 做 I4 / I5 / I6 检查 | 机检：T-1 / T-5 |
| `validated` → `validated`（带 WARN） | 旋钮键未写回 | 摘要标 `（默认）` | 机检：T-5 的对照例（干净副本） |
| `validated` → `validated`（带 WARN） | 旋钮键写回且取值合法 | 摘要标 `（已覆盖）`；`fetchMaxOutputChars > 60000` 另给 WARN | 机检：T-5 / T-16 |
| `validated` → 报错（留在 `validated`，退出码变 1） | 旋钮键写回但取值非法 / 位置不对 / 出现未知键 | `fail(...)`；退出码 `1` | 机检：T-10 ~ T-15、T-17、T-18 |
| 禁止的迁移 | "命中多行时取第一条继续取值比较" | 代码里不存在该路径（命中多行后直接 `continue`） | 人：T-27 |

### `ExitStatus`：`target-resolved → passed(0) | failed(1) | unreadable(2)`

| 迁移 | 触发条件 | 期望结果 | 载体 |
|---|---|---|---|
| （起点）→ `target-resolved` | `process.argv[2]` 缺省 | 目标解析为 `<repo>/preset/agent.cordis.yml` | 机检：T-22 |
| （起点）→ `target-resolved` | `process.argv[2]` 给了绝对 / 相对路径 | 目标解析为该路径的绝对形式 | 机检：T-23 |
| `target-resolved` → `unreadable(2)` | 目标不存在 | stderr 一行 `无法读取 ...`，stdout 无报告摘要，退出码 `2` | 机检：T-24 |
| `target-resolved` → `unreadable(2)` | 目标是目录 | stderr `无法读取 ...：不是普通文件`，退出码 `2` | 机检：T-25 |
| `target-resolved` → `failed(1)` | 至少一条 `ERROR` | 逐条打印 `ERROR ...`；末行 `不通过：N 个错误`；退出码 `1` | 机检：T-26 |
| `target-resolved` → `passed(0)` | 0 条 `ERROR`（WARN 任意条数） | 末行 `通过：0 个错误，N 个警告`；退出码 `0` | 机检：T-20 |
| `passed(0)` 的收尾方式 | 报告末尾未显式 `process.exit(0)` | 靠 Node 事件循环自然退出得 `0` | 人：读报告收尾代码 |

## 消费方契约测试

### `install.ps1` / `install.sh` 消费 preset 与部署落点

两个脚本消费的事实：preset 的**三个源文件**（`preset/preset.yml`、`preset/agent.cordis.yml`、`preset/bundle.package.json`，经 `tools/gen-preset-bundle.mjs` 生成 bundle）、技能路径，以及落点：preset bundle 的**四种味道、四个稳定落点**（`$DSH_HOME/bundles/` 下的 `dsh-adg-ptc` / `-bili` / `-save-token` / `-bili-save-token`，目录名以 `flavors.mjs` 的 `dirNameFor` 为准）。`auto` 模式下**逐个注入组**探测、按该 profile 自己的结果选一份（探测入口 `tools/has-bundle.mjs`、键→目录→旗标 `tools/resolve-flavor.mjs`），再把包名写进该 profile 的 `dsh.profile.bundles` 才算选中。

| 用例 | 断言内容 | 载体 |
|---|---|---|
| 另建一个工作副本，删掉 `preset/preset.yml`，分别跑 `node tools/check-preset.mjs` 与 `node tools/gen-preset-bundle.mjs` | 校验器**不会**报警（它只看 `agent.cordis.yml`），而生成器退出码 `1` 并报 `preset/preset.yml 里没有可用的 name:` —— 这条脱钩由**构建层**拦截 | 机检 |
| 在 `install.ps1` / `install.sh` 中检索它们引用的仓库内路径，逐个 `Test-Path` | 每条被引用的仓库内路径都存在（当前五项：`preset/preset.yml`、`preset/agent.cordis.yml`、`preset/bundle.package.json`、`skills/`（遍历其下每个 `SKILL.md`）、`delegate/`（`adg-delegate` 稳定副本的源））；任一条不存在即为**脱钩** | 人（改脚本后必做） |
| 把一个包从目标 profile 的 `node_modules` 里挪走，重跑 `install.*` | 脚本必须**只报告、不写** `dsh.profile.bundles`（"写进列表"与"包装上了"必须同时成立）；对 profile 层遗留的旧 `- insert:` 挂载行同样**只报告、不代删**（脚本不猜用户手改过的文件） | 机检 |
| **dsh 正在运行时**重跑 `install.*`（有变更需要重装依赖时） | `pnpm add link:` 失败（`os error 32` / `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`），脚本**如实报告并继续**；包已在位不算失败。判据：包不在位即被上一条挡住 | 机检 |
| 比对 `install.ps1` 与 `install.sh` 的部署集合 | 两个脚本的清单必须逐项一致（本仓库声明"行为等价"） | 未实现：当前没有一条命令跑完的自动化比对 |

**怎么发现脱钩**：脱钩的表现是"脚本复制成功、但目标侧少了一样东西"，而 `check-preset.mjs` 只看 composition 的文本，**天生看不见脱钩**。发现手段只有两条——上面那条"逐条 `Test-Path` 核对脚本内引用的仓库路径"（人，改脚本后必做），以及安装后核对目标目录的实际条目数。

### `skills/adg-delegation/SKILL.md` 消费 `delegate` 的参数与内置 deny 契约

| 用例 | 断言内容 | 载体 |
|---|---|---|
| 检索技能里的五个参数与六个内置 deny 名 | 与 `delegate` 的工具描述、与 `delegate/lib/delegate.mjs` 的 `BUILTIN_DENY` 逐项一致（参数表以工具描述为唯一真相源，名单以常量为唯一真相源） | 人 |
| 改掉 `delegate` 的一个参数名、或把一个名字移出 `BUILTIN_DENY`，不改技能 | 技能里描述的契约与实际不再一致——即"技能过期"；表现是 AI 按技能指引去用那个参数，或以为某个名字能下发（实际被剔除或当场抛错） | 机检 |
| 检索技能里是否出现"钉死取值"式表述 | 不得出现；口径只有"省略 = 继承调用方全部减内置 deny"与"点名 = 恰好这些"两种 | 人 |

**技能过期时的表现**：（a）指引里提到的输出与脚本实际不符，照做的人找不到证据；（b）技能说"不覆盖"而 composition 已覆盖（或反之），AI 会按过期口径劝阻或放行错误的改动。两种都表现为"照文档做，结果对不上"。

### `preset/agent.cordis.yml` 的 tool 行 ↔ `KNOWN_TOOLS` 双向一致性

契约：**改 composition 的 tool 行必须同时改 `KNOWN_TOOLS`**。方向不同，失效模式不同：

| 漂移方向 | 失效模式 |
|---|---|
| composition 里注册了工具 X，`KNOWN_TOOLS` 里没有 X | **误报**：preset 里任何 `allow` 写进 X 都会被判成 `ERROR ... 不是本组合注册过的工具名`，而它其实合法 → 合法配置被拦下 |
| `KNOWN_TOOLS` 里有工具 Y，composition 里已经不再注册 Y | **漏报**：preset 里任何 `allow` 写进 Y 得到 `exit 0`，而运行期 `restrict()` 会抛 `names unknown global tool ...` → 坏配置被放过 |

怎么测（两个方向各一条，都可照抄）：

1. **发现误报（composition 有、清单无）**：从 `preset/agent.cordis.yml` 里逐行取注册工具名的来源（`- id: tool-*` / `- id: present` / `- id: skill-filesystem` 等行，以及各插件注册的模型可见工具名），与 `KNOWN_TOOLS` 逐个比对，列出"在 composition 侧存在、清单里缺失"的名字。
2. **发现漏报（清单有、composition 无）**：反向列出"清单里有、composition 侧找不到注册来源"的名字。
3. **结果化验证**：把任一差异名字临时加进委派行的 `allow`（本身刻意不写，临时补一段），跑 `node tools/check-preset.mjs`——**期望 `ERROR` 而实际 `exit 0` = 漏报；期望 WARN/通过而实际 `ERROR` = 误报**。

| 用例 | 断言内容 | 载体 |
|---|---|---|
| 用 `KNOWN_TOOLS` 的每一个名字逐个构造"临时 allow" | 逐个改夹具 A 跑一次即可得到完整矩阵 | 未实现（有替代路径）：当前没有一条命令跑完的自动化 |
| `pwsh` 在 Windows 上、`bash` 在非 Windows 上 | `pwsh` 是常驻名（本机配置 `tool-pwsh` 未被关），`bash` 只给 WARN | 机检 |
| `subagent` / `subagent_fork` | 这两个名字**不在** `KNOWN_TOOLS` 里；出现在任何 `allow` 里必须 `ERROR`，且 composition 里不得存在 `toolName: subagent` / `toolName: subagent_fork` 行 | 机检 |

## 人工 review 项

本校验器**故意不做**的检查，每条都写清由谁兜底；"未覆盖"＝当前没有任何防线，属已知缺口台账。

| 故意不做的检查 | 为什么不做 | 由谁兜底 |
|---|---|---|
| 整份文件能否被 YAML 解析（缩进错位、括号不配、`key:` 后面重复） | 它是逐行正则扫描器，不引入 YAML 库 | **真实挂载**：声明行起不来时 `agentPresets.resolve('adg-ptc')` 的 `.broken` 报出是哪一行。YAML 语法错误具体在哪一步炸：**未观测**；量法：故意造一处缩进错位，看 `.broken` 的报文本里有没有可定位的坐标 |
| 锚点 `&a` / 别名 `*a` | 逐行扫描看到的只是一个标量字符串 | **真实挂载**（解析期展开后才知道指向什么）；人 |
| flow 风格（`{a: 1}`、`[]`、行内两个键） | 只处理 block 风格的 `key: value` | **真实挂载**；人 |
| 制表符缩进 | 缩进只用空格数计算，tab 不会报错 | **真实挂载**（YAML 规范禁止 tab 缩进）；人（生成器侧另有 G-6） |
| **委派行不在 4 空格缩进上** | 脚本的行匹配器写死 `^ {4}- id: (agent[a-z0-9-]*)`：缩进或命名一变，**整段委派行检查静默跳过、脚本照旧报"通过"**。当前 `delegation` 是带 `isolate` 的 `cordis:group`、其条目恰好 4 空格 | **改 `delegation` 结构后必须人工确认**：跑 `node tools/check-preset.mjs`，报告里委派行清单必须**非空、且恰好一条**（当场数，不许写成固定数字）；缺失或条数不对就说明一行都没匹配上 |
| 同一行里写两个键 | 一行的正则只取第一个 `key: value` | **真实挂载**；人 |
| 运行期是否真的挂载（包解析、行被条件表达式关掉、服务发布到全局 realm） | 静态扫描拿不到运行期信息 | **真实挂载**：`agentPresets.resolve('adg-ptc')` 的 `.broken` 为空 / `agentPresets.list()` / `agentPresets.compositionInventory()`（按 `README.md`「真实挂载验证」那一步做） |
| `install.ps1` / `install.sh` 的部署集合与落点 | 与本模块职责无关 | 人（见「`install.ps1` / `install.sh` 消费 preset 与部署落点」小节） |
| `KNOWN_TOOLS` 之外的名字是否在当前这台机器上注册 | 条件性注册求值不了 | **未覆盖**：`bash` / `read_image` / codex / claude-code 四类只在缺条件的部署上以"那一次委派抛错"暴露 |
| 生成物的运行期效果（dsh 会不会挂载它、键有没有真生效） | 生成器只保证形状 | **真实挂载** + 「未观测」小节两条 |

## 未观测

- **未观测**：四种味道的产物在真实挂载（重启 dsh + 新会话）里是否各自正确；量法：把某一份装进目标 profile（`install.*` 或 `plugin_manager` 的 `install_bundle`）→ 重启 dsh → 新会话里用一次 `delegate` 派一个子代理（把那段说明里的名字写进那次 `tools`），让它报自己的工具目录里看得见该味道该有的名字（`plain` 应看不见 `compress` / `acp_status`，`bili+save-token` 应看得见全部 5 个）。
- **未观测**：装了 save-token 时派出的子代理收到 `[save-token #id]` 通知后是否真去调 `save_token_expand`；量法：新会话里派一次会产出大工具结果的任务，看转写里有没有那次调用与它的回执（通知文本逐字点名该工具名，所以"通知到了但没调"与"通知没到"要分开看）。
- **未观测**：preset realm 里 `compaction-basic` 的 `auto: false` 是否真的关掉了原生自动折叠（产物断言只证明**键写对了**）；量法：Adg 转写里找自动折叠的痕迹（与手动 `/compact`、bili 的压缩路径对齐），确认没有非预期折叠，且手动 `/compact` 仍可用。
- **未观测**：`billion-context` 那份官方补丁打在哪一层、能不能命中 preset realm 里那份 `compaction-basic` 实例；量法：装 bili 的 profile 里读它自己的 patch 文件，与产物里 preset `compaction` 组那份逐字对照，再把两边都生效时的行为差异记下来。