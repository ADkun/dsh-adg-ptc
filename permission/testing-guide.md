---
title: permission 模块测试指南
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-05
---

# permission 模块测试指南

本模块有两层验证，**别把它们混起来**：

- **机制层**（自动化；全部可离线跑）：守卫对不对、两条写入路径写出的东西对不对、失败路径抛不抛错、编译出来的定义能不能跑通。`cd permission && node --test test` 覆盖这一层。
- **装载层**（只能重启后观测）：dsh 有没有真的把这个包装进 profile 并注册进全局层、子代理的下一次受限调用有没有真的按新模式解析。静态证据只能证到"包在 + 被选中"，**证不到"运行期已注册"或"模式真的生效"**（见「验证 ≠ 装载」）。

## 命令（可直接照抄）

下列命令的 cwd 都是仓库的 `permission/` 目录：

```sh
node --test test                        # 单元测试；零副作用（不起 cordis、不碰真会话、不写磁盘、不读 profile）
node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里必须加这个 flag

# 跨模块近邻（在仓库根跑；工具名与调度者可⻅性由它们钉住）
node tools/check-preset.mjs
```

**自测能跑起来的前提**：仓库根的 `node_modules/` 必须存在 —— 它是**解析桥**，把 `@deepseek-ai/*` 链到本机 dsh 安装处，好让本模块的自测能像运行时那样解析可选 peer 依赖 `@deepseek-ai/dsh-tools`。它不入库（被 `.gitignore` 排除）、是本机产物；缺了它，`node --test test` 会直接 import 失败。判据（在仓库根跑）：`node -p "require('@deepseek-ai/dsh-tools/package.json').version"` 能打印出版本号。

## 用例总表

用例从 `permission/design.md` 的不变量穷举而来；下面的组前缀就是 `permission/test/permission.test.mjs` 里测试标题的前缀（同一组可能有多条用例，**条数是当场读数、不作锚**）。载体一律是 `[机检] cd permission && node --test test`，判据＝exit 0 且没有失败用例。

| 用例 | 对象 | 断言内容 | 对应不变量 | 载体 |
|---|---|---|---|---|
| D1 | 工具定义 | 参 schema 的**编译产物**把 `agent_id` / `mode` 都标必填、`mode` 带三档 enum；**用真 `defineTool` 造定义不抛错**（＝"注册那一刻不会炸"的唯一离线证据）；**反向对照**：对象根形状喂给真 `defineTool` 必须抛 `/parameters\.type must be a value schema object/`（否则上一条是空转） | I13 | [机检] |
| D2 | SandboxMode | `SANDBOX_MODES` 的数组序＝从窄到宽、`modeRank` 与之一致；**未知模式返回 `undefined` 而不是"最窄"**；同权限与降级放行、放大一律拒；**读不出调用方模式时拒绝**；未知目标模式报出可用值 | I1 / I2 | [机检] |
| D3 | 事件信封 | 信封恒为 `{type,seq,time,data}`、`type` 是 `sandbox/mode`、**`data` 里没有 `source`**；只接受已知模式与合法 seq | I4 | [机检] |
| D4 | live 路径 | 会话在跑时 `append` + `flush` 并返回 `applied:'live'`；**不动 `approval`**（子代理恒 `never`）；live 路径**同样过单调守卫**（只读会话改不动） | I5 / I8 / I2 | [机检] |
| D5 | persisted 路径 | 会话已停下时写进它的日志、**seq 接在现有事件之后**、返回 `applied:'persisted'`；写失败也**一定关句柄**（不泄漏写租约）；`close` 自己失败**不掩盖主错误**；假件里没有 resume 面（＝路径不投递内容） | I6 / I7 / I9 | [机检] |
| D6 | 守卫与拒答路径 | 没有调用方智能体就拒；缺 `sessions` / `subagents` 时**明说缺哪个**；缺 `sandboxPolicy` 时拒绝改权限（单调守卫读不出调用方）；血缘校验（不是自己派出去的一律拒；查询**只认调用方自己的子树**）；已停下且不可续的子代理拒改；缺 `sessionPersistence` 时明说写日志需要它 | I2 / I3 / I10 / I14 | [机检] |
| D7 | 源码与装载纪律 | 源码里**不写死本机绝对路径**；入口三件套齐备（`name` / `inject` / `apply`），且 `name` 与 `cordis.patch.yml` 的 patch 行 `id` 一致（不一致时 patch 行找不到插件入口） | I11 / R11 | [机检] |
| D8 | 编译面 ↔ 执行面接得上 | 经真 `defineTool` 编译出来的定义，`execute` 能在假服务上跑通一次完整调用；`output.render` 出**一行**人话（而不是把对象丢给模型） | I13 / R6 | [机检] |

