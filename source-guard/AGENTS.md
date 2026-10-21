# AGENTS.md — source-guard（`adg-source-guard` 源码守卫插件）

本模块 = 一个 dsh 插件包 **`adg-source-guard`**：**不注册任何工具**，在全局层监听 `tools/post-execute`（prepend），对**顶层 `run_code`** 的执行结果做一次成败分流 —— **成功**时在模型可见正文最前面补一行当次执行意图（`意图：<description>`，前缀句默认关闭），**失败**时原样返回、一个字都不改。设计与不变量见 [design.md](design.md) 的 I1..I8，验证见 [testing-guide.md](testing-guide.md)。

**为什么本模块有独立文档**（三样信号都在）：有独立命令（`cd source-guard && node --test test`）；有模块特有红线（失败路径零改动、只碰顶层 run_code、不碰 `tool/call` 的源码）；有跨模块路由（`install.ps1` / `install.sh` 部署它）。

三个名字**不同名也不同物**，别串：

| 名字 | 值 | 用在哪 |
|---|---|---|
| 包名 | `adg-source-guard` | profile 的 `dependencies` 与 `dsh.profile.bundles`、`source-guard/cordis.patch.yml` 的 `name:` |
| 行 id（= 插件模块的 `export const name`） | `adg-source-guard` | `source-guard/cordis.patch.yml` 的 `id:` |
| 工具名 | **无**（本插件不注册工具） | 不进 preset 的任何 `allow`，也不进 `delegate` 的 `tools` |

## 命令

下列命令的 cwd 都是仓库的 `source-guard/` 目录：

```sh
node --test test                        # 单元测试：纯函数 + 假 ctx 接线，零依赖、零副作用
node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里必须加这个 flag
```

零第三方依赖：只用 Node 内建能力与两个仓库内文件（`index.mjs` / `lib/policy.mjs`）。没有构建步骤 —— `main` 直接指 `./index.mjs`。**没有 `node_modules` 依赖**：本模块不 import 任何 `@deepseek-ai/*` 包（平台契约全部按 [design.md](design.md) 第 5 节抄录的常量与字段名写死判据），所以仓库根的解析桥对本模块不是前提。

## 红线

每条一行结论 + 就地理由 + 来源与载体（`[机检]` 给命令与期望判据，`[评]` 给评审判据）。**违反即返工。**

