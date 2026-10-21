# AGENTS.md — notify（Adg 桌面通知插件）

本模块 = 一个 dsh 插件包 **`adg-notify`**：注册一个工具 **`notify_user`**，把一条消息变成 **Windows 桌面通知（toast）**，让**调度智能体或它派出的子代理**在撞上登录墙 / 验证码 / 二次验证 / 需要用户在本机动手或拍板时，把「该你动手了 + 具体要做什么」推给用户。它是**单向通知：不阻塞、不等回话** —— 弹出去就结束，用户是否看到不影响下一步。设计与不变量见 [design.md](design.md) 的 I1..I14。

**为什么本模块有独立文档**（三样信号都在）：有独立于仓库根的命令（`node cli.mjs send --message …`）；有模块特有红线（只能用 Windows PowerShell 5.1、`.ps1` 必须 ASCII-only 且无 BOM、失败不许谎报成功）；有跨模块路由（`install.ps1` / `install.sh` 部署它；`preset/agent.cordis.yml` 侧它不在任何 `allow` 里，而是由调度智能体用 `delegate` 的 `tools` **逐次**给子代理）。

三个名字**不同名也不同物**，别串：

| 名字 | 值 | 用在哪 |
|---|---|---|
| 包名 | `adg-notify` | profile 的 `dependencies` 与 `dsh.profile.bundles`、`notify/cordis.patch.yml` 的 `name:` |
| 行 id（= 插件模块的 `export const name`） | `adg-notify` | `notify/cordis.patch.yml` 的 `id:` |
| 工具名 | `notify_user` | 不在 preset 的静态 `allow` 里（preset 现在没有专家行）；由调度智能体在 `delegate` 的 `tools` 里逐次给；`tools/check-preset.mjs` 的 `KNOWN_TOOLS` 已收 |

## 命令

下列命令的 cwd 都是仓库的 `notify/` 目录：

```sh
node cli.mjs help          # 命令契约：子命令、选项、退出码以它为准，本文不复制
node cli.mjs send --message '需要你登录 example.com' --show   # 真弹一条；--show 额外打出脚本路径 / PowerShell 路径
node cli.mjs send --message '…' --title 'DSH 通知' --silent --ms 0   # 静音 + 常驻（reminder；默认就是 0）

node --test test                        # 单元测试：不弹窗、不起真进程（测试注入假 spawn），可安全跑
node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里必须加这个 flag
```

`node cli.mjs send` 与工具 `notify_user` 走的是**同一个内核** `notify/lib/toast.mjs` 的 `sendToast()`：所以"这条命令能弹出通知"＝"`notify_user` 的机制可用"。反过来不成立——命令能弹**不证明** dsh 装载了这个插件（见「生效方式」）。

零第三方依赖：只用 Node 内建能力与一条**可选** peer 声明（`@deepseek-ai/dsh-tools`，运行期由 dsh 的解析拦截层供给，见 I12）。没有构建步骤——`main` 直接指 `./index.mjs`。

## 红线

每条一行结论 + 就地理由 + 来源与载体（`[机检]` 给命令与期望判据，`[评]` 给评审判据）。**违反即返工。**

