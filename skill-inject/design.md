# design.md — skill-inject（`adg-skill-inject` 注入插件）

设计、核心数据模型与不变量。路由见 [AGENTS.md](AGENTS.md)，用例全表见 [testing-guide.md](testing-guide.md)。

## 为什么存在

思考框架的装载走过三代：

1. **persona 指令**（【思考框架闸门】段）：要求调度者开工时自己 `read` —— 依赖模型自觉，实测会漏；且"检查上下文里有没有正文"这件事模型做不对。
2. **本插件**（现状）：把正文注册成调度者系统提示词的一段 section —— 框架文本**本身就在每次请求的系统提示词里**，不需要模型调任何工具，也就没有"会不会记得调"的问题。正文与开关都做成了用户可配（设置页 + 输入框 chip），因为"用仓库那份"和"我要自己写"是同一个诉求的两种形态。

系统提示词不参与 compaction 的会话历史折叠（compaction 只折叠 durable 的会话日志），所以先前"这份技能读进来的正文不许压缩"的要求由机制天然满足，不再需要任何指令。

## 核心数据模型

### InjectedSection（一段注入）

| 字段 | 取值 | 事实源 |
|---|---|---|
| `name` | `'adg:thinking-framework'` | `lib/section.mjs` 的 `SECTION_NAME`（唯一书写点） |
| `order` | `100` | `lib/section.mjs` 的 `SECTION_ORDER` |
| `text` | `# 思考框架（thinking-framework）` 导语 + SKILL.md 正文（frontmatter 剥掉）；或 `# 思考框架（自定义注入）` 导语 + 设置页填的正文；或降级指令；总开关关闭时是空串；**子代理且 `skillInjectSubagent` 关时也是空串** | `sectionTextNow()`（`index.mjs`）每次组装时求值：先读设置文件的开关与子代理闸门，再交给 `resolveSectionText()` |
| 挂载层 | 每个 Adg 调度者 agent 自己的 `agent.ctx`（agent scope）；**子代理也会挂上这一段**（正文层再决定给不给） | `index.mjs` 的 `apply()` |

**正文优先级**：设置页的 `skillInjectText` 非空白 → 用它（**不读文件**，也不剥 frontmatter —— 那不是技能文件）；留空 / 全空白 → 读 `DEFAULT_SKILL_PATH` 的 SKILL.md；文件缺失 / 空 / 读失败 → `FALLBACK_TEXT`。开关 `skillInjectEnabled !== true` → 返回空串（空 section 渲染时被丢弃，等价于没有这一段）；**是子代理而 `skillInjectSubagent !== true` → 同样返回空串**（这一条就是「子代理要不要也背这份框架」的唯一判据，默认关 ＝ 与这条键引入前完全一致：只注入调度者）。正文优先级判据都在 `lib/section.mjs` 的 `resolveSectionText()` / `sectionTextFor()` 里，`index.mjs` 只做接线。

**order 的选取**：调度 persona 的 prefix 在 `DEPLOYMENT_PERSONA_PREFIX = 0`，plan 政策在 `PLAN_POLICY = 500`。`100` 让框架落在 persona 之后、一切 first-party 指引之前 —— 模型读到的次序是"你是谁 → 按什么方式思考 → 派遣规则"。

### 两个入口、一份真相（开关与正文）

```text
设置页「Adg 设置」 ──┐
                    ├─ GET/POST /api/adg-settings/settings ──> <profile>/adg-settings.json
输入框「超思」chip ──┘                                        └─ sectionTextNow() 每次组装重读
```

- chip 在 `client.js`，注册进 `conversation.input.left`（`id: 'adg-skill-inject-toggle'`、`order: 21` —— 紧跟破限模式那颗 `order: 20`，列表槽按 order 升序排，不重叠）。
- chip **不存任何本地状态**：挂载时 `GET` 读当前值，点一下 `POST {skillInjectEnabled: !current}`，然后 adopt 服务端回的 `value`。所以它和设置页永远同步（R11）。
- 键名 / 默认值 / 长度上限的真相在 `settings/lib/schema.mjs` 的 `FIELDS`（`consumer === 'adg-skill-inject'` **三条**：`skillInjectEnabled` / `skillInjectSubagent` / `skillInjectText`）；本模块的 `lib/user-settings.mjs` 只**读**文件，`USER_DEFAULTS` / `MAX_TEXT_LENGTH` 与登记项逐项相等由 `settings/test/settings.test.mjs` 的漂移用例钉住。

