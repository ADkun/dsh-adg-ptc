# AGENTS.md — skill-inject（`adg-skill-inject` 注入插件）

本模块是仓库的**第四枚第一方子插件**：包名 `adg-skill-inject`，在**全局层**注册一段系统提示词 section，把框架**正文**注入 **Adg 调度智能体**的系统提示词 —— 不依赖模型自觉去 `read`（persona 级的【思考框架闸门】已被证过不可靠，这正是本模块存在的理由）。注入的**是哪一份框架**由设置键 `skillInjectFramework` 在三份技能文件（`elegant-framework` / `thinking-framework` / `execution-framework`）之间选，**出厂默认优雅框架**。
装载形状与 `notify/` / `permission/` 同一种（稳定副本 + profile 的 `file:` 依赖 + `dsh.profile.bundles`）；它**不注册任何工具**，不占 `KNOWN_TOOLS` 名单。设计细节在 [design.md](design.md)，验证判据在 [testing-guide.md](testing-guide.md)。

**正文与开关都是用户可配的**（两个入口、一份真相）：正文默认取**下拉选中那份**技能文件 —— `skillInjectFramework`（`'elegant'` | `'thinking'` | `'execution'`，**默认 `'elegant'`**）指向 `skills/elegant-framework/SKILL.md`、`skills/thinking-framework/SKILL.md` 或 `skills/execution-framework/SKILL.md`；也可以在「设置 → Adg 设置」里写自定义正文（`skillInjectText`，留空＝跟随选中的技能文件）；开关有两个 —— `skillInjectEnabled`（要不要注入）与 `skillInjectSubagent`（子代理是否也注入同一段，**默认关** ＝ 与这条开关引入前完全一致：只注入调度者）。`skillInjectEnabled` 在设置页与**聊天输入框左侧那颗「超思」chip**（`client.js`，`conversation.input.left`、`order: 21`）都写同一个键；`skillInjectFramework` 与 `skillInjectSubagent` 只在设置页。四个键的登记在 `settings/lib/schema.mjs` 的 `FIELDS`，本模块只**读**设置文件（`lib/user-settings.mjs`），**不 import `adg-settings` 包**。

## 命令

零依赖；只要 Node（`skill-inject/package.json` 声明 `>= 22`）。

```sh
cd skill-inject && node --test test                        # 单元测试；纯函数，零副作用
cd skill-inject && node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里必须加这个 flag
```

本模块不 import `@deepseek-ai/dsh-tools`，所以不依赖仓库根的 `node_modules/` 解析桥（与 notify/permission 不同）。

## 红线

每条只写结论、理由与载体（**违反即返工**）。根 `AGENTS.md` 的「关键红线」同样适用于本模块。

| # | 红线 | 理由 | 载体 |
|---|---|---|---|
| R1 | 注入判据分两层：**preset 闸门不放宽** —— `shouldInjectFor()` 只判 preset（`composedPreset` 优先、会话头 `agentPreset` 后备，必须**恒等于 `'adg-ptc'`**），拿不到 preset 就**不注入**（fail-closed，宁漏勿错）；**子代理不再一律排除** —— 子代理由内容层的设置键 `skillInjectSubagent` 决定（默认 `false` ＝ 与这条键引入前完全一致：只注入调度者）。 | preset 闸门是「别把框架塞进错误会话」的最后一道防线，不能因新增子代理开关而松动；「子代理要不要背这份框架」是用户的偏好而非安全边界，所以做成可即时翻的设置键。闸门放在**内容层**（每次组装系统提示词时求值）而不是注册层，是为了让翻开关**下一轮就生效**（不必重启 dsh、不必新建 agent）。 | `test/section.test.mjs` 的 `shouldInjectFor` / `isSubagentHeader` 用例组；`test/user-settings.test.mjs` 的出厂默认键用例 |
| R2 | **禁止把本插件行写进 `preset/agent.cordis.yml`**。 | preset composition 里的 scoped section 会经 `composeFrom` 一并落到子代理（agent-preset-registry 的 `join` 把子代理 scope 直接绑到 generation scope），"只给调度者"必须靠全局层 + 逐 agent 判定。 | `skill-inject/cordis.patch.yml` 顶注；`node tools/check-preset.mjs`（preset 里没有它就是对的） |
| R3 | **禁止在 prompt section 之外再注册任何工具或监听器**（`agent/created` 与 `agent/disposed` 除外）。 | 本插件只做注入；多挂一个监听器就是多一份每步开销，也越过「最小面」红线。 | [评] 读 `index.mjs` 的 `apply()` |
| R4 | 注入正文一律取自 `lib/section.mjs` 的 `resolveSectionText()` / `sectionTextFor()`：**禁止在插件里内联框架文本的副本**。 | 正文的事实源是三份技能文件之一（按 `skillInjectFramework` 选，出厂＝优雅框架）或用户自定义正文；内联副本会在技能更新后静默漂移。 | [评] `index.mjs` 不得出现框架句子 |
| R5 | SKILL.md 缺失 / 空文件 / 读失败时**必须走降级指令**（`fallbackText(framework)`），不许静默注册空 section，也不许让插件挂载失败。 | 空 section 渲染时被丢弃 = 无声失效；挂载失败 = 整个 profile 的插件层报错。降级指令至少保住"先 read 再干活"的次序。 | `test/section.test.mjs` 的缺失 / 空文件用例 |
| R6 | frontmatter 必须剥掉（`stripFrontmatter`）。 | 技能头的 name/description 是技能目录登记元数据，塞进系统提示词是噪音，还会让模型困惑"该不该调 skill 工具"。 | `test/section.test.mjs` 的 stripFrontmatter 用例组 |
| R7 | section 的 `name` / `order` / 目标 preset 的常量**只写在 `lib/section.mjs` 一处**。 | `index.mjs`、测试、cordis.patch.yml 注释一律从那儿 import 或按名引用；另抄一份就是漂移源。 | `test/section.test.mjs` 的契约常量用例 |
| R8 | `export const name` 必须等于 `cordis.patch.yml` insert 行的 `id`（`adg-skill-inject`）。 | 同名不匹配 = 插件加载失败或落错行。 | `skill-inject/cordis.patch.yml`；`skill-inject/index.mjs` |
| R9 | 禁止写死任何本机绝对路径或用户根。 | 默认路径按 `${DSH_HOME:-~/.dsh}` 逐级拼装（`lib/section.mjs` 的 `skillsRoot()` 与 `skillPathFor(framework)`；`DEFAULT_SKILL_PATH` 只是出厂框架那份的便捷别名），由环境变量解析。 | D7 同款口径（permission 的 R11）；[评] 读 `lib/section.mjs` |
| R10 | 禁止为装插件杀进程或重启正在跑的 dsh。 | dsh 在跑时 pnpm 报 `os error 32` 是**预期**；安装脚本如实报告并继续。 | `install.ps1` / `install.sh` 第 2b-4 / 4c-8 / 4c-9 步 |
| R11 | **禁止另存一份开关状态**：设置项的真相只有设置文件里那几个键（`skillInjectEnabled` / `skillInjectFramework` / `skillInjectSubagent` / `skillInjectText`；设置页与输入框 chip 都走同一条 `POST /api/adg-settings/settings`）。 | 第二份状态（localStorage / 插件 config / 模块变量）会让两个入口各说各话，且宿主读不到。 | [评] `client.js` 只做 `fetch`，无本地持久化；`index.mjs` 每次组装都重读文件 |

