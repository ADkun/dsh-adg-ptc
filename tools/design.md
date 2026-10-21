---
title: tools 模块设计
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-05
---

## 职责与边界

负责：对 `preset/agent.cordis.yml`（**仓库里的这一份就是唯一文本真相源**，没有"已安装的第二份文本"）做**零依赖的逐行静态扫描**，把"这些硬约束在文本上被破坏"的情形提前拦下来——行尾 / 末尾换行 / BOM、`delegation` 组里恰好一条委派行（形如 `    - id: agent`：4 空格缩进、`id` 以 `agent` 开头，不匹配的行会被解析器静默跳过）、该行字段齐全且 `toolName` 全局唯一、`allow`（若写）只写已注册工具名、不存在通用委派行、调度 persona 的「你手上的子代理」段提到的委派工具名与那条唯一的 `- id: agent` 委派行一一对应、`adg-delegate` 的 `BUILTIN_DENY` 覆盖六个入口（`agent` / `delegate` 缺 ⇒ ERROR；`workflow` / `ralph` / `set_child_permission` / `ask_user_question` 缺 ⇒ WARN）、`ask_user` 必须留在可给名单里（`MUST_BE_AVAILABLE_TO_CHILDREN`：它出现在 `BUILTIN_DENY` 里 ⇒ ERROR —— 那是子代理唯一的提问通道，被禁就等于把它打回"单向喊一声 + 轮询"）、`notify_user` 出现在名单里 ⇒ WARN、承载三组体积旋钮的三行结构完好（含"万一某键被写回时"的合法性）、**构建期注入组的名字没有被手写进源文件**；并在 stdout 打印两行生效值摘要。

不负责（逐条，防越权）：

- **不是 YAML 解析器。** 证明不了整份文件能被 YAML 解析，更证明不了解析结果等于写的人以为的结构。它逐行扫文本：锚点 / 别名、flow 风格、制表符缩进、一行两个键，它都看不见。
- **不证明插件真的挂载。** 包能否解析、行是否被 `disabled` 或条件表达式关掉、服务是否发布了全局 realm——这三类只有真实挂载能证明：`agentPresets.resolve('adg-ptc')` 的 `.broken` 为空是判据。
- **不修改任何文件。** 只读目标，不写、不格式化、不修 BOM、不部署（复制到用户根是 `install.ps1` / `install.sh` 的事）。
- **不校验条件性注册的名字在当前这台机器上是否真的注册**（`bash` / `read_image` / `subagent_codex` / `subagent_claude_code`）：静态检查求值不了条件表达式，只给 WARN。
- **不保证生成物的运行期效果。** `gen-preset-bundle.mjs` 只保证形状（能被 YAML 解析成一行 `insert:`），dsh 会不会挂载它要装进 profile 后看真实挂载。

## 依赖关系

- 依赖：Node 内建 `node:fs`（`readFileSync` / `statSync`）、`node:url`（`fileURLToPath`）、`node:path`（`dirname` / `join` / `resolve`）。**零第三方依赖，不引入 YAML 库**——文件形状由本仓库自己固定，逐行扫描足够。
- 依赖的事实来源（改这几处时必须重新核对本模块的常量）：
  - `skills/adg-delegation/SKILL.md`（「`tools` 是硬边界」那条契约）里的硬约束与实测事实；
  - 三个插件包的**出厂默认值**：见 `tools/check-preset.mjs` 的 `FACTORY_DEFAULTS`（**唯一真相源**，本文件不复述具体数字——换插件版本时会漂移，脚本只把它当对照）；
  - **构建期注入组的组表**：见 `tools/flavors.mjs` 的 `INJECTION_GROUPS` / `GROUP_ORDER`（**唯一真相源**——旗标、包名、注入的工具名、故意不注入的名字、是否关自动压缩、味道键与目录名的拼法、探测判据全在那里；`check-preset.mjs` / `gen-preset-bundle.mjs` / `check-bundle-flavor.mjs` / `has-bundle.mjs` / `resolve-flavor.mjs` 一律 `import` 它，本文件不复述里面的字符串）。
