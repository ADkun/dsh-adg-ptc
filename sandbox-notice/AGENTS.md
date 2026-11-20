# AGENTS.md — sandbox-notice（`adg-sandbox-notice` 去除 run_code 沙箱提示噪声插件）

本模块 = 一个 dsh 插件包 **`adg-sandbox-notice`**：**不注册任何工具**，在全局层监听 `tools/post-execute`，把 `run_code` 结果末尾由 PTC 渲染层追加的 `File sandbox enforcement is partial on this host.` 一行剥掉（只剥末尾整行、其它一概不动）。设计与不变量见 [design.md](design.md)，验证见 [testing-guide.md](testing-guide.md)。

**它解决的问题**：本机 Windows 走 windows-acl 沙箱档，`enforcement` 恒为 `partial`，PTC 渲染层于是**每次 `run_code` 都在结果末尾**拼一句状态声明 —— 无信息量、白占 token、干扰读结果。改 `node_modules` 不可维护，故做一个后处理插件剥掉它。

三个名字**不同名也不同物**，别串：

| 名字 | 值 | 用在哪 |
|---|---|---|
| 包名 | adg-sandbox-notice | profile 的 dependencies 与 dsh.profile.bundles、cordis.patch.yml 的 name、package.json 的 name |
| 行 id（= `export const name`） | adg-sandbox-notice | cordis.patch.yml 的 id |
| 工具名 | **无**（不注册工具） | 不进 preset 的 allow，也不进 delegate 的 tools |

## 命令

下列命令的 cwd 都是本模块目录：

```sh
node --test test                        # 单元测试：纯函数 + 假 ctx，零依赖、零副作用
node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里必须加这个 flag
```

零第三方依赖：只用 Node 内建能力与仓库内文件（`index.mjs` / `lib/strip.mjs`）。没有构建步骤，`main` 直接指 `./index.mjs`；不 import 任何 `@deepseek-ai/*` 包。

## 红线

每条一行结论 + 就地理由 + 载体（`[机检]` 给命令与期望判据，`[评]` 给评审判据）。**违反即返工。**

- **R1 只剥末尾整行那一句，禁止删中间出现 / 内联出现 / 其它文本；denied 拒绝句必须保留。** 理由：那句是末尾追加的状态尾巴；程序自己可能打印同样文字，或结果里含 `The … file sandbox denied an operation.` 的拒绝说明。载体：[机检] N3 / N4 / N7；[评] 读 `lib/strip.mjs`。
- **R2 只处理 `exec.name === 'run_code'` 的 accept（无 `value`）结果，其它工具与决策类型零改动。** 理由：本插件的唯一目标就是这层噪声。载体：[机检] W2 / W3 / W4。
- **R3 剥完无任何非空内容必须回退 `EMPTY_OUTPUT`，不许产出空文本块。** 理由：与 PTC 渲染层的空输出占位一致，否则模型看到空内容。载体：[机检] A2 / W6。
- **R4 无变化时返回原对象（`===`），禁止无条件替换。** 理由：无谓替换会扰动下游，也让“是否生效”不可判。载体：[机检] A4 / W2 / W5。
- **R5 handler 整体 try/catch，异常不外抛、退回原 `decision`。** 理由：剥噪声是锦上添花，绝不能影响工具结果本身。载体：[机检] W7。
- **R6 必须 `{ prepend: true }` 且先 `await next()` 再改写。** 理由：拿到下游最终文本，且别的后处理器不会再把那句拼回来。载体：[机检] W0。
- **R7 常量 `NOTICE` / `EMPTY_OUTPUT` 只在 `lib/strip.mjs` 一处，禁止在别处重抄字面量。** 理由：重抄是漂移源。载体：[机检] C5；[评] 读 `index.mjs`。
- **R8 `export const name` 必须等于 `cordis.patch.yml` 的 insert id（`adg-sandbox-notice`）。** 理由：不一致 = 加载失败或落错行。载体：[机检] C1。
- **R9 禁止写死本机绝对路径。** 理由：换机器跑不了。载体：[评] 读 `index.mjs` / `lib/strip.mjs`。
- **R10 禁止为装 / 换插件去杀或重启正在跑的 dsh。** 理由：宿主进程就是用户正在用的会话；宿主占着 `node_modules` 时 pnpm 报 `os error 32` 是**预期**。载体：[评] 按「生效方式」如实报告“需重启”。

## 跨模块路由

| 你要做什么 | 先读 | 再读 |
|---|---|---|
| 改剥除判据 / 回退行为 | [design.md](design.md) 的「核心数据模型」 | [testing-guide.md](testing-guide.md) 的「用例总表」 |
| 改常量 / 末尾判定 | `lib/strip.mjs`（唯一事实源） | 本文件 R7 与 R1 |
| 改装载形状 | `install.ps1` 的 2b-9 / 4c-18 / 4c-19 | [notify/design.md](../notify/design.md) 的 I8–I11（同一种装法） |

## 文档（真相与判据）

本模块三份文档：`AGENTS.md`（本文件，路由）→ [design.md](design.md)（设计、不变量）→ [testing-guide.md](testing-guide.md)（用例全表与未观测项）。三份都进 git、改了就原地更新，不建「最新稿」；过程件住 `.gitignore` 排除的 `docs-work/`，交付前清空。文件在哪、各文件讲什么由 `aoci` 索引覆盖，本模块不再另抄清单；给人看的说明在根 `README.md`。

## 生效方式

**本模块是 dsh 插件，装进 profile 之后必须重启 dsh**（loader 按解析路径缓存 ES 模块），再在**新建对话**里验收。

判据分三层，缺一层就不算生效：

1. **包在不在**：`<DSH_HOME>/plugins/adg-sandbox-notice/`（稳定副本）与 `<profile>/node_modules/adg-sandbox-notice/package.json`（真目录）。
2. **被选没被选**：该 profile 的 `dependencies` 与 `dsh.profile.bundles` 里都有 `adg-sandbox-notice` —— **装了 ≠ 被选中**。
3. **运行期注册没注册**：只有重启 dsh 之后才能观测。

部署由 `install.ps1` 的第 2b-9 步（把 `sandbox-notice/` 拷到用户根的稳定副本）与第 4c-18 / 4c-19 步（逐 profile `dsh plugin add file:…` + 读回断言三格）完成。**仓库源与稳定副本在不同盘，不可能硬链接** ⇒ 改了本模块源码**必须重跑一次 `install.ps1`**；稳定副本与各 profile 的副本**是硬链接** ⇒ 刷新稳定副本就等于刷新所有 profile 副本。

**未观测**：重启 dsh 后 `run_code` 结果末尾那句是否真的消失、正文其它字符数量是否不变；量法见 [testing-guide.md](testing-guide.md) 的 M1 / M2。
