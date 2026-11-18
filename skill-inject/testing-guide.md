---
title: skill-inject 模块测试指南
owner: Adg preset 维护者
status: current
last_reviewed: 2026-11-10
---

# testing-guide.md — skill-inject（`adg-skill-inject` 注入插件）

用例全表与未观测项。路由见 [AGENTS.md](AGENTS.md)，设计见 [design.md](design.md)。

## 用例总表

用例 ID：`U-*` = `test/section.test.mjs` 的单元用例；`S-*` = `test/user-settings.test.mjs`（设置文件的宽容读法）；`M-*` = 真实挂载验证（重启 dsh 后人工/会话内核验）。

| ID | 测什么 | 怎么测 | 对应不变量 | 类型 |
|---|---|---|---|---|
| U1 | frontmatter 剥离：头部 `---` 块去掉、正文保留 | `node --test test`（`stripFrontmatter` 用例组，含无 frontmatter / 正文含 `---` / CRLF 三种） | I4 | `[机检]` |
| U2 | 真文件 → 原样正文（无标题无导语）、`degraded: false`、frontmatter 不在正文里 | `sectionTextFor` 用例（临时目录写真文件） | I2 | `[机检]` |
| U3 | 文件缺失 → `fallbackText(skill)`、`degraded: true` | `sectionTextFor` 用例（指向不存在的路径） | I3 | `[机检]` |
| U4 | 空文件（剥完 frontmatter 剩空白）→ 降级 | `sectionTextFor` 用例 | I3 | `[机检]` |
| U5 | 判据矩阵（注册层）：preset 为 `adg-ptc` 的 Adg 调度者注入 / **preset 为 `adg-ptc` 的子代理同样注入**（子代理不在注册层被排除）/ 其他 preset 不注入 / 判据全缺不注入 | `shouldInjectFor` 用例组 | R1 / design 注册层 | `[机检]` |
| U6 | 契约常量：`SECTION_NAME` / `SECTION_ORDER` / `TARGET_PRESET` / `DEFAULT_SKILL` / `skillPathFor` 形状（`SECTION_NAME` 仍是 `'adg:thinking-framework'` —— 它是 section 唯一名，与选哪份技能无关；`DEFAULT_SKILL === 'execution-framework'`） | 契约常量 + 路径拼装 + `listSkills` 用例 | R7 | `[机检]` |
| U7 | 自定义正文优先：填了正文就用它（`source: 'custom'`、不读文件、原样注入、无导语） | `resolveSectionText` 用例 | I2 / I7 | `[机检]` |
| U8 | 留空 / 全空白 → 回落技能文件（`source: 'skill'`）；留空且文件也缺 → 仍走降级 | `resolveSectionText` 用例组 | I2 / I3 | `[机检]` |
| U9 | 子代理的正文两级闸门：总开关开 + `skillInjectSubagent` **关** → 子代理拿不到正文（空串）；同一文件里 `skillInjectSubagent` **开** → 子代理拿到正文；总开关关时两者都拿不到 | `sectionTextNow({ subagent: true/false })` 用例（设置文件写到临时目录） | R1 / I3 | `[机检]` |
| U10 | `isSubagentHeader` 只认会话头的 `origin === 'subagent'`：子代理头为真，调度者头为假；缺 `origin` 视为非子代理 | `isSubagentHeader` 用例组 | R1 | `[机检]` |
| U11 | 每份技能各自的降级文案提示的是**自己那份**技能文件（不写死一份） | `fallbackText('thinking-framework')` / `fallbackText('execution-framework')` 用例，各自断言不出现另一份的路径；`fallbackText()` 缺省＝出厂技能 | I3 | `[机检]` |
| U12 | 技能切换端到端：`skillInjectSkill` 换一下，注入的正文（命中的技能文件名）跟着换（走 `sectionTextNow()` + 仓库那两份真 SKILL.md：`thinking-framework` / `execution-framework`；缺项与非法值都回落 `execution-framework`） | `section.test.mjs` 的「技能切换」用例 | I2 / I7 | `[机检]` |
| S1 | 出厂默认 `{skillInjectEnabled: true, skillInjectSkill: 'execution-framework', skillInjectSubagent: false, skillInjectText: ''}`、冻结、`STORE_NAME` / `MAX_TEXT_LENGTH` / `MAX_SKILL_LENGTH` | `user-settings.test.mjs` | I7 | `[机检]` |
| S2 | `settingsFile()` 与宿主同口径（`DSH_PROFILE_DIR` > `DSH_HOME`） | 同上 | I7 | `[机检]` |
| S3 | 文件不存在 / 坏 JSON / 数组 / `null` → 出厂默认、不抛错 | 同上 | I7 | `[机检]` |
| S4 | 缺项 / 坏项只影响那一项（含字符串形式的布尔） | 同上 | I7 | `[机检]` |
| S5 | 正文长度上限：正好 20000 收、20001 回落空串 | 同上 | I7 | `[机检]` |
| S6 | `skillInjectSkill` 的读出 / 非法回落：`'execution-framework'` / `'thinking-framework'` / `'my-skill'` / `'a1'` 收；大写 / 带空白 / `''` / `'a/b'` / `'../etc'` / `'a b'` / `'-x'` / `'x-'` / 超长 / `null` / `true` / `1` / `{}` / `[]` 一律回落出厂默认 `'execution-framework'` | 同上 | I7 | `[机检]` |
| M1 | Adg 新会话的系统提示词里有框架段 | 重启 dsh → 新 Adg 会话，看系统提示词（会话日志/轨迹）开头附近出现下拉选中那份技能文件的正文（出厂＝执行框架正文首行「### 执行框架 BEGIN」） | I6 | `[人]` |
| M2 | 子代理的系统提示词里**没有**框架段（`skillInjectSubagent` 默认关） | 同一次 Adg 会话里派一个子代理，看它的系统提示词（轨迹/会话日志）无该正文（出厂＝无「### 执行框架 BEGIN」）；调度者那侧始终有 | R1 / R2 | `[人]` |
| M3 | 其他 preset（standard / ptc / cordis）新会话没有框架段 | 新开一个 standard 会话，同 M1 的检查点 | R1 | `[人]` |
| M4 | 技能文件更新后正文跟着换 | 改 SKILL.md → 重启 dsh → 新 Adg 会话看注入正文已是新版 | I2 | `[人]` |
| M5 | 冷恢复：resume 旧 Adg 会话框架仍在 | 重启 dsh → resume 旧 Adg 会话 → 同 M1 检查点（这条同时是 design.md 的未观测项的量法） | design 未观测① | `[人]` |
| M6 | 设置页改「自定义注入正文」→ 下一轮请求就换正文 | 设置页填一段可辨认的文本 → 保存 → 在同一条会话里发下一条消息，看系统提示词里就是那段文本（前后无标题、无导语）（**不用重启**） | I2 / I6 | `[人]` |
| M7 | 输入框「注入」chip 关掉 → 框架段消失；再开 → 回来 | 点 chip 看它从「注入 开」变「注入 关」→ 发消息看系统提示词里没有框架段 → 再点回来 | I7 / R11 | `[人]` |
| M8 | chip 与设置页是同一个值 | chip 点一下 → 刷新页面打开设置页，看「注入框架」开关是否同步；反向再试一次 | I7 / R11 | `[人]` |
| M9 | 打开「同时注入子代理」→ **不重启**、下一轮派出的子代理系统提示词里出现框架段；关掉 → 又没有 | 设置页打开该开关并保存 → 在同一条会话里再派一个子代理，看它的系统提示词出现选中那份技能文件的正文（出厂＝「### 执行框架 BEGIN」）；关掉保存后再派一次确认消失（**不用重启**） | R1 / I6 | `[人]` |
| M10 | 换技能：把「注入哪个技能」从 execution-framework 切到 thinking-framework → **不重启**、下一轮系统提示词正文从「### 执行框架 BEGIN」换成 thinking-framework 那份（首行「# 思维规范框架」） | 设置页切下拉并保存 → 在同一条会话里发下一条消息，看系统提示词那一段的正文首行（**不用重启**）；再切回来确认能回去 | I2 / I6 / I7 | `[人]` |