- 被依赖：`skills/adg-delegation/SKILL.md`（改完 preset 核一次委派口径）、`install.ps1` / `install.sh`（把仓库源文件生成成 bundle 并选落点）、`preset/AGENTS.md`（把 `check-preset.mjs` 当门禁引用）。
- 跨模块改动路由：
  - 改 composition 的 tool 行 → **必须同步 `tools/check-preset.mjs` 的 `KNOWN_TOOLS`**，改完读 `preset/design.md`；
  - 改三个旋钮插件的版本或包名 → 同步 `FACTORY_DEFAULTS` 与 `EXPECTED_ROWS` 的 `name` / `allowedKeys`，再重跑 `node tools/check-preset.mjs`。`@deepseek-ai/*` 的包名会随 dsh 升级**改名**（引擎行那次改名就让整份 preset 被判 `broken`），所以这一步是每次 dsh 升级后都要重核的。

## 核心数据模型

### Finding（不可变值对象）

一条 `ERROR` 或 `WARN`，创建后内容冻结；报告阶段按类别批量打印，不做二次改写。

- 属性：类别（`ERROR` / `WARN`）、文本（含出错行号与 `id`，便于直接跳到 composition 那一行）、所属不变量（下面是能被追溯到的那一条，供用例表对齐）。
- 不变量：
  - **I1**：**ERROR 的含义只有一个——这次委派必然抛错**（例如 `allow` 里写了未注册的工具名，`restrict()` 会抛 `names unknown global tool ...`）。策略性越界（`agent` / `delegate` / `set_child_permission`）与条件性注册（`bash` / `read_image` / `subagent_codex` / `subagent_claude_code`）**禁止**判成 ERROR，只能 WARN。`workflow` / `ralph` 不在 composition 的注册面里，落在"未注册名 ⇒ ERROR"那一侧（`restrict()` 确实会抛）。
  - **I2**：**禁止**把"取值等于某个数"写成判错。本 preset 一律用插件出厂默认值，`FACTORY_DEFAULTS` 只在报告里当对照，不参与任何 `fail()` 分支。

### KnobRow（不可变值对象）

承载体积旋钮的三行：`compaction-basic` / `tool-result-pruner` / `tool-web`。三行各有期望包名，由 `EXPECTED_ROWS` 声明。

**这是只读投影，不是受控操作对象**：脚本没有任何"批准"接口、不封装任何特权操作；三个结构守卫（行存在 / 包名正确 / 未被 `disabled` 且 id 不重复）是**检查器的前置条件**，不是对象上的门。

- 属性：行号、`id`、`name`、`disabled`、`config:` 下的键值路径（`paths` / `pathLines` / `rootScalars`）。
- 无状态机（值对象一律写不变量）。**禁止**把"解析完成 / 已校验"读成对象的状态：一轮检查的信息由 `Finding[]` 与 `ExitStatus` 承载，对象本身始终是同一份原文快照。
- 唯一的读取入口是 `readRowBlock()`。**禁止绕过它直接读原文**，也**禁止"命中多行时取第一条了事"**——重复 id 必须报错，因为"哪一行生效"不可判定。
- 不变量：
  - **I3**：三行必须存在、`name:` 必须是期望包名、不得 `disabled: true`、同一 `id` 不得重复。
  - **I4**：万一某个旋钮键被写回，它必须**直挂**在 `config:` 下；嵌得更深、或提到与 `name:` 同级，都必须在报错里点名。
  - **I5**：被写回的取值必须落在插件会接受的范围内——两个 ratio ∈ (0, 1] 且 `retainRatio < thresholdRatio`；pruner 三个键为正整数且 `headChars + 标记(39) + tailChars ≤ thresholdChars`；`fetchMaxOutputChars ≤ 200000`，且 `> 60000` 另给 WARN。
  - **I6**：`config:` 里出现插件不认识的键必须报错并点名（插件校验键集时会抛 unknown key，整行挂载失败）。
  - **I7**：pruner 的算式**必须**带上那个固定长度的标记（`PRUNER_MARKER_CHARS = 39`，标记文本是 `"[... tool result middle pruned ...]"`）：标记占掉的字符同样吃 `thresholdChars`，只看 `head + tail` 会把越界判成合法，而运行期确实会越界。

