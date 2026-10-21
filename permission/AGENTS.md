# AGENTS.md — permission（`set_child_permission` 插件）

本模块是仓库的**第三枚第一方子插件**：包名 `adg-permission`，在**全局层**注册工具 `set_child_permission`，让**调度智能体**把自己派出去、却还停在旧文件权限的子代理改到新权限（权限在委派那一刻被捕获，事后想纠正只有这一条路或"停掉重派"）。
装载形状与 `notify/` 同一种（稳定副本 + profile 的 `file:` 依赖 + `dsh.profile.bundles`），设计细节在 [design.md](design.md)，验证判据在 [testing-guide.md](testing-guide.md)。

## 命令

零依赖；只要 Node（`permission/package.json` 声明 `>= 22`）。

```sh
cd permission && node --test test                        # 单元测试；零副作用（不起进程、不碰真会话、不写磁盘）
cd permission && node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里必须加这个 flag
```

**自测前提**：仓库根的 `node_modules/` 必须存在 —— 它是**解析桥**，把可选 peer `@deepseek-ai/dsh-tools` 链到本机 dsh 安装处。判据（仓库根跑）：`node -p "require('@deepseek-ai/dsh-tools/package.json').version"` 能打印出版本号。它不入库、是本机产物，缺了 `node --test test` 直接 import 失败。

## 红线

每条只写结论、理由与载体（**违反即返工**）。根 `AGENTS.md` 的「关键红线」同样适用于本模块。

| # | 红线 | 理由 | 载体 |
|---|---|---|---|
| R1 | 禁止删掉、放宽或绕过两条守卫：**血缘**（目标必须是**调用方自己**派出去的后代）与**单调**（目标等级不得高于调用方当前等级）。 | 这是全仓库唯一能改动"子代理文件权限"的入口。守卫一旦退化成提示，任何拿到这个工具的会话都能给自己派出去的代理放开文件沙箱 —— 而 persona 级的提示已经被证过一次不可靠（这正是本模块存在的理由）。 | `permission/test/permission.test.mjs` 的 D2 / D6 用例 |
| R2 | **读不出调用方自己的模式时必须拒绝**，不许当成"最窄"放过去。 | 读不出＝判据缺失；放行等于在不知道调用方权限的前提下授权。这里唯一可接受的方向是 fail-closed。 | D2 用例（`读不出调用方模式时拒绝`） |
| R3 | 禁止写 `approval/policy`，也禁止调 `permissionPresets.set()` / `apply()`。 | 子代理的 approval 由委派那一层钉成 `never`（它没有人类答主）；动它会派生成 `auto` / `ask`，之后每一次需要审批的操作都会**自动被拒**或挂起。 | D4 用例（`live 路径不动 approval`）；design.md 的 I8 |
| R4 | `sandbox/mode` 事件的 `data` **只许写 `mode`**：禁止加 `source`。 | v0→v1 会话迁移对 `source` 只接受字面量 `delegation`；写 `parent` 之类会让旧格式日志过不了迁移。省略即与 `dsh-sandbox-policy` 的 `setSandboxMode()` 同形。 | D3 用例 |
| R5 | 已停下的子代理**只能**走持久化层写日志（`open(id,'write')` → `append` → `flush` → `close`）；禁止对它调 `session.append` / `sessions.flush`。 | 那两个 API 要求会话是 **live**；已停下的会话已从内存 store 脱离，调用会抛 `session "<id>" is not live in this store`。 | D5 用例 |
| R6 | 禁止把 `applied: 'persisted'` 说成"已经生效"。 | 日志里的模式要等**下次唤回它**才被读到。讲成"当场生效"会让调度者以为旧委派马上能用 —— 那正是本模块要修掉的那个误判。 | D5 / D8 用例；`DESCRIPTION` 与 `output.render` |
| R7 | 已停下且 `mode !== 'continuable'` 的子代理**拒改**，不许写进去了事。 | 一次性子代理不会再被唤回，写进它日志的模式永远不会被读到 —— 那就成了一次静默的谎报。 | D6 用例（`已停下且不可续的子代理拒改`） |
| R8 | 禁止在 preset 里再注册一个同名工具。 | `permission/cordis.patch.yml` 的行落在**全局层**，同层重名注册会让整个 profile 的插件加载失败。 | `permission/cordis.patch.yml`；`node tools/check-preset.mjs` |
| R9 | 没装 `adg-permission` 的 profile，不许在 persona / 文档里承诺这条路。 | 名字不在全局层时，preset 的静态 `allow` 里写它会抛 `names unknown global tool …`、整次委派当场失败；经 `delegate` 的 `tools` 点名它则会被剔除并逐条写进 `tools_note` —— 两条都等于承诺一个不存在的入口。 | 跨模块：`preset/AGENTS.md` 红线 12；`node tools/check-preset.mjs` |
| R10 | 禁止为装插件杀进程或重启正在跑的 dsh。 | dsh 在跑时 pnpm 报 `os error 32` 是**预期**；安装脚本如实报告并继续（`notify/design.md` 的 I9 是同一口径）。装依赖由人挑时机。 | `install.ps1` / `install.sh` 第 2b / 4c 步 |
| R11 | 禁止写死任何本机绝对路径或用户根。 | 稳定副本落在 `${DSH_HOME:-~/.dsh}/plugins/adg-permission/`，由安装脚本按环境变量解析。 | D7 用例（正则抓盘符绝对路径） |
| R12 | 禁止用"冷恢复 + 投递一条消息"或任何会**启动一轮对话**的方式顺手改权限。 | `SubagentRuntime.coldResume` 会真的投递内容；用它改权限会让一次只想改设置的调用意外消耗一个模型回合。 | design.md 的 I9；[评] 读 `setChildPermission` 的控制流 |
| R13 | 工具名与它派生的任何标识**不许含 `agent_` 子串**。 | `tools/check-preset.mjs` 把调度 persona 里任何 `X_agent_yyy` 形状的字符串当**委派工具名**做双向一致性校验，命中即 ERROR（旧提案名 `set_agent_permission` 就撞在这上面）；现在只有一条委派行 `agent`（不带下划线），所以这条主要拦的是新工具名不小心写成 `agent_*` 形状。 | `node tools/check-preset.mjs` |