## 沙箱注意

仓库工作区里跑：`cd skill-inject && node --test --test-isolation=none test`。本模块测试只写临时目录（`mkdtemp`），不碰工作区文件，零网络。

## 漂移检测

- 插件名 ↔ insert 行 id：`skill-inject/index.mjs` 的 `export const name` 与 `skill-inject/cordis.patch.yml` 的 `- id:` 逐字一致（R8）。
- 正文无内联副本：`skill-inject/index.mjs` 里 grep 不到任何框架句子（R4）—— 判据：文件里不出现「思维规范」等正文词。
- 设置四键的键名 / 默认值 / 长度上限：`skill-inject/lib/user-settings.mjs` 的 `USER_DEFAULTS` / `MAX_TEXT_LENGTH` / `MAX_SKILL_LENGTH` / `STORE_NAME` 必须与 `settings/lib/schema.mjs` 里 `consumer === 'adg-skill-inject'` 的四条登记（`skillInjectEnabled` / `skillInjectSkill` / `skillInjectSubagent` / `skillInjectText`）逐项相等；两处 `listSkills()` 对同一临时技能根列出的名字一致 —— **守卫在 `settings/test/settings.test.mjs`**（跨模块漂移用例），所以改任一侧都要跑 `cd settings && node --test test`。
- **未观测**：稳定副本 ↔ profile 副本是否随 `install.*` 全量对齐（硬链接逐文件、新文件要重跑安装 —— notify 侧已实测过同形机制的这一坑）；量法：加一个新文件后跑 `install.ps1`，核对 `<profile>/node_modules/adg-skill-inject/` 里出现该文件。**本次已经踩过一次**：`client.js` 与 `lib/user-settings.mjs` 是后加的，`install.*` 的部署清单必须同步加（现已加）。

## 覆盖边界（不许越界宣称）

单元测试证明不了注入真的发生（那是 cordis 运行期行为，归 M1–M5）；M 系列证明不了**每个** Adg 会话都注入（抽样性质）。安装脚本的三格断言只证明包在位，不证明 section 注册成功 —— 后者只能看 M1。**chip 的存在与点击也证明不了注入变化**：M7 必须同时看「chip 状态变了」与「系统提示词里框架段没了」，只看到前者是界面层的自证。