### ExitStatus（不可变值对象）

脚本的退出码，取值集合固定为 `{0, 1, 2}`。

- 属性：`0` 通过（允许有 WARN）、`1` 有 ERROR、`2` 目标不存在或不是普通文件。
- 无状态机：退出码是**进程的返回契约**（`readTarget()` 的返回 / 退出分支与报告末尾的 `process.exit`），不是对象的生命周期。三码的判定规则写成不变量，不写成迁移。
- 两条必须说清的语义：`unreadable` 判定必须先 `statSync().isFile()`（目录在 Windows 上会被 `readFileSync` 读到垃圾字节，而不是报错）；`passed` 不是"运行期会生效"，`failed` 不是"挂载会失败"。
- 不变量：
  - **I8**：**禁止**把 WARN 当成失败：有 WARN 而 ERROR 为 0 时，退出码必须为 `0`（否则 CI 会把"通过"判成失败）。
  - **I9**：**禁止**把 `exit 0` 解读为"运行期一定按这个口径生效"；它只承诺"这些硬约束在文本上没被破坏"。

### InjectionGroup（`tools/flavors.mjs` 的冻结组表）

`tools/` 里除校验器与生成器外还有一份**组表**：`tools/flavors.mjs`。它回答四个问题，每题只有这一处答案。

1. **有哪些注入组**：`INJECTION_GROUPS`，顺序由 `GROUP_ORDER = ['billion-context', 'save-token']` 固定（它同时决定那段说明里名字的次序）。一组 = 一个旗标（`--with-billion-context` / `--with-save-token`）+ 一个插件包名 + 该组注册在**全局层**的工具名 + 故意不注入的名字（`notInjected`）+ 是否顺手关掉 preset realm 里 `compaction-basic` 的 `auto`。
2. **味道是"组的集合"，不是枚举**：`plain` = 空集；其余键按 `GROUP_ORDER` 把各组的 `flavorToken` 用 `+` 连起来（`bili` / `save-token` / `bili+save-token`）。`flavorKeys()` / `parseFlavorKey()` 都按组表算。**把味道写成枚举是这类机制最容易犯的错**：加第三个组时手写的枚举会漏掉半数组合，而组表推导一次就对。
3. **稳定目录名是推导结果**：`dirNameFor(key)` —— 空集是 `DIR_PREFIX`（`dsh-adg-ptc`），否则 `dsh-adg-ptc-` + 各 token 以 `-` 连接（味道键里的 `+` 换成 `-`）。**文档与脚本都不许写死这串名字**；安装脚本用 `resolve-flavor.mjs` 的输出拿目录名。
4. **怎么判断一个 profile"装着某个组"**：`probeBundle(profilesDir, profile, packageName)` = ① 包名在该 profile 的 `dsh.profile.bundles` 里（**声明选中**）；**且** ② 该 profile 的 `node_modules/<包名>/` 下真的有这个包自己的补丁文件。两条都要，因为它们各自会失效：
   - 只看 ①：清单里写了名字、`node_modules` 里却没有实体（依赖没装成、链接断了）——此时把工具名写进调度 persona 那段说明、再由调度者随每次委派放进 `tools`，等于给了一个不存在的工具，`restrict()` 抛 `names unknown global tool`；
   - 只看 ②：包被别的东西当传递依赖带进来，而 profile 并没有**选中**这个 bundle——插件其实没挂载，"注入"同样是幻觉；
   - 补丁文件名**从包自己的 `package.json` 的 `dsh.bundle.patch` 字段读**（billion-context 是 `./dsh.bundle.patch.yml`、`dsh-plugin-save-token` 是 `./cordis.patch.yml`），读不到才退回历史名 `dsh.bundle.patch.yml`。写死历史名的后果不是报错而是**静默漏判**：新插件换文件名时判据恒为假、味道恒落 plain，而没有任何一处会说出来。
