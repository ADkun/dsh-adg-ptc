# AGENTS.md — settings（Adg 设置页框架）

本模块 = 一个 dsh 插件包 **`adg-settings`**：在「设置」里注册一页 **Adg 设置**（浏览器半边 `client.js`），并提供宿主半边的同源读写路由 **`/api/adg-settings/settings`** 与一个设置文件 **`<DSH_PROFILE_DIR|DSH_HOME|~/.dsh>/adg-settings.json`**（**优先 profile 目录**：本机宿主进程里 `DSH_PROFILE_DIR` 就是当前 profile 目录 ⇒ 真实落点是 `<profile>\adg-settings.json`，**不是**用户根那份）。它是**一套框架**：加一项配置 = 在 `lib/schema.mjs` 的 `FIELDS` 加一条登记 + 在 `client.js` 的 DICT 里加两条文案（`label` / `hint`），宿主与客户端的逻辑都不用改。现有两个占用者、共六条登记：通知三项（`notifyTitle` / `notifySound` / `notifyPersist`，由 `adg-notify` 消费）与思考框架注入三项（`skillInjectEnabled` / `skillInjectSubagent` / `skillInjectText`，由 `adg-skill-inject` 消费；`skillInjectSubagent` ＝ 子代理是否也注入同一段框架，**默认关** ⇒ 只注入调度者 ＝ 与改动前行为一致）。设计与不变量见 [design.md](design.md) 的 I1..I14。

**为什么本模块有独立文档**（三样信号都在）：有独立于仓库根的命令（`node --test test`）；有模块特有红线（只放用户要的项、技术类键不许进页面、键名真相只在 `lib/schema.mjs`、消费方不许 import 本包、未知键与非法值必须拒且不落盘）；有跨模块路由（`install.ps1` / `install.sh` 部署它；`adg-notify` 按**文件契约**读它写的设置文件）。

五个名字**不同名也不同物**，别串：

| 名字 | 值 | 用在哪 |
|---|---|---|
| 包名 | `adg-settings` | profile 的 `dependencies` 与 `dsh.profile.bundles`、`settings/cordis.patch.yml` 的 `name:` |
| 行 id（= 插件模块的 `export const name`） | `adg-settings` | `settings/cordis.patch.yml` 的 `id:` |
| 路由前缀 | `/api/adg-settings` | 宿主半边 `index.js` 的 `ROUTE_PATH`（**未导出**，是 HTTP 契约，不是模块契约） |
| 设置页路由 | `/api/adg-settings/settings` | `client.js` 的 `ROUTE`；GET 读 / POST 写 / DELETE 恢复默认 |
| 设置文件 | `adg-settings.json` | `settings/index.js`、`notify/lib/user-settings.mjs` 与 `skill-inject/lib/user-settings.mjs` 各有一份同名常量（文件契约，三方同名靠漂移用例钉住） |
| 设置页 id / order | `adg-settings` / `38` | `client.js` 注册进 `settings.section` 的 `id` / `order`（36 = `dsh-insert-context`、37 = `dsh-subagent-mgm`、430 = `dsh-plugin-save-token`） |

## 命令

cwd 都是仓库的 `settings/` 目录：

```sh
node --test test                        # 30 个用例：不碰真机 profile（全部走 mkdtemp），可安全跑
node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里必须加这个 flag
```

零第三方依赖：宿主半边只用 Node 内建模块；浏览器半边只用 dsh 供给的 `react`（`window.__ModuleLoader__`）。没有构建步骤 —— `main` 直接指 `./index.js`，`exports` 另给 `./client` 与 `./lib/schema.mjs`。

## 红线

每条一行结论 + 就地理由 + 来源与载体（`[机检]` 给命令与期望判据，`[评]` 给评审判据）。**违反即返工。**