一条**最重要的测试纪律**（D1 的来源）：造工具定义必须用**真的** `defineTool`（本地助手 `realToolDefinition()`）。只跑 stub 的自测证明不了这个插件能被装载 —— schema 形状写错时 `apply()` 会在注册那一刻抛 `JsonSchemaError`。同一条纪律在 `notify/testing-guide.md` 里已经写过一次（那边是同一个坑）。

跑法上的细节：测试用假件（假会话 / 假 `subagents` / 假 `sandboxPolicy` / 假持久化句柄）注入替身，**不碰真会话、不写磁盘、不读 profile**（无桌面环境也能全绿）；D7 直接读 `permission/index.mjs` 与 `permission/lib/permission.mjs` 的字节做正则断言，不是"看起来没问题"。

## 迁移矩阵

**无。** 本模块的对象（SandboxMode / PermissionChange）与两条作者侧契约（`parameters` / `output`）都是**不可变值对象**，没有状态机、没有状态迁移（见 `design.md` 的「核心数据模型」）。逐格验证由上面的用例总表承担，本节不设矩阵表。

（**有**状态迁移的是被本模块**写入**的那个东西 —— 子代理会话的 `sandbox/mode` 折叠值；它属于 dsh 的会话模型，不属本模块，故不在此设矩阵。）

## 消费方契约测试

本模块有三个消费方，消费的**形状**不同 —— 改它们之前先看这一节。

### `preset/agent.cordis.yml` 消费的是**工具名**（唯一 persona 消费方）

调度 persona 的【浏览器：权限】段写着 `set_child_permission`，并说明两条路（调它 / 停掉重派）与两条硬约束（只能改自己派出去的、不得超过自己当前权限）。名字必须**恰好等于** `TOOL_NAME`（`permission/index.mjs`）；**改了工具名就要同步改**那一段与 `tools/check-preset.mjs` 的 `KNOWN_TOOLS` / `SCHEDULER_ONLY`，否则 `dsh-tools` 的 `restrict()` 会在**派发那一刻**抛 `names unknown global tool set_child_permission`，整次委派失败。

另外两条名字约束（都靠机检钉住，见 R13）：①新名字**不许含 `agent_` 子串** —— `tools/check-preset.mjs` 会把 persona 里 `X_agent_yyy` 形状的字符串当**委派工具名**做双向一致性校验；②它只作为调度者可用的工具存在：**不进任何一次 `delegate` 的 `tools`**（它本来就在 `delegate` 的 `BUILTIN_DENY` 里），`tools/check-preset.mjs` 把它收在 `SCHEDULER_ONLY` 里。

漂移检测（机检）：在仓库根跑 `node tools/check-preset.mjs`，判据＝exit 0（允许 WARN；ERROR 的含义只有一个 —— 那次委派必然抛错）。**不要把它打印的读数写进文档**：`allow` 项数、警告条数、委派行数都是当场读数、不作锚。

### `install.ps1` / `install.sh` 消费的是**目录名与包名**