5. **谁做映射、谁做判定**：`resolve-flavor.mjs` **只做"键 → 目录 → 旗标"的映射**，不探测、不做 auto/on/off 决策。这样它能在没有 profile 的机器上被调用、也能被直接喂输入测试；探测（`has-bundle.mjs`）与覆盖策略（安装脚本）各自独立，任一环换实现都不影响另外两环。

**加一个新的注入组**（例如某个新插件往全局层注册 `foo`）：只改 `tools/flavors.mjs` 的 `INJECTION_GROUPS` 加一项（旗标 / 包名 / 工具名 / `flavorToken` / `missingHint` 等），再在 `GROUP_ORDER` 里插上它的位置。之后自动获得：新的味道键与稳定目录名、`gen-preset-bundle.mjs` 的新旗标、`check-preset.mjs` 的"手写即 ERROR"拦截（清单从组表推导，不在校验器里另抄）、`check-bundle-flavor.mjs` 的逐组断言、`has-bundle.mjs --package=<新包>` 与 `resolve-flavor.mjs --<新组>`。**禁止**在校验器、生成器、检查器或文档里另抄一份名字清单——那正是这套机制要消灭的漂移源。

## 对外接口

全部是脚本式 CLI，模块内导出面只有 `tools/flavors.mjs` 的纯函数（`flavorKeyOf` / `parseFlavorKey` / `flavorKeys` / `toolsFor` / `notInjectedFor` / `autoCompactionOffFor` / `dirNameFor` / `probeBundle` / `probeGroups`）与两张冻结表；其余脚本的常量（`KNOWN_TOOLS` / `CONDITIONAL_TOOLS` / `SCHEDULER_ONLY` / `FACTORY_DEFAULTS` / `EXPECTED_ROWS` / `PRUNER_MARKER_CHARS`）都**不 export**，要读它们只能读源码。调用方（技能、安装脚本、CI）一律只按"退出码 + stdout 摘要行"消费。

| 命令 | 参数 | 退出码 |
|---|---|---|
| `node tools/check-preset.mjs` | 可选 `[<path-to-agent.cordis.yml>]`，省略时校验仓库里的 `preset/agent.cordis.yml` | `0` 通过（允许 WARN）/ `1` 有 ERROR / `2` 目标不存在或不是普通文件；报告走 stdout，读不到目标的原因走 stderr |
| `node tools/gen-preset-bundle.mjs` | `[--with-billion-context] [--with-save-token] [<outDir>]`（两旗标可叠加；不传位置参数时是 `bundle/adg-ptc/`） | `0` 成功 / `1` 输入缺失、形状不符或不认识的旗标（错误在 stderr） |
| `node tools/check-bundle-flavor.mjs` | `<cordis.patch.yml> plain\|bili\|save-token\|bili+save-token` | `0` 断言成立 / `1` 有 ERROR / `2` 参数、味道键或文件不对 |
| `node tools/has-bundle.mjs` | `<profilesDir> <profile> [...] [--package=<包名>]`（缺省包名 `billion-context`） | `0` 正常输出 / `2` 缺参数或包名为空；**不因 profile 没挂那个包而失败** |
| `node tools/resolve-flavor.mjs` | `[--billion-context] [--save-token]`（含义是"这个 profile **装着**该组"，不是 gen 的旗标） | `0` 成功 / `2` 不认识的旗标或位置参数 |