### 注入判据（两层闸门）

`agent/created`（serial 事件，全局层监听者收到**所有** agent）对每个 agent 判定一次。判定分两层：**注册层**决定这一段挂不挂，**内容层**决定给不给正文。

**注册层 —— `shouldInjectFor(header, composedPresetId)`**：

1. **preset 判定**：`ctx.get('agentPresets')?.composedPreset(agent.ctx)`（standing mount，读 scope 链）优先；durable 会话头 `agentPreset` 字段作后备（resume 场景两者都应命中，双写是防单边缺失）。必须**恒等于 `'adg-ptc'`**。
2. **判据缺失不注入**（fail-closed）：`composedPreset` 与 `agentPreset` 都拿不到时按非目标处理 —— 宁可漏掉一个调度者，不可把框架塞进错误会话。**这一层只管 preset，不看是不是子代理** —— 「子代理一律排除」这条已移除。
3. **子代理同样注册**：子代理的 durable 会话头带 `origin: 'subagent'`（dsh-subagent 的 `childSessionMeta()`；resume 唤回的子代理走同一条），它由 `isSubagentHeader(header)` 读出，但**不参与注册层的否决** —— 子代理与调度者一样挂上这一段 section，正文层再决定给不给它。

**内容层 —— `sectionTextNow({ subagent })`**：

1. `skillInjectEnabled !== true` → 返回空串（空 section 渲染时被丢弃）。
2. `subagent === true`（由 `isSubagentHeader(header)` 判定）且 `skillInjectSubagent !== true` → 返回空串。**默认关 ＝ 与这条键引入前完全一致：只注入调度者**。
3. 否则按上面的正文优先级出正文。

**为什么子代理那一层放在内容层、preset 那一层留在注册层**：注册层是 agent 创建那一刻定下的，改它要新 agent；内容层的 `text` 是**每次组装系统提示词都求值**的 provider，所以翻 `skillInjectSubagent` **下一轮就生效**（不需重启 dsh、不需新建 agent）。preset 闸门留在注册层，因为它判的是「这个会话该不该挂框架段」（防塞进错误会话），与用户偏好无关，不能为开关而松动。

**为什么不写在 preset composition 里（R2 的机理）**：`agent-preset-registry` 的 `composeFrom()` 把子代理的 scope **直接** `bindScopeParent(key, generation.key)` 绑到 preset generation scope —— 子代理与调度者离组合层都是 1 步，scope 链深度区分不了二者；`ScopedLayers.chainLayers(scope)` 沿链合并，composition 里注册的任何 scoped section 对调度者与子代理同时生效。所以"注入给谁"只能在**全局层**挂监听、逐 agent 判定后挂到 `agent.ctx`。

### 装载链（与 notify/permission 同一种）

```
skill-inject/（仓库源） --install.* 第 2b-4 步--> ~/.dsh/plugins/adg-skill-inject/（稳定副本）
    --install.* 第 4c-8 步：dsh plugin --profile <p> add file:...--> <profile>/node_modules/adg-skill-inject/
    --dsh.profile.bundles 登记--> Loader 全局层挂一行 insert（id: adg-skill-inject）
```

`package.json` 的 `dsh.bundle.patch = ./cordis.patch.yml`；patch 只有一行 `insert`，落在顶层（global 层）。`export const name` 必须等于 insert 行的 `id`（R8）。

## 不变量