- **R1 禁止用 `pwsh`（PowerShell 7+）执行 toast；必须 Windows PowerShell 5.1**（`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`）。理由：`pwsh` 没有 `Windows.UI.Notifications` 的 WinRT 投影，用它等于投递必失败。来源：`notify/scripts/toast.ps1` 的宿主选择注释。载体：[机检] D6 / D7 用例；[评] 读 `resolvePowershellPath()` 的返回值。
- **R2 `notify/scripts/toast.ps1` 必须 ASCII-only 且无 BOM。** 理由：5.1 按 ANSI 代码页解码无 BOM 脚本，非 ASCII 字符会乱码；中文标题与正文只经 `-Title` / `-Body` 以 UTF-16 实参传入。来源：同上注释。载体：[机检] D6 的字节级断言；改完在仓库根复核 `cd notify && node -e "const b=require('fs').readFileSync('scripts/toast.ps1');console.log(b[0].toString(16),b.every(c=>c<128))"`，判据＝`5b true`（`5b` 即 `[`，无 BOM）。
- **R3 禁止引入第三方依赖，尤其禁止 `New-BurntToastNotification`。** 理由：本仓库的零依赖红线，且两个 WinRT 投影够用；`BurntToast` 要装 PowerShell 模块，等于给"通知"加一个安装前提。载体：[机检] D6 断言脚本里不出现 `BurntToast`；[评] `notify/package.json` 里没有 `dependencies`。
- **R4 禁止把失败写成成功**：`{ shown: false }`、"静默降级成写日志"之类都算。理由：这个工具的唯一价值是"用户真的看到了"；一次谎报成功会让子代理继续等一个永远不会来的操作。来源：失败路径契约（I6）。载体：[机检] D4 的各条失败路径用例；[评] 读 `sendToast` 的返回与抛出。
- **R5 禁止在非 Windows 上假装弹过。** 理由：toast 机制**只存在于 Windows**；降级成写日志会让"通知成功"变成一句谎话（I6）。载体：[机检] D4 的非 win32 用例。
- **R6 禁止在 preset 里再注册一次 `notify_user`。** 理由：本插件的 patch 行落**全局层**（无 scope），同一层重名注册会直接失败——那会拖垮**整个 profile 的插件加载**，不是"多一个工具"。来源：I7。载体：[机检] D1 断言 `export const name` 等于 patch 行的 `id`；在仓库根跑 `node tools/check-preset.mjs`（exit 0）。
- **R7 禁止只装包、不写 `dsh.profile.bundles`（或反过来）。** 理由：bundle 装载只遍历该列表；只写列表而包装不上会让这个 profile 启动报错。来源：I8。载体：[机检] `install.*` 第 4c-1 步读回断言三格（`node_modules` 里是真目录 + `dependencies` + `dsh.profile.bundles`）。
- **R8 禁止在没装本插件的 profile 上，把 `notify_user` 写进 preset 的静态 `allow`，或把它当成那次委派真能拿到的工具来承诺。** 理由：静态 `allow` 里写未知名，`restrict()` 在派发那一刻抛 `names unknown global tool notify_user`，整次委派失败；而经 `delegate` 的 `tools` 点名一个没注册的名字只会被剔除并逐条写进 `tools_note` —— 子代理当场没有这个工具，调度者必须看 `tools_note`，不许当成"已经给了"。来源：I9。载体：[机检] 在仓库根跑 `node tools/check-preset.mjs`；[人] 装完确认 `install.*` 打印出 `adg-notify 三格齐（node_modules 真目录 + dependencies + dsh.profile.bundles）`，没看到就照它打印的手工命令补装。
- **R9 禁止为了装/换插件去杀或重启正在跑的 dsh。** 理由：宿主进程就是用户正在用的会话；宿主占着 `node_modules` 时 `pnpm` 报 `os error 32` 是**预期**。载体：[评] 按「已知限制」口径如实报告并继续（`install.*` 也是这么做的）。
- **R10 禁止写死本机绝对路径。** 理由：脚本路径与 PowerShell 路径分别由 `import.meta.url` 与 `%SystemRoot%` 推出，换机器还能用。来源：根 `AGENTS.md` 的同类红线。载体：[机检] D7 —— 只扫 `notify/index.mjs`、`notify/cli.mjs`、`notify/lib/toast.mjs`，只认 `X:\Users\…` 与「盘符 + `dsh`」的写法（反斜杠 1–2 个都算，正斜杠不算）；[评] 接手其余：`notify/scripts/toast.ps1` / `notify/cordis.patch.yml` / `notify/package.json` 这些非源码文件，`D:/…` 正斜杠与 UNC / `file:///` 形态，以及由变量拼出来的路径真值。
- **R11 禁止把 `notify_user` 当问答通道，或当"用户已经同意 / 已经看到"。** 人工介入的**问答通道**是 `adg-delegate` 的 **`ask_user`**：子代理调它时，问题以**派它的那个调度者**为 owner 交给用户提问服务，卡片落在用户与调度者对话的那个会话里，用户答完**答复直接回到子代理手上**、它当场接着干（见 `delegate/design.md` 的 I12 / I13）。`notify_user` 只是**单向补充** —— 用户看得见、回不了话，所以**不能替代 `ask_user`**：禁止在 `notify_user` 的正文里要求用户"回来告诉我"，禁止把它当成等待答复的手段。理由：它是**单向**投递，不阻塞也不等回话，而且用户可能不在电脑前（通知可能没被看到）；平台自带的 `ask_user_question` 只认 live runtime root（子代理调它拿到 `DELEGATED_CALLER`），这正是 `ask_user` 存在的原因 —— `ask_user` 拿不到调度者活实例时**抛错**、让子代理把未决问题与可选项写进最终结果，不退回"以子代理自己的名义问"。来源：本模块的工具 description ＋ `preset/design.md` 的 R20 ＋ `delegate/design.md` 的 I12 / I13 ＋ `skills/adg-browser-use` 的登录协议。载体：[评] 读委派 prompt 与技能。
- **R12 禁止借通知绕过登录墙 / 验证码，或代替用户输账号密码；通知正文里不写凭据。** 理由：本模块只把"该你动手了"推给人；通知标题与正文会驻留通知中心，正文按"会被旁人看到"对待。来源：`preset/agent.cordis.yml` 调度 persona 的 `【浏览器：权限】` 段 ＋ `preset/design.md` 的 R13 / R20。载体：[评] 读通知正文与那次委派。
- **R13 禁止在本模块里再定义一份"通知三项"的界或第二套默认值。** 三个键（**通知默认标题** / **响提示音** / **通知常驻**）的键名、默认值与界的唯一真相在 `settings/lib/schema.mjs` 的 `FIELDS`；本模块只**读**那份设置文件（落点＝`settingsFile()` 的优先序 `${DSH_PROFILE_DIR:-${DSH_HOME:-~/.dsh}}/adg-settings.json` —— 宿主进程里 `DSH_PROFILE_DIR` 就是当前 profile 目录，所以真实落点是**那个 profile 目录下**那一份，不是用户根那份）—— **不 import `adg-settings` 包**，`USER_DEFAULTS` 必须与登记项逐项相等（`notify/test/user-settings.test.mjs` 的漂移用例钉住），校验与界面一律走 `settings/`。改键名要**两边一起改**；理由：两份默认值是"同一个值改两处、还不会报错"，漂移只会表现为"设置页显示的和实际弹的不一样"。生效口径：**改这三项的值保存即生效、不用重启**（消费方每次调用都读文件）；本模块**源码**或键名变了仍要重装子插件 + 重启 dsh。来源：`settings/AGENTS.md` 的 R3 ＋ `settings/design.md` 的不变量 I15。载体：[机检] `cd notify && node --test test`。
- **R14 禁止在常驻分支只设 `scenario="reminder"` 而不给按钮。** 理由：Windows 会**静默忽略**这个属性 —— 不报错、`Show()` 照常成功、通知中心里也照常有这条记录，只有屏幕上没有它（几秒内自己消失）。用户报的"设了永不消失还是几秒就没了"就是这个现象。常驻分支必须同时追加**一个** `<action content="Dismiss" arguments="dismiss" activationType="system"/>`（system dismiss：点一下消失、**不启动任何进程**），`content` 不能省（省掉整条通知根本到不了屏幕），`<actions>` 必须排在 `<audio>` 之后（schema 定死子元素顺序）。**`activationType="system"` 是官方枚举外的未文档化取值**：[element-action](https://learn.microsoft.com/en-us/uwp/schemas/tiles/toastschema/element-action) 的 `activationType` 枚举只有 `foreground | background | protocol`（**没有** `system`），[element-toast](https://learn.microsoft.com/en-us/uwp/schemas/tiles/toastschema/element-toast) 对 reminder 的措辞写的是 "silently ignored unless there's a toast button action that activates in **background**"；只有 App notification content 的 Snooze/dismiss 一节说 system 动作（snooze / dismiss）在 **raw XML** 下受支持、不写 content 时系统自动填本地化的 "Dismiss"。⇒ 本模块这条写法**靠实测成立**（2026-10-08 真机：三张截屏横幅都在、反向对照仍自动消失、UIA 树上读到 `Button|VerbButton|Dismiss` 且 `InvokePattern.Invoke()` 后通知被系统拿走），**不是文档承诺**；Windows 更新后是否继续认这个取值，没有官方承诺。来源：design.md 的 I5a（含官方原文与 2026-10-08 真机对照实验）。载体：[机检] D8 用例 —— 它是**源码文本回归**（`readFileSync` + 正则），只防写法回退、**证明不了真机行为**；[人] testing-guide 的「已观测」项（默认常驻 ≥60s 仍在屏幕上 + 反向对照仍自动消失）。

## 版本区

本模块的最终文档只有三份，都在仓库 `notify/`：`notify/AGENTS.md`（本文件，路由）→ [design.md](design.md)（设计：对象、不变量、接口）→ [testing-guide.md](testing-guide.md)（验证：用例总表、消费方契约、未观测项）。三份进 git、互相引用，内容一变就写回这三份本身，不建"最新稿"。过程件一律住被 `.gitignore` 排除的 `docs-work/`（临时工作目录，不算版本区）。完整清单与各文档的职责边界见根 `AGENTS.md` 的「版本区（文档目录入口）」一节。

## 生效方式

**与 `browser/` 口径不同，别承诺错**：`browser/` 是用户根下的普通文件，重跑一次 `install.*` 即生效；本模块是 **dsh 插件**，装进 profile 之后**必须重启 dsh**（loader 按解析路径缓存 ES 模块），再在**新建对话**里验收。

判据分三层，缺一层就不算生效：

1. **包在不在**：`<DSH_HOME>/plugins/adg-notify/`（稳定副本）与 `<profile>/node_modules/adg-notify/package.json`（真目录）。
2. **被选没被选**：该 profile 的 `dependencies` 与 `dsh.profile.bundles` 里都有 `adg-notify` —— **装了 ≠ 被选中**。
3. **运行期注册没注册**：只有重启 dsh 之后才能观测。

部署由 `install.ps1` / `install.sh` 的第 2b 步（把 `notify/` 拷到用户根的稳定副本）与第 4c / 4c-1 步（逐 profile `dsh plugin --profile <n> add file:<稳定副本>` + 读回断言）完成。两条代价与好处都是硬事实：仓库源与稳定副本**在不同盘**，不可能硬链接 ⇒ 改了仓库里 `notify/` 的源码**必须重跑一次 `install.*`**；稳定副本与各 profile 的副本**是硬链接（同一个文件）** ⇒ 刷新稳定副本就等于刷新所有 profile 副本，不必 `dsh plugin remove` + `add`（I10 / I11）。

**未观测**：重启 dsh 后 `notify_user` 是否真的出现在子代理的工具面里；量法：重启 dsh → 新建 Adg 对话 → 用 `delegate` 派一个带 `notify_user` 的子代理，看它那次拿到的工具面里有没有这个名字，或让它去撞一次"登录墙"看它是否调用 `notify_user`。