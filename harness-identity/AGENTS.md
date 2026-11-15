# AGENTS.md — harness-identity（`adg-harness-identity` 去除系统提示词固定开场白插件）

本模块 = 一个 dsh 插件包 **`adg-harness-identity`**：**不注册任何工具**，在全局层监听 `agent/created`，对每个 **`adg-ptc` preset 的 agent**（调度者与子代理都算）在**它自己的 scope** 上注册一个同名（`harness:identity`）空文本的系统提示词 section，覆盖掉平台固定添加的开头那一行 **`You are an AI agent, powered by DeepSeek Harness.`**。设计与不变量见 [design.md](design.md)，验证见 [testing-guide.md](testing-guide.md)。

**它解决的问题**：DSH 默认在每个 agent 的系统提示词最开头固定加一行 `You are an AI agent, powered by DeepSeek Harness.`。本仓库要把它**完全去掉**（不是替换成别的话，是让这一行不存在、也不留空行）。用一个第一方插件做，而不是改 profile 配置。

**为什么本模块有独立文档**（三样信号都在）：有独立命令（`cd harness-identity && node --test test`）；有模块特有红线（覆盖必须靠"同名 section + 空文本"，section 名必须逐字对齐平台）；有跨模块路由（`install.ps1` 部署它）。

三个名字**不同名也不同物**，别串：

| 名字 | 值 | 用在哪 |
|---|---|---|
| 包名 | `adg-harness-identity` | profile 的 `dependencies` 与 `dsh.profile.bundles`、`harness-identity/cordis.patch.yml` 的 `name:`、`package.json` 的 `name` |
| 行 id（= 插件模块的 `export const name`） | `adg-harness-identity` | `harness-identity/cordis.patch.yml` 的 `id:` |
| section 名 | `harness:identity` | 注册到 agent scope 上的那一段（**必须逐字等于平台全局那一段的名字**才能覆盖；**不是**工具名） |
| 工具名 | **无**（本插件不注册工具） | 不进 preset 的任何 `allow`，也不进 `delegate` 的 `tools` |

## 命令

下列命令的 cwd 都是仓库的 `harness-identity/` 目录：

```sh
node --test test                        # 单元测试：判定 + 覆盖常量 + 假 ctx 接线 + 文件契约，零依赖、零副作用
node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里必须加这个 flag
```

零第三方依赖：只用 Node 内建能力与两个仓库内文件（`index.mjs` / `lib/section.mjs`）。没有构建步骤 —— `main` 直接指 `./index.mjs`。**没有 `node_modules` 依赖**：本模块不 import 任何 `@deepseek-ai/*` 包（平台契约按 [design.md](design.md) 第 5 节抄录的 section 名 / order / 过滤口径写死判据）。

## 红线

每条一行结论 + 就地理由 + 来源与载体（`[机检]` 给命令与期望判据，`[评]` 给评审判据）。**违反即返工。**