- 源目录名固定 `permission\`（`$permissionSrc` / `permission_src`），落点 `${DSH_HOME:-~/.dsh}/plugins/adg-permission/`（`$permissionDest` / `permission_dest`）；改仓库目录名要同时改两个脚本。
- 包名 `adg-permission` 同时出现在：稳定副本的 `package.json`、profile 的 `dependencies`、profile 的 `dsh.profile.bundles`、安装脚本第 4c-1 步的断言里。改名要四处一起改。
- **稳定副本与 profile 副本是硬链接（同一个文件）** ⇒ 刷新稳定副本（`Copy-Item` 就地覆盖，链接因此存活）就等于刷新所有 profile 副本，**不需要 `dsh plugin remove` + `add`**；而仓库源与稳定副本在不同盘、不可能硬链接 ⇒ 改了仓库里 `permission/` 的源码**必须重跑一次安装脚本**（第 2b 步输出里说明已是最新，就是没改）。判据（当场读数、不作锚）：`fsutil hardlink list <稳定副本>\package.json` 与对 profile 副本的同一条命令返回同一组路径，`fsutil file queryFileID` 两处返回同一个 ID。这一整套口径与 `notify/` 完全相同，来源是 `notify/design.md` 的 I10 / I11。

漂移检测（人工 review）：核对两个脚本的拷贝清单与 `permission/package.json` 的 `files` 字段。脚本清单＝`index.mjs` / `lib/permission.mjs` / `cordis.patch.yml` / `package.json` / 三份 `.md`（与 `notify/` 那边不同：本模块**没有**额外的开发机 CLI，所以脚本清单与 `files` 只差 `package.json` 一项 —— 那是包清单，pnpm 总会拷）。判据：profile 的 `node_modules/adg-permission/` 里运行期两件套（`index.mjs` / `lib/permission.mjs`）加 `cordis.patch.yml`、`package.json` 都在。`files` 里漏掉运行期文件才是缺陷。

### dsh 的会话/持久化层消费的是**事件形状**

写入侧只有一个形状：`{ type:'sandbox/mode', seq, time, data:{ mode } }`（I4 / I6）。消费它的是 `@deepseek-ai/dsh-sandbox-policy` 的会话投影（折叠出该会话的 `overrideOf(session)`）与 v0→v1 迁移校验（对 `source` 只接受 `delegation`）。**漂移检测**：升级 dsh 后重核两件事 —— ①`sandbox/mode` 的数据 schema 是否仍只要求 `mode`（在 `@deepseek-ai/dsh-session-format-v0-to-v1` 的 `disposition(["mode"], ["source"])` 与 `dsh-sandbox-policy` 的 invariant 里）；②持久化的 `append` 是否仍要求调用方给连续 seq。两条都在「外部依赖与 ref 解析」口径下按契约制品引用，不抄实现行。

## 验证 ≠ 装载

这一节是本模块最容易自欺的地方，单独列出来。

**能证明的**（不重启）：

1. `cd permission && node --test test` 全绿 ⇒ 守卫与两条写入路径的**代码**是对的（判据：exit 0、没有失败用例）。
2. `node tools/check-preset.mjs` exit 0 ⇒ 工具名在 `KNOWN_TOOLS` 里、且没有出现在任何一次委派的工具面里（由 `delegate` 的 `BUILTIN_DENY` 钉住；判据：exit 0，允许 WARN）。
3. profile 的 `package.json` 里 `dependencies.adg-permission` 与 `dsh.profile.bundles` 都出现，且 `<profile>/node_modules/adg-permission/package.json` 存在 ⇒ **装了，且被选中**。安装脚本第 4c-1 步做的就是这三格断言。
4. `<profile>/node_modules/adg-permission` 是**真目录**（`LinkType` 为空）、不是符号链接。

**证明不了的**（必须重启 + 真实委派）：

- dsh 的 loader 有没有 import 这个包、`ctx.tools.register` 有没有真的执行 —— ES 模块按解析路径缓存，被替换的代码不会被重新 import。
- **"改了模式，子代理就真的换了权限"**：这一步跨过三个本模块证不到的环节 —— 名字在运行期真的注册了、调度者真的调了它、**子代理的下一次受限调用真的按新模式解析**。要验它：重启 dsh → 新建会话 → 用 `delegate` 派一个子代理 → 把会话切到完全权限、再对那个已派出的子代理调 `set_child_permission`（期望 `applied=live`）→ 让它继续做原本被拒的写操作。
- 已停下路径的端到端形态（写进日志 → 唤回它 → 它读到新模式）：本模块的 D5 只证明"写对了位置、seq 接得上"，证不到"唤回后真的按新模式解析"。

**一条很容易踩的假证据**：把 `applied: 'persisted'` 读成"已经生效"。它只说明**模式写进了日志**，生效时刻是**下次唤回它**（R6 / I6）。另一条同形：`dsh --dump-config` / 读静态文件只能说明"配置里有这一行"，**说明不了挂载**（根 `AGENTS.md` 的「Quality Gates」是同一条口径）。

## 人工 review 项

自动化抓不到、必须真机跑或必须有人看的部分；每条都带量法。**未观测不许写成实测，也不许写成"不可观测"。**

- **未观测**：重启 dsh 后 `set_child_permission` 是否真的出现在调度者的工具面里；量法：重启 dsh → 新建 Adg 对话 → 给调度者一个"先受限、后切换"的浏览器任务，看转写里是否出现对它的调用（而不是只出现"停掉重派"）。
- **未观测**：`applied=live` 之后，子代理的**下一次**受限调用是不是真的按新模式解析（而不是要等一个回合边界）；量法：把会话切到完全权限 → 对那个正在跑的子代理调一次 → 让它立刻重试原本被拒的写操作，看是否成功。
- **未观测**：`applied=persisted` 之后，唤回那个子代理时它读到的模式是不是新值；量法：对已停下的那个子代理调一次 → `send_message` 让它继续 → 看它的 `Current DSH file policy:` 那一行是不是新模式。
- **未观测**：把权限**降级**（`danger-full-access` → `workspace-write`）时，`permissionPresets.current()` 派生成 `custom` 会不会在某些 UI 上显示成异常；量法：降级一个子代理后看右侧栏该会话的权限标签。
- **未观测**：两个不同父代理几乎同时对同一目标写权限时的行为（写租约竞争）；量法：见 `design.md` 的「并发与幂等」一节。
- **未观测**：调度者在真实任务里是否**优先**选"调它"而不是"停掉重派"（后者在子代理还没读到材料时更省事，两条路都合规）；量法：检索若干会话转写，统计两种处置的比例，若几乎全是重派，说明【浏览器：权限】段的措辞需要再收。
- **未观测**：宿主正在运行时 `dsh plugin add` 的失败形态（`os error 32` 是**预期**，脚本会如实报告并不中断后续步骤）；量法：宿主在跑时执行 `install.ps1`，看第 4c 步是否如实报告且没有中断。

## 交付前的最小闭环

```powershell
cd permission
node --test --test-isolation=none test          # 须 exit 0、没有失败用例

cd ..
node tools/check-preset.mjs                     # 须 exit 0（允许 WARN）

# 部署侧（可在宿主运行时跑，失败按「已知限制」口径如实报告）
# 必须用 Windows PowerShell 5.1 跑（`powershell`），不是 `pwsh`：install.ps1 是按 5.1 写的、带 BOM 的脚本
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Profiles <profile>
# 装完后的三格证据（不重启能拿到的最强）：
# 落点以本机 DSH_HOME 为准（缺省才是 $HOME\.dsh）；install 脚本同样优先读它：
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
Select-String -Path "$dshHome\profiles\<profile>\package.json" -Pattern 'adg-permission'
Get-Item "$dshHome\profiles\<profile>\node_modules\adg-permission" | Select-Object LinkType
```

（`<profile>` 换成你自己的 profile 名 —— 即 `~/.dsh/profiles/` 下的目录名；本文件其余 `<profile>` 同义。**重启 dsh 与真实委派这一段不在最小闭环里** —— 它只能由人在重启后做，见「验证 ≠ 装载」。）