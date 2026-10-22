# AGENTS.md — ptc-parallel（`adg-ptc-parallel` 并行执行提示插件）

本模块 = 一个 dsh 插件包 **`adg-ptc-parallel`**：**不注册任何工具**，在全局层监听 `agent/created`，对每个**确认为 PTC 呈现**的 agent（调度者与子代理都算）在**它自己的 scope** 上注册一段「PTC 并行执行」的系统提示词 section。设计与不变量见 [design.md](design.md)，验证见 [testing-guide.md](testing-guide.md)。

**它解决的什么**：PTC 模式下模型经 `run_code` 干活，一次 `run_code` 里可以发**多个**工具子调用，平台会并发执行那些"声明了并发安全"的调用。模型常常不知道这件事，把本可一次并行发完的活拆成好几轮 —— 每多一轮就多一份上下文、多一次等待。这段话进系统提示词，是**机制保证**（不用模型自觉），不依赖任何工具。

**为什么本模块有独立文档**（三样信号都在）：有独立命令（`cd ptc-parallel && node --test test`）；有模块特有红线（判定只准用公开 API、异常一律当"不是 PTC"）；有跨模块路由（`install.ps1` 部署它）。

三个名字**不同名也不同物**，别串：

| 名字 | 值 | 用在哪 |
|---|---|---|
| 包名 | `adg-ptc-parallel` | profile 的 `dependencies` 与 `dsh.profile.bundles`、`ptc-parallel/cordis.patch.yml` 的 `name:`、`package.json` 的 `name` |
| 行 id（= 插件模块的 `export const name`） | `adg-ptc-parallel` | `ptc-parallel/cordis.patch.yml` 的 `id:` |
| section 名 | `adg:ptc-parallel` | 注册到 agent scope 上的那一段（**不是**工具名） |
| 工具名 | **无**（本插件不注册工具） | 不进 preset 的任何 `allow`，也不进 `delegate` 的 `tools` |

## 命令

下列命令的 cwd 都是仓库的 `ptc-parallel/` 目录：

```sh
node --test test                        # 单元测试：判定 + 正文常量 + 动态工具清单 + 假 ctx 接线，零依赖、零副作用
node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里必须加这个 flag
```

零第三方依赖：只用 Node 内建能力与两个仓库内文件（`index.mjs` / `lib/guide.mjs`）。没有构建步骤 —— `main` 直接指 `./index.mjs`。**没有 `node_modules` 依赖**：本模块不 import 任何 `@deepseek-ai/*` 包（平台契约按 [design.md](design.md) 第 5 节抄录的字段名写死判据），所以仓库根的解析桥对本模块不是前提。

## 红线

每条一行结论 + 就地理由 + 来源与载体（`[机检]` 给命令与期望判据，`[评]` 给评审判据）。**违反即返工。**