- **R1 覆盖只能靠"同名 section + 空文本"，禁止改用配置 `includeHarnessIdentity:false` 或注册工具。** 理由：用户明确要求以一个插件完成；且本模块要让**只读本仓库的人**也能看出这一行是怎么被去掉的。来源：design.md 第 3 节。载体：[评] 读 `index.mjs`（只有一个 `agent/created` 监听器与一处 `section()`）。
- **R2 section 名必须逐字 `harness:identity`，一个字都不能改。** 理由：覆盖的机制是"scoped 同名项覆盖 global 同名项"，名字不相等就不覆盖，那一行还在（且静默失效）。来源：design.md 第 3.3 / 第 5 节。载体：[机检] S2 / C5。
- **R3 判定只对 `adg-ptc`，且拿不到身份时一律不覆盖（fail-closed）。** 理由：不属于本 preset 的会话不该被本仓库的插件改动；判据拿不到时宁可不动。来源：design.md 第 3.1 节。载体：[机检] G1–G5。
- **R4 注册必须落在 agent 自己的 scope（`agent.ctx`），禁止在全局层注册同名 section。** 理由：全局层已有一条 `harness:identity`（平台构造时注册），同层重名注册会**直接抛错**、拖垮整个 profile 的插件加载；只有逐 agent 的 scoped 层才能覆盖且不撞名。来源：design.md 第 2 / 第 5 节（平台自己的报错文案也明说"per-agent override 请走 agent.ctx"）。载体：[机检] W1 / W3；[评] 读 `index.mjs` 用的是 `agentCtx.systemPrompt.section`。
- **R5 禁止把本插件行写进 `preset/agent.cordis.yml`。** 理由：preset 侧并不挂载 `dsh-system-prompt`（`systemPrompt` 服务是 host 拥有的）；且 preset composition 里的 scoped section 会经 composeFrom 一并落到子代理，那种形状给不出"逐 agent 按 preset 身份判定"。来源：design.md 第 2 节。载体：`harness-identity/cordis.patch.yml` 顶注；`node tools/check-preset.mjs`（preset 里没有它就是对的）。
- **R6 这个 section 的正文必须是空串，禁止往里塞任何非空文本。** 理由：本插件的语义是"删除一行"；一旦写了非空文本，就变成"用新开场白替换旧的"，那是另一个需求。要加提示词请另开一个自有 section 名，别复用 `harness:identity`。来源：design.md 的 I2。载体：[机检] S1 / S4。
- **R7 禁止只装包、不写 `dsh.profile.bundles`（或反过来）。** 理由：bundle 装载只遍历该列表；只写列表而包装不上会让这个 profile 启动报错。来源：与 `notify/AGENTS.md` 的 R7 同源。载体：[机检] `install.ps1` 第 4c-17 步的读回断言三格（`node_modules` 里是真目录 + `dependencies` + `dsh.profile.bundles`）。
- **R8 禁止写死本机绝对路径。** 理由：本模块落点由安装脚本按环境变量解析，源码里出现盘符路径就换了机器跑不了。来源：根 `AGENTS.md` 的同类红线。载体：[评] 读 `index.mjs` 与 `lib/section.mjs`。
- **R9 section 名 / order / 目标 preset 三个常量只在 `lib/section.mjs` 一处。** 理由：另抄一份就是漂移源，改一处漏一处会静默失效。来源：design.md 的 I3。载体：[机检] C5（源码里 `harness:identity` 与 `-1000` 只从 lib 来）。
- **R10 禁止为了装 / 换插件去杀或重启正在跑的 dsh。** 理由：宿主进程就是用户正在用的会话；宿主占着 `node_modules` 时 `pnpm` 报 `os error 32` 是**预期**。载体：[评] 按「生效方式」如实报告"需重启"，不擅自杀进程。

## 跨模块路由

| 你要做什么 | 先读 | 再读 |
|---|---|---|
| 改判定口径 / section 名 / order | [design.md](design.md) 的「核心数据模型」 | [testing-guide.md](testing-guide.md) 的「用例总表」 |
| 想给开头再加/改一段话（不是删除） | 本文件 R6 | 另开一个新 section 名的模块；不要改 `harness:identity` |
| 改装载形状 | `install.ps1` 的第 2b-8 / 4c-16 / 4c-17 步 | （同一种装法：稳定副本 + `dsh plugin add` + 读回断言三格） |

## 版本区

本模块在版本区里的文档就是 `harness-identity/AGENTS.md`（本文件，路由）→ [design.md](design.md)（设计、不变量）→ [testing-guide.md](testing-guide.md)（用例全表与未观测项）三份。完整清单与根入口见根 `AGENTS.md` 的「版本区」一节，此处不另抄。

## 生效方式

**本模块是 dsh 插件，装进 profile 之后必须重启 dsh**（loader 按解析路径缓存 ES 模块），再在**新建对话**里验收。

判据分三层，缺一层就不算生效：

1. **包在不在**：`<DSH_HOME>/plugins/adg-harness-identity/`（稳定副本）与 `<profile>/node_modules/adg-harness-identity/package.json`（真目录）。
2. **被选没被选**：该 profile 的 `dependencies` 与 `dsh.profile.bundles` 里都有 `adg-harness-identity` —— **装了 ≠ 被选中**。
3. **运行期注册没注册**：只有重启 dsh 之后才能观测。

部署由 `install.ps1` 的第 2b-8 步（把 `harness-identity/` 拷到用户根的稳定副本）与第 4c-16 / 4c-17 步（逐 profile `dsh plugin --profile <n> add file:<稳定副本>` + 读回断言）完成。**注意 `install.sh` 不管本模块**（它连 `ptc-parallel` / `turn-bookmarks` 也没管）—— Windows 上装本模块走 `install.ps1`。

**未观测**：重启 dsh 后，系统提示词开头那一行是否真的消失（调度者与子代理两侧都要看）；量法见 [testing-guide.md](testing-guide.md) 的 M1 / M2。