`check-preset.mjs` 的 stdout 里两行是生效值摘要：`体积旋钮（生效值）` 与 `裁剪后实际吐出（按生效配置算）`。`check-bundle-flavor.mjs` 的 stdout 是调度 persona 那段说明的报告行（`context-tools[<note token 数> token]=<组>:<ALL|NONE|PARTIAL|LEAK>`）加一行 `compaction-basic[auto=未写|false]`。**`plain` 味道正常通过时没有 `context-tools` 这一行**（没有说明就没有可报的），只有「`plain` 却出现了那段说明」时才打 `context-tools[LEAK]` 并配一条 ERROR —— 别把它当成每次都有的行。

## 构建期注入组：生成物按 profile 分味道

`gen-preset-bundle.mjs` 从 `preset/preset.yml`（顶层标量）+ `preset/agent.cordis.yml`（原样缩进进 `config.plugins`）+ `preset/bundle.package.json`（原样拷贝）生成 `<outDir>/{cordis.patch.yml,package.json}`。**注入组的名字只能由构建期注入，禁止手写进 `preset/agent.cordis.yml`**：源文件必须对"没装那个 bundle"的机器也成立，那些名字在未挂载时**不存在**。四种味道各落一个稳定目录，四份 `package.json` 逐字节相同、包名都是 `dsh-adg-ptc`（所以 `dsh.profile.bundles` 那一行四种味道通用），不同的只有 `cordis.patch.yml`。

| 味道键 | gen 旗标 | 写进调度 persona 说明、由调度者放进委派 `tools` 的名字 | `compaction-basic` 的 `config.auto` | 稳定目录名 |
|---|---|---|---|---|
| `plain` | 无 | 无 | 不写 | `dsh-adg-ptc` |
| `bili` | `--with-billion-context` | `compress` / `decompress` / `search_context` / `acp_status` | `false` | `dsh-adg-ptc-bili` |
| `save-token` | `--with-save-token` | `save_token_expand` | 不写 | `dsh-adg-ptc-save-token` |
| `bili+save-token` | 两个旗标 | 上面 5 个 | `false` | `dsh-adg-ptc-bili-save-token` |

`billion-context` 的 `acp_cache` 在 `notInjected` 里：它是纯缓存经济性诊断（调度者可以用 `conversation_id` 代读），每多挂一个都白付一份 schema 的 prefix；它出现在**源文件**里同样算违规，出现在**生成物**里则是"注入清单没同步"的信号。

为什么必须一枚味道一份（两侧后果都不轻）：**不给** —— 那两个插件的指令与通知只看自己的 config、不看这次请求有没有那些工具，子代理会收到"去调某个工具"的指令却没有工具可调（save-token 那条通知逐字点名 `Call the save_token_expand tool with id "…"`）；**给了但目标 profile 没装那个插件** —— 名字不存在，撞 `KNOWN_TOOLS` 那条红线，每一次委派当场抛 `names unknown global tool "…"`。

`auto: false` 只在 `billion-context` 组激活时注入：它的语义是「关掉自动压缩与溢出恢复，手动 `/compact` 仍可用」，**不是**整行 `disabled`。没挂 bili 的 profile 里，dsh 自带的自动压缩是**唯一**的压缩手段，写死 `false` 等于让那些 profile 的上下文无限增长——所以这个键同样禁止手写进源文件。save-token 的入历史改写与内置 `tool-result-pruner` 动的是**同一格**（工具结果进历史的那一刻），但那一行归**插件出厂默认值**管，preset 不去关它；要不要把 pruner 行 `disabled` 是**宿主 profile 自己**的决定，生成物不管这件事。

**生成物本身不参与部署**：`node tools/gen-preset-bundle.mjs` 只在 `<outDir>` 下写出 `cordis.patch.yml` + `package.json`；部署与挂载走的是另一条链 —— `install.*` 把产物拷到 `$DSH_HOME/bundles/<稳定目录名>`，在 profile 的 `node_modules/dsh-adg-ptc` 处 `link:` 到那一份，再把包名写进该 profile `package.json` 的 `dsh.profile.bundles`。dsh **不读** `bundle/`，也不读 `$DSH_HOME/bundles/` 这份目录本身；它们是承载与落点。手改产物不会改变挂载结果（下次安装被覆盖），只会让"为什么没用"看起来像别的原因。