- **R1 判定只准用公开 API，且只准这一条判据。** 必须走 `ctx.get('tools').get('run_code', agent)`，scope 传 **agent 对象本身**（agent 的 scope key 就是它自己）。理由：`run_code` 是平台保留名的呈现传输层，dsh-tools 解析某个 scope 的可见工具集合时只给"呈现模式不是 native"的 scope 补上它（native scope 的调度表里没有它）—— 所以"这个 scope 能不能看见 `run_code`"就是公开的呈现口径。禁止改用内部实现、内部字段或猜测。来源：design.md 第 3 节 + I1。载体：[机检] G4（断言调用的正是 `tools.get('run_code', agent)`）。
- **R2 判据抛错一律当"不是 PTC"，不注入。** `get` 内部要现造 PTC 传输层（取 PTC runtime），runtime 缺失时**会抛错**。理由：判据拿不到时宁可不注入，也不要把一段讲 PTC 并行的正文塞进一个根本不是 PTC 的会话。来源：design.md 的 I2。载体：[机检] G2 / G6。
- **R3 正文只写在 `lib/guide.mjs` 的 `GUIDE_TEXT` 一处。** 理由：正文是操作指引（平台并发语义不随会话变化），另抄一份就是漂移源。来源：design.md 的 I3。载体：[机检] S1 / S2。
- **R3b 禁止把工具名清单（或并发上限数字）写死进正文或文档。** 理由：写死即过期 —— dsh 升级新增工具、agent 的工具面变化，那份清单立刻作废，模型会拿过期清单下结论（「这个能并发」其实早变了）。要清单就现算：每次组装提示词时从 `tools.view(scope).visible` 算出来。来源：design.md 的 I3 / I6。载体：[机检] S3（`GUIDE_TEXT` 与 `CLASSIFICATION_NOTE` 不得出现任何工具名）、S2（不得出现写死的上限数字）。
- **R4 禁止在本插件里注册任何工具。** 理由：它只是提示词的一部分，不是能力面的一部分 —— 不进 `KNOWN_TOOLS`、不进任何 `allow`、不进 `delegate` 的 `tools` 名单。来源：design.md 的 I4。载体：[评] 读 `index.mjs` 的 `inject` 与 `apply`（只有 `systemPrompt` 与一个 `agent/created` 监听器）。
- **R5 禁止把本插件行写进 `preset/agent.cordis.yml`。** 理由：preset composition 里的 scoped section 会经 composeFrom 一并落到子代理（agent-preset-registry 的 join 把子代理 scope 直接绑到 generation scope），而本段是**按 scope 的呈现模式**判定的 —— 判据必须落在插件这一侧，才能对每个 agent 单独回答"这个 scope 是不是 PTC 呈现"。来源：design.md 第 2 节。载体：`ptc-parallel/cordis.patch.yml` 顶注；`node tools/check-preset.mjs`（preset 里没有它就是对的）。
- **R6 禁止在 preset 里再注册一次同名插件行。** 理由：本插件的 patch 行落**全局层**（无 scope），同层重名注册会直接失败 —— 那会拖垮**整个 profile 的插件加载**，不是"多一个监听器"。来源：design.md 第 2 节。载体：[机检] C1（`cordis.patch.yml` 的 `- id:` 与 `index.mjs` 的 `export const name` 逐字一致）。
- **R7 禁止只装包、不写 `dsh.profile.bundles`（或反过来）。** 理由：bundle 装载只遍历该列表；只写列表而包装不上会让这个 profile 启动报错。来源：与 `notify/AGENTS.md` 的 R7 同源。载体：[机检] `install.ps1` 第 4c-13 步的读回断言三格（`node_modules` 里是真目录 + `dependencies` + `dsh.profile.bundles`）。
- **R8 禁止写死本机绝对路径。** 理由：本模块落点由安装脚本按环境变量解析，源码里出现盘符路径就换了机器跑不了。来源：根 `AGENTS.md` 的同类红线。载体：[评] 读 `index.mjs` 与 `lib/guide.mjs`。
- **R9 禁止在正文里写 token 预算 / 次数上限。** 理由：与根 `AGENTS.md` 红线 4 同源 —— 那是把注意力从"做对"挪到"少写"。来源：根 `AGENTS.md`。载体：[评] 读 `lib/guide.mjs` 的 `GUIDE_TEXT`。
- **R10 禁止为了装/换插件去杀或重启正在跑的 dsh。** 理由：宿主进程就是用户正在用的会话；宿主占着 `node_modules` 时 `pnpm` 报 `os error 32` 是**预期**。载体：[评] 按「已知限制」口径如实报告并继续（`install.*` 也是这么做的）。

## 跨模块路由

| 你要做什么 | 先读 | 再读 |
|---|---|---|
| 改判定口径 / section 名 / order | [design.md](design.md) 的「核心数据模型」 | [testing-guide.md](testing-guide.md) 的「用例总表」 |
| 改正文 | `lib/guide.mjs` 的 `GUIDE_TEXT`（唯一事实源） | 本文件 R3 |
| 改装载形状 | `install.ps1` 的第 2b-6 / 4c-12 / 4c-13 步 | `source-guard/design.md` 的 I8..I11（同一种装法） |

## 版本区

本模块在版本区里的文档就是 `ptc-parallel/AGENTS.md`（本文件，路由）→ [design.md](design.md)（设计、不变量）→ [testing-guide.md](testing-guide.md)（用例全表与未观测项）三份。完整清单与根入口见根 `AGENTS.md` 的「版本区」一节，此处不另抄。

## 生效方式

**与 `browser/` 口径不同，别承诺错**：本模块是 **dsh 插件**，装进 profile 之后**必须重启 dsh**（loader 按解析路径缓存 ES 模块），再在**新建对话**里验收。

判据分三层，缺一层就不算生效：

1. **包在不在**：`<DSH_HOME>/plugins/adg-ptc-parallel/`（稳定副本）与 `<profile>/node_modules/adg-ptc-parallel/package.json`（真目录）。
2. **被选没被选**：该 profile 的 `dependencies` 与 `dsh.profile.bundles` 里都有 `adg-ptc-parallel` —— **装了 ≠ 被选中**。
3. **运行期注册没注册**：只有重启 dsh 之后才能观测。

部署由 `install.ps1` 的第 2b-6 步（把 `ptc-parallel/` 拷到用户根的稳定副本）与第 4c-12 / 4c-13 步（逐 profile `dsh plugin --profile <n> add file:<稳定副本>` + 读回断言）完成。**注意 `install.sh` 不管本模块**（它连 `source-guard` 也没管）—— Windows 上装本模块走 `install.ps1`。

**未观测**：重启 dsh 后，本段是否真的出现在 PTC 会话的系统提示词里（子代理那侧尤其要验）；量法：重启 dsh → 新建 Adg 对话 → 让调度者读一次自己的系统提示词，确认里面有「## PTC 并行执行（一次 run_code 里多做）」段；再派一个子代理，看它的系统提示词里**也有**这一段。