- **R1 失败路径零改动。** `result.isError === true` 时必须原样返回 `next()` 的决策（含 `content` 逐块相等）。理由：失败正文里的 `code run failed (kind): message` + `Captured output` 是排查现场，删一句就得多跑一轮才拿得到。来源：design.md 的规则表第 5 行 + I1。载体：[机检] D10 / D11 / W4。
- **R2 只碰顶层 `run_code`。** 判据是 `exec.name === 'run_code' && exec.parent == null`；其它工具与程序内子分发一律原样返回。理由：子分发的结果是程序逻辑的一部分，改写它等于替模型改程序的输出。来源：design.md 的 `governs()` + I2。载体：[机检] D2 / D3 / D14 / W5。
- **R3 禁止替换 value，也禁止在同一次 accept 里既给 `value` 又给 `content`。** 平台的 `postExecute` 对这种决策直接抛 `tools/post-execute accept decision cannot replace both value and content`；失败结果更是不许换 value。理由：一次抛错会让那次工具执行整体失败。来源：design.md 的规则表第 4 行 + I3。载体：[机检] D13。
- **R4 禁止宣称「源码完全不进上下文」。** `tool/call` 的 `arguments`（assistant 消息里的 tool_use 入参）那份源码平台没有改写点，本插件只管结果侧。理由：夸大能力边界会让下一个读者以为已经闭环。来源：design.md 第 1 节的入口表 + I7 的未观测项。载体：[评] 读 design.md 第 1 节与 AGENTS.md 的表述。
- **R5 禁止写盘、起进程、注册工具、解析 jobs。** 本插件只做数组拼接。理由：改写结果正文不需要任何副作用；多一个出口就多一个能在工具执行路径上拖垮会话的点。来源：design.md 的 I5。载体：[评] 读 `index.mjs` 与 `lib/policy.mjs` 的 import 行（应只有 `./lib/policy.mjs` 与 node 内建）。
- **R6 单次改写失败不许外抛。** catch 后落一条 `ctx.logger?.warn` 并返回 `next()` 的决策。理由：异常路径的最坏后果该是"这次没改写"，不是"这次工具执行失败"。来源：design.md 的 I6。载体：[机检] W7。
- **R7 禁止在 preset 里再注册一次同名插件行。** 理由：本插件的 patch 行落**全局层**（无 scope），同层重名注册会直接失败 —— 那会拖垮**整个 profile 的插件加载**，不是"多一个监听器"。来源：design.md 第 2 节。载体：[机检] `source-guard/cordis.patch.yml` 的 `- id:` 与 `index.mjs` 的 `export const name` 逐字一致（D19）；在仓库根跑 `node tools/check-preset.mjs`（exit 0）。
- **R8 禁止只装包、不写 `dsh.profile.bundles`（或反过来）。** 理由：bundle 装载只遍历该列表；只写列表而包装不上会让这个 profile 启动报错。来源：与 `notify/AGENTS.md` 的 R7 同源。载体：[机检] `install.*` 第 4c-1 步读回断言三格（`node_modules` 里是真目录 + `dependencies` + `dsh.profile.bundles`）。
- **R9 禁止写死本机绝对路径。** 理由：本模块落点由安装脚本按环境变量解析，源码里出现盘符路径就换了机器跑不了。来源：根 `AGENTS.md` 的同类红线。载体：[机检] D20（只扫 `source-guard/index.mjs` 与 `source-guard/lib/policy.mjs`，只认 `X:\Users\…` 与「盘符 + `dsh`」的写法）。
- **R10 禁止为了装/换插件去杀或重启正在跑的 dsh。** 理由：宿主进程就是用户正在用的会话；宿主占着 `node_modules` 时 `pnpm` 报 `os error 32` 是**预期**。载体：[评] 按「已知限制」口径如实报告并继续（`install.*` 也是这么做的）。

## 版本区

本模块的最终文档只有三份，都在仓库 `source-guard/`：`AGENTS.md`（本文件，路由）→ [design.md](design.md)（设计：对象、不变量、接口）→ [testing-guide.md](testing-guide.md)（验证：用例总表、未观测项）。三份进 git、互相引用，内容一变就写回这三份本身，不建"最新稿"。过程件一律住被 `.gitignore` 排除的 `docs-work/`（临时工作目录，不算版本区）。完整清单与各文档的职责边界见根 `AGENTS.md` 的「版本区（文档目录入口）」一节。

## 生效方式

**与 `browser/` 口径不同，别承诺错**：`browser/` 是用户根下的普通文件，重跑一次 `install.*` 即生效；本模块是 **dsh 插件**，装进 profile 之后**必须重启 dsh**（loader 按解析路径缓存 ES 模块），再在**新建对话**里验收。

判据分三层，缺一层就不算生效：

1. **包在不在**：`<DSH_HOME>/plugins/adg-source-guard/`（稳定副本）与 `<profile>/node_modules/adg-source-guard/package.json`（真目录）。
2. **被选没被选**：该 profile 的 `dependencies` 与 `dsh.profile.bundles` 里都有 `adg-source-guard` —— **装了 ≠ 被选中**。
3. **运行期注册没注册**：只有重启 dsh 之后才能观测。

部署由 `install.ps1` / `install.sh` 的第 2b 步（把 `source-guard/` 拷到用户根的稳定副本）与第 4c / 4c-1 步（逐 profile `dsh plugin --profile <n> add file:<稳定副本>` + 读回断言）完成。

**未观测**：重启 dsh 后监听器是否真的接到每次 run_code 上；量法：重启 dsh → 新建 Adg 对话 → 让模型跑一次成功的 run_code（结果正文应多出一行「意图：<当次 description>」，前缀句默认不出现）与一次失败的 run_code（结果正文应与未装本插件时逐字相同）。