- **I1**：section 注册发生在 `agent/created` 里、挂在 `agent.ctx` 上 —— agent 注销时随 agent scope 自动拆除（`ctx.systemPrompt.section()` 内部就是 `ScopedLayers.effect(this.ctx, ...)`，undo 归调用 ctx 所有）；插件自己的清理只负责拆 `agent/created` 监听器。
- **I2**：正文事实源有两个（用户自定义正文 / SKILL.md），插件里**没有文本副本**（R4）；两者都在**每次组装系统提示词时**重新求值（不是每次启动读一次）—— 设置页改完下一轮请求就换，技能文件改完要重启 dsh（`DEFAULT_SKILL_PATH` 在模块加载时解析）。
- **I3**：文件缺失 / 空 / 读失败 → `FALLBACK_TEXT`（降级指令），插件不挂载失败、不注册空 section。**但开关关闭时返回空串是刻意的**：那不是降级，是用户关掉了这一段；**子代理且 `skillInjectSubagent` 关时返回空串同样是刻意的**（那一段照挂，只是不给正文）。
- **I4**：frontmatter 永不出现在注入正文里（R6，`stripFrontmatter`）。
- **I5**：本插件不注册任何工具，不进 `KNOWN_TOOLS`，不出现在任何 `delegate` 的 `tools` 名单 —— 它不是能力面的一部分，是提示词的一部分。
- **I6**：运行中的旧 agent 不补挂 —— section 在 agent 创建那一刻注册；改插件代码后要新会话才看得到（skill-inject/AGENTS.md 的「生效方式」）。**但改设置值不需要新会话**：`text` 是每次组装都求值的 provider —— 翻 `skillInjectSubagent` 后，**下一次组装**时子代理是否拿到正文就变了（不必重启 dsh、不必新建 agent）。
- **I7**：开关与正文的键名 / 默认值 / 界的真相只在 `settings/lib/schema.mjs` 的 `FIELDS`（`skillInjectEnabled` / `skillInjectSubagent` / `skillInjectText` 三条）；本模块**只读文件、不 import `adg-settings` 包**（profile 里可能只装一半）。守卫：`settings/test/settings.test.mjs` 的注入漂移用例。

## 非功能约束

- 零运行时依赖：只用 `node:fs` / `node:path`；不 import 任何 `@deepseek-ai/*`（连类型都只出现在 JSDoc 注释里）。
- 单个 agent 的判定 / 注册异常被吞掉（`apply()` 里的 try/catch）：最坏后果是那个 agent 没有框架，不是整个 profile 的插件层报错。

## For Agents（未观测项）

- **未观测**：`composedPreset()` 与会话头 `agentPreset` 在**冷恢复**（dsh 重启后 resume Adg 会话）场景是否都能取到 `'adg-ptc'`；量法：重启 dsh → resume 旧 Adg 会话 → 在系统提示词里确认「# 思考框架（thinking-framework）」段落仍在。双写判定（运行期优先 + 会话头后备）就是对这条未观测的防御。
- **未观测**：`agent/created` 在 `setup` 阶段触发时 `agent.ctx.systemPrompt` 是否已可注册（契约上 setup 完成先于 `agent/created` 与首次组装，且 dsh-subagent 自己就在同一窗口注册 section —— 依据同形，未在本仓库实测）；量法：装好后看新 Adg 会话系统提示词里有没有框架段，没有则查 dsh 日志里 `agent/created` 的时序。
- **未观测**：`conversation.input.left` 槽里 `order: 21` 与破限模式那颗 chip（`order: 20`）在真浏览器里的间距 / 换行 / 暗色对比度；量法：重启 dsh 打开聊天页看两颗 chip 是否同行不重叠（窄窗口再试一次），并用 `node -e` 列出该槽各插件注册的 `order` 比对。
- **未观测**：`POST /api/adg-settings/settings` 在**没装 `adg-settings` 插件**的 profile 上返回 404 时 chip 的最终观感（代码路径：`!response.ok` → `setState({status:'failed'})` → chip `disabled` 且文案走 `ariaLoading`）；量法：在只装本插件的 profile 上重启，看 chip 是否停在禁用态、控制台是否只有一条 404。
