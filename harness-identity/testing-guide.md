---
title: harness-identity 模块测试指南
owner: Adg preset 维护者
status: current
last_reviewed: 2026-11-15
---

# testing-guide.md — harness-identity（`adg-harness-identity` 去除系统提示词固定开场白插件）

用例全表与未观测项。路由见 [AGENTS.md](AGENTS.md)，设计见 [design.md](design.md)。

## 用例总表

用例 ID 前缀含义：**G** = 判定（`shouldInjectFor`）· **S** = 覆盖常量（section 名 / order / 空文本）· **W** = 假 ctx 接线（`apply` 行为）· **C** = 文件契约 / 防漂移 · **M** = 真实挂载（手工，未自动化）。全部 `node --test test` 现为 24 条（G1–G5 / S1–S4 / W0–W9 / C1–C5），全绿；M 系列见「覆盖边界」。

| ID | 测什么 | 怎么测 | 对应不变量 | 类型 |
|---|---|---|---|---|
| G1 | header.agentPreset=adg-ptc ⇒ 覆盖 | `shouldInjectFor({agentPreset:'adg-ptc'}, undefined) === true` | I4 | [机检] |
| G2 | 其它 preset ⇒ 不覆盖 | `shouldInjectFor({agentPreset:'native-x'}, undefined) === false` | I4 / I6 | [机检] |
| G3 | composedPresetId 优先于 header ⇒ 覆盖 | `shouldInjectFor({agentPreset:'native-x'}, 'adg-ptc') === true` | I4 | [机检] |
| G4 | header 缺失 ⇒ 不覆盖（fail-closed） | `shouldInjectFor(undefined, undefined) === false` | I4 | [机检] |
| G5 | 空 header ⇒ 不覆盖 | `shouldInjectFor({}, undefined) === false` | I4 | [机检] |
| S1 | `shadowSection()` 形状固定：同名 / order -1000 / 空文本 | `deepEqual(shadowSection(), {name:'harness:identity', order:-1000, text:''})` | I1 / I2 / I3 | [机检] |
| S2 | `SECTION_NAME='harness:identity'`、`TARGET_PRESET='adg-ptc'` | 直接相等断言 | I1 / I3 | [机检] |
| S3 | `SECTION_ORDER=-1000` 且为有限数 | `=== -1000` 且 `Number.isFinite` | I3 | [机检] |
| S4 | `SHADOW_TEXT` 为空串（覆盖不留输出、不留空行） | `=== ''` | I2 | [机检] |
| W0 | 恰好注册一个 `agent/created` 监听器，effect 标签在位 | 遍历 `ctx._labels === ['adg-harness-identity.section()']`、`_listeners.length === 1` | I8 | [机检] |
| W1 | adg-ptc agent 在它自己的 scope 注册覆盖 section | 假 agent 的 `pushes` 收到一条 `{name:'harness:identity', order:-1000, text:''}` | I5 | [机检] |
| W2 | 非 adg-ptc agent 一个 section 都不注册 | 假 agent `pushes.length === 0` | I6 | [机检] |
| W3 | composedPreset=adg-ptc 时即使 header 是别的也注册 | `agentPresets.composedPreset=()=>'adg-ptc'`，header=native-x ⇒ 注册一条 | I4 / I5 | [机检] |
| W4 | composedPreset=别的 时即使 header 是 adg-ptc 也不注册（composed 优先） | composed 返回 native-x ⇒ 0 条 | I4 / I6 | [机检] |
| W5 | payload 里没有 agent 时不注册、也不抛错 | `_emit({})` / `_emit(undefined)` 均不抛 | I7 | [机检] |
| W6 | agent.ctx 缺失时不注册、也不抛错 | `hasCtx:false` ⇒ 不抛、0 条 | I7 | [机检] |
| W7 | section() 抛错时不外抛（单 agent 失败不拖垮其它 agent） | 注入抛错型 `systemPrompt.section` ⇒ `doesNotThrow` | I7 | [机检] |
| W8 | disposer 移除监听器 | `ctx._dispose()` 后 `_listeners.length === 0` | I8 | [机检] |
| W9 | agentPresets 服务缺失时按 header 判定仍工作 | `agentPresets=undefined`，header=adg-ptc ⇒ 注册一条 | I4 / I5 | [机检] |
| C1 | `export const name` === `cordis.patch.yml` 的 insert id === `adg-harness-identity` | 读 yml 正则取 id 后相等 | I11 | [机检] |
| C2 | `inject` 恰好 `['systemPrompt']` | `deepEqual(inject, ['systemPrompt'])` | I8 | [机检] |
| C3 | `package.json` 的 name / main / dsh.bundle.patch / engines 与实现一致 | 读 pkg 断言四字段 | I11 | [机检] |
| C4 | 零第三方依赖：`index.mjs` 与 `lib/section.mjs` 不含 `@deepseek-ai` | 读源码正则否定 | I9 | [机检] |
| C5 | 源码里出现 section 名 `harness:identity` 与 order `-1000`（常量单点钉住） | 两文件拼接后 `match` 两正则 | I1 / I3 | [机检] |
| M1 | 新 Adg 调度者会话的系统提示词开头没有 `You are an AI agent, powered by DeepSeek Harness.` 一行 | 重启 dsh → 新建「Adg PTC 模式」对话 → 读系统提示词，肉眼确认开头无此行、且无多余空行 | I1 / I2 / I10 | [人] |
| M2 | 子代理的系统提示词里那一行同样消失 | 同一会话里派一个子代理，读它自己的系统提示词开头 | I5 / I6 / I10 | [人] |