## 跨模块路由

| 你要做什么 | 先读 | 再读 |
|---|---|---|
| 改两条守卫 / 加第三条守卫 | [design.md](design.md) 的「核心数据模型」 | [testing-guide.md](testing-guide.md) 的「用例总表」 |
| 改写入路径（live / persisted） | `design.md` 的 I5 / I6 / I7 | dsh 侧契约：`@deepseek-ai/dsh-session` 的 `append` / `flush`；`@deepseek-ai/dsh-session-persistence` 的 `open` / `read` / `append` / `close` |
| 改工具名或参数 | `preset/agent.cordis.yml` 调度 persona 的【浏览器：权限】段（**唯一消费方**） | `tools/check-preset.mjs` 的 `KNOWN_TOOLS` 与 `SCHEDULER_ONLY` |
| 改装载形状（目录名 / 包名 / 装法） | `install.ps1` / `install.sh` 的第 2b / 4c / 4c-1 步 | `notify/design.md` 的 I8 / I9 / I10 / I11（同一种装法的既有口径，本模块不另立一套） |

## 版本区

本模块在版本区里的文档就是 `permission/AGENTS.md`（本文件，路由）→ [design.md](design.md)（设计、不变量）→ [testing-guide.md](testing-guide.md)（用例全表与未观测项）三份，加**不在版本区**的临时目录 `docs-work/`。完整清单与根入口见根 `AGENTS.md` 的「版本区」一节，此处不另抄。

## 生效方式

| 改了什么 | 怎么生效 | 怎么复核 |
|---|---|---|
| `permission/` 任何文件 | 重装子插件（`install.*` 第 2b / 4c / 4c-1 步：稳定副本 + `dsh plugin --profile <p> add`）+ **重启 dsh** + 新会话 | `cd permission && node --test test`；再在新会话里对任一**已经派出去**的子代理调一次（运行中期望 `applied=live`、已停下期望 `applied=persisted`、把权限改到超过自己那次期望被拒） |
| 本模块任何 `.md` 文档 | 立即生效（只是文件） | 按 `adg-doc-criterion` 技能的质量红线清单自检 |

**未观测**：本插件与 preset 在同一次 `install.*` 里装上时，两处装载是否总能对齐；量法：跑一次完整安装，核对第 4c-1 步的三格断言（`node_modules` 真目录 + `dependencies` + `dsh.profile.bundles`）与 `<profile>/node_modules/dsh-adg-ptc` 的 `LinkType: Junction`。