- **R1 设置页只放「用户需要拍板」的项；技术类键（`appId` / `timeoutMs` / `scriptPath` / `powerShellPath`）不许进 `FIELDS`、不许出现在设置页，也不许由页面写进设置文件。** 理由：这是用户定下的口径 ——「以现有的可配置项为准，不新增可配置项」（2026-10-07 的设置页任务）。技术类键属于机器/部署细节，改它们的正确位置是 `cordis.patch.yml` 的 `config:` 或 profile，不是给人点的开关。载体：[机检] `settings/test/settings.test.mjs` 的「I1」用例断言 `FIELDS` 的键集合就是那六项（通知三项 + 注入三项，`skillInjectText` 是用户要写的正文，不是技术键）；[评] 读 `FIELDS` 与设置页截图。
- **R2 新增一条配置项必须先问用户再动手。** 理由：同上（用户的硬约束）。载体：[评] 读那次对话与 `FIELDS` 的 diff。
- **R3 键名 / 默认值 / 界的真相只在 `settings/lib/schema.mjs`；消费方（`adg-notify` / `adg-skill-inject`）只读**文件**、不许 import 本包。** 理由：三者是各自独立的插件包，profile 里可能只装其中一个 —— import 一个解析不到的包会在挂载期把整个插件炸掉；设置文件是模块之间**唯一**的契约。载体：[机检] `settings/test/settings.test.mjs` 的四条「漂移」用例（两组键集合、两组默认值、两个 `maxLength`、三份 `STORE_NAME` 同名）。
- **R4 浏览器半边不许自己定义界**：渲染与本地校验都用宿主 `GET` 回来的 `fields[]`。理由：第二份界就是漂移的源头（页面放行、宿主拒掉，就变成"保存了但没生效"）。载体：[评] 读 `client.js` 的 `checkField` / `displayValue`；[机检]「I3」用例断言 `describeFields()` 是可 JSON 化的纯数据。
- **R5 认不得的键与非法值一律 400，且**不许落盘**。** 理由：静默吞掉会让「设置怎么没生效」变成谜；半份写入会让文件与页面各说各话（页面显示 A、文件里是 B）。载体：[机检] 两条 400 用例（含「被拒的请求不许写盘」与「不动已保存的值」）。
- **R6 POST 是逐键合并，不是整份替换。** 理由：页面只提交它这一版认识的键，整份替换会把文件里其它键（例如后续版本加的、或手写的）抹掉。载体：[机检]「POST 是逐键合并不是整份替换」用例。
- **R7 同源栅栏不许放宽**：非回环 Host / `sec-fetch-site: cross-site` / 外站 `Origin` / 外站 `Referer` 一律 403；`connection` 服务在场时**以它的判定为准**，不自己再判一次。理由：这条路由能把设置写进用户根，跨站请求伪造它等于让任意网页改本机通知行为。载体：[机检]「请求栅栏」与「connection 服务在场」两条用例。
- **R8 `export const name` 必须等于 `cordis.patch.yml` 那一行的 `id`。** 理由：patch 行落**全局层**，同一层重名注册会直接失败 —— 那会拖垮整个 profile 的插件加载，不是"多一个页面"。载体：[机检]「插件名与路由前缀是契约」用例；改完在仓库根跑 `node tools/check-preset.mjs`（exit 0）。
- **R9 写盘必须原子（临时文件 + rename）、权限 0600、目录不存在先建。** 理由：设置文件在用户根，半截 JSON 会让页面读成「没保存过」，而这份文件还有第二个读者（`adg-notify`）与第三个读者（`adg-skill-inject`）。载体：[机检] 写盘用例（`.tmp` 已改名；非 Windows 上断言 `mode & 0o777 === 0o600`）。
- **R10 不许写死本机绝对路径。** 理由：仓库红线；落点一律由 `settingsFile()` 从 `DSH_PROFILE_DIR` / `DSH_HOME` / `homedir()` 推出。载体：[评] 读 `index.js` / `client.js`；[机检] 仓库根的 `node tools/check-preset.mjs`。
- **R11 不许把设置文件当"运行期热重载"通道，也不许要求用户重启才能让设置生效。** 理由：`adg-notify` 每次调用重读一次文件、`adg-skill-inject` 每次组装系统提示词重读一次文件（这就是"保存后立即生效"的全部实现）；本插件写盘后下一次 GET 就反映真相。载体：[评] 读 `notify/index.mjs` 的 `defaults: () => readUserDefaults()` 与 `skill-inject/index.mjs` 的 `sectionTextNow()`。
- **R12 浏览器半边的 DICT 必须给每条 `labelKey` / `hintKey` 各一份 zh 与 en 文案。** 理由：登记表里写的是键名，页面按 `t(field.labelKey)` 取字；少一份就会出现"页面上显示 `field.x.label`"这种裸键。载体：[机检] 「客户端 DICT 覆盖了登记表里的每一条文案键」用例（对 `client.js` 做文本级计数）。

## 版本区

本模块的最终文档只有三份，都在仓库 `settings/`：`settings/AGENTS.md`（本文件，路由）→ [design.md](design.md)（设计：对象、不变量、接口）→ [testing-guide.md](testing-guide.md)（验证：用例总表、消费方契约、未观测项）。三份进 git、互相引用，内容一变就写回这三份本身。过程件一律住被 `.gitignore` 排除的 `docs-work/`。完整清单见根 `AGENTS.md` 的「版本区（文档目录入口）」一节。

## 生效方式

**与 `browser/` 口径不同，别承诺错**：本模块是 **dsh 插件**，装进 profile 之后**必须重启 dsh**（loader 按解析路径缓存 ES 模块），再刷新页面 / 新建对话看效果。判据分三层，缺一层就不算生效：

1. **包在不在**：`<DSH_HOME>/plugins/adg-settings/`（稳定副本）与 `<profile>/node_modules/adg-settings/package.json`（真目录）。
2. **被选没被选**：该 profile 的 `dependencies` 与 `dsh.profile.bundles` 里都有 `adg-settings` —— **装了 ≠ 被选中**。
3. **运行期注册没注册**：重启 dsh 之后，设置页左栏出现「Adg 设置」，且那一页能读能写 —— 只有这一步能证明宿主半边的路由与浏览器半边的 `settings.section` 都注册上了。

部署由 `install.ps1` / `install.sh` 的第 2b-3 步（把 `settings/` 拷到用户根的稳定副本）与第 4c-6 / 4c-7 步（逐 profile `dsh plugin add file:<稳定副本>` + 读回断言三格）完成。仓库源与稳定副本在不同盘，不可能硬链接 ⇒ 改了仓库里 `settings/` 的源码**必须重跑一次 `install.*`**。

**未观测**：重启 dsh 后这一页在真浏览器里的观感（开关的命中区域、窄窗口下的换行、暗色主题的对比度）与 `order: 38` 是否与别的插件撞车；量法：重启 dsh → 打开设置 → 看左栏顺序与页面渲染 → 用 `node -e` 列出各插件注册的 `order` 比对。