**未观测**：`billion-context` 那份官方补丁打在哪一层、能不能命中 preset realm 里那份 `compaction-basic` 实例；量法：装 bili 的 profile 里读它自己的补丁文件，与产物里 preset `compaction` 组那份逐字对照，再把两边都生效时的行为差异记下来。

**未观测**：四种味道的产物在真实挂载（重启 dsh + 新会话）里是否各自正确；量法：装一份 → 重启 dsh → 新会话里用一次 `delegate` 派一个子代理（把那段说明里的名字写进那次 `tools`），让它报自己的工具目录里看得见该味道该有的名字（`plain` 应看不见 `compress` / `acp_status`，`bili+save-token` 应看得见全部 5 个）。

## 非功能红线

- 禁止引入第三方依赖或 YAML 库（来源：零依赖是它的部署前提——本仓库没有 `node_modules`，安装脚本与技能都假设"克隆下来直接能跑"）。
- 禁止钉死体积旋钮取值（来源：preset 侧体积闸门那次压测的实测后果——截断与提前压缩会把工具已取到的事实切掉）。
- 禁止把"文本扫描通过"说成"挂载成功"（来源：`exit 0` 与真实挂载是两件事，静态扫描看不见包解析与 realm 发布）。
- 禁止教人传"已安装的那一份"路径，也禁止把 `$DSH_HOME/bundles/` 或 `bundle/` 下的生成物当校验对象的真相源（来源：仓库里那份源文件是**唯一**文本真相源；生成物每次安装都被覆盖）。
- 改 tool 行必须同步 `KNOWN_TOOLS`（来源：`restrict()` 实测抛 `names unknown global tool`——漏同步会让合法名字被误报，或让拼错的名字漏报）。
- **`KNOWN_TOOLS` 里有名字不来自 preset 包本身时，必须同时核实"每个目标 profile 都装了供给它的那个包"。** 现役三个名字：`notify_user` 由本仓库第一方插件包 `adg-notify`（`notify/` 模块），`delegate` 与 `ask_user` 由 `adg-delegate`（`delegate/` 模块）在**全局层**注册（`delegate` 只有调度者拿得到；`ask_user` 是给子代理的提问通道，owner 是派它的调度者）—— 都是 profile 级 `file:` 安装、顶层 `insert` 行落在全局层，所以 `restrict()` 认它们；`restrict()` 是**挂载期**判据——`allow` 写了名字、profile 却没装那个包，**每一次委派都抛 `names unknown global tool "notify_user"`**。当前前提成立：`install.ps1` / `install.sh` 在**同一次运行**里既部署并安装 `adg-notify` / `adg-delegate`、又生成并链接 preset bundle。**若将来把"装 bundle"与"装插件"拆成可分别跳过的两步，这条义务就变成真实缺陷**——那时要么回滚这些行，要么把插件安装变成硬前置。
- 禁止在校验过程中写目标文件（来源：评审决定——校验器必须能在只读介质上跑）。

## For Agents

动手前先读：[`AGENTS.md`](AGENTS.md) → 本 `design.md`；要改判错口径，先读 `preset/design.md`。

绝不能做：

- 把一条 WARN 改判成 ERROR，却拿不出"这次委派必然抛错"的依据；
- 用 `check-preset.mjs` 的 `exit 0` 代替真实挂载校验；
- 在校验路径里引入依赖、写文件或联网；
- 把构建期注入组的名字手写进 `preset/agent.cordis.yml`，或在别处另抄一份清单。

停止并升级人类的时机：要求它承担 YAML 解析；要求它校验插件是否挂载；要求它重新钉死体积旋钮取值。

## 测试与验证

见 [`testing-guide.md`](testing-guide.md)：不变量 I1..I9 的用例、两个状态机的迁移矩阵、跨模块消费侧契约、四种味道的生成与断言（含负例）、以及本校验器**故意不做**的检查清单。