## 跨模块路由

| 你要做什么 | 先读 | 再读 |
|---|---|---|
| 改注入判据 / 降级行为 | [design.md](design.md) 的「核心数据模型」 | [testing-guide.md](testing-guide.md) 的「用例总表」 |
| 改 SKILL 路径 / section 名 / order | `lib/section.mjs`（唯一事实源） | 根 `AGENTS.md` 的 Project Map 与本文件 R7 |
| 改开关、框架选择或自定义正文（`skillInjectEnabled` / `skillInjectFramework` / `skillInjectSubagent` / `skillInjectText`） | `settings/lib/schema.mjs` 的 `FIELDS`（键名 / 默认值 / 界的真相）+ 本模块 `lib/user-settings.mjs`（读法） | `settings/design.md` 的「加一项配置的步骤」；输入框 chip 在 `client.js`；两边都要跑 `cd settings && node --test test` |
| 改装载形状 | `install.ps1` / `install.sh` 的第 2b-4 / 4c-8 / 4c-9 步 | `notify/design.md` 的 I8 / I9 / I10 / I11（同一种装法的既有口径） |
| 改框架正文本身 | `skills/elegant-framework/SKILL.md` / `skills/thinking-framework/SKILL.md` / `skills/execution-framework/SKILL.md`（与本模块无关 —— 插件每次组装重读；选哪份由设置键 `skillInjectFramework` 定） | 根 `README.md` 的 skills 一节 |

## 版本区

本模块在版本区里的文档就是 `skill-inject/AGENTS.md`（本文件，路由）→ [design.md](design.md)（设计、不变量）→ [testing-guide.md](testing-guide.md)（用例全表与未观测项）三份。完整清单与根入口见根 `AGENTS.md` 的「版本区」一节，此处不另抄。

## 生效方式

| 改了什么 | 怎么生效 | 怎么复核 |
|---|---|---|
| `skill-inject/` 任何文件 | 重装子插件（`install.*` 第 2b-4 / 4c-8 / 4c-9 步）+ **重启 dsh** + 新会话（section 在 agent 创建那一刻注册，运行中的旧 agent 不补挂） | `cd skill-inject && node --test test`；再在**新 Adg 会话**里核对系统提示词开头附近出现与下拉选中那份框架一致的段落（出厂＝「# 优雅框架（elegant-framework）」） |
| 只改**设置页里的开关、框架选择或自定义正文**（`skillInjectEnabled` / `skillInjectFramework` / `skillInjectSubagent` / `skillInjectText` 的值） | **保存即生效、不用重启**（下一次组装系统提示词就读到新值）；输入框那颗「超思」chip 同理 | 设置页改一项 → 下一条消息就让调度者读系统提示词，看框架段是否变了；chip 点一下再刷新页面看设置页是否同步 |
| 本模块任何 `.md` 文档 | 立即生效（只是文件） | 按 `adg-doc-criterion` 技能的质量红线清单自检 |

**未观测**：`agent/created` 监听里 `composedPreset(agent.ctx)` 在**冷恢复**（resume）场景的取值是否恒为 `'adg-ptc'`（运行期判定走 standing mount，会话头 `agentPreset` 字段是后备）；量法：重启 dsh 后 resume 一个旧的 Adg 会话，在系统提示词里确认框架段落仍在，再对照 `lib/section.mjs` 的 `shouldInjectFor` 用例逐条核。
**未观测**：`conversation.input.left` 槽里 `order: 21` 与破限模式那颗 chip（`order: 20`）在真浏览器里的间距与换行；量法：重启 dsh 打开聊天页，看两颗 chip 是否同行、是否重叠（窄窗口再试一次）。
**未观测**：`client.js` 的 `POST /api/adg-settings/settings` 在**没装 `adg-settings` 插件**的 profile 上会 404 ⇒ chip 落到 `failed` 态（设计上如此：`disabled` 且文案为读取中）；量法：在只装本插件不装 `adg-settings` 的 profile 上重启，看 chip 是否停在禁用态且不报错。