## 沙箱注意

- 命令 cwd 是 `harness-identity/`：`node --test test`；在 DSH 沙箱（workspace-write）里跑要加 `--test-isolation=none`（否则子进程隔离会触发文件策略拒绝）。
- 全部是**纯单测**：不 import cordis、不启 dsh、不读写仓库外文件（只读本模块自己的 `index.mjs` / `lib/section.mjs` / `cordis.patch.yml` / `package.json`）。假 ctx 只实现 `apply()` 用到的 `effect / on / get`（见测试文件 `makeCtx` / `makeAgent`）。
- 零第三方依赖：`node --test` 用 Node 内建 test runner，无 `node_modules` 需求。

## 漂移检测

单测钉住下面这些"必须与外部对齐"的点；任何一处漂了都会先红：

- **插件名三处一致**（C1）：`export const name` ↔ `cordis.patch.yml` 的 insert id ↔ `package.json` 的 name，都是 `adg-harness-identity`。
- **section 名 / order**（S1–S3、C5）：`harness:identity` 必须逐字等于平台全局那段的名字（[design.md](design.md) 第 5 节）；`-1000` 必须等于 `SECTION_ORDERS.HARNESS_IDENTITY`。**升级 dsh 后先跑单测**：若平台改了段名或 order，S2/S3/C5 会红。
- **判定口径**（G1–G5）：与 `skill-inject/lib/section.mjs` 的 `shouldInjectFor` 同口径（composed 优先、fail-closed）；改一处要同步改另一处。
- **常量单点**（I3 / C5）：section 名、order、目标 preset 只在 `lib/section.mjs` 定义；`index.mjs` 只引用不重抄。
- **覆盖 section 必须是空文本**（S1 / S4）：若有人把 `SHADOW_TEXT` 改成非空，S4 立刻红 —— 那意味着本插件从"删除"变成了"替换"。
- **（未观测）稳定副本↔profile 对齐**：`install.ps1` 在部署后逐文件比对稳定副本与 `node_modules` 副本；单测管不到这一步，改文件清单（`$harnessFiles`）时要同步本模块的 `package.json` 的 `files`。

## 覆盖边界（不许越界宣称）

- **单测证明不了运行期接线**：G/S/W/C 全部在**假 ctx** 上跑，只能证明"判定对、常量对、apply 会按预期调 section、文件契约一致"；它证明不了真实 dsh 里 `agent/created` 的时序、也证明不了渲染结果 —— 那些是 M1/M2 的事。
- **M1/M2 是抽样，不是回归**：手工在真会话里看一眼，覆盖"调度者 + 子代理"两侧各一次；不代表其它 preset / 其它 profile 也验证过（本插件只对 `adg-ptc` 生效，别的本就不该动）。
- **安装三格只证明"包在位 + 被选中"**：`install.ps1` 第 4c-17 步的读回断言三格（`node_modules` 真目录 + `dependencies` + `dsh.profile.bundles`）不证明运行期真的注册了覆盖 section —— 那要重启后由 M1 观测。
- **系统提示词不是机制闸门**：删掉这行只是"少一句平台默认话术"，它**不是**权限 / 沙箱 / 工具能力的边界。不要把"没有这句话"当成任何安全或行为保证。
