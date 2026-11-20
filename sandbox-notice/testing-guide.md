---
title: sandbox-notice 模块测试指南
owner: Adg preset 维护者
status: current
last_reviewed: 2026-11-16
---

# testing-guide.md — sandbox-notice（`adg-sandbox-notice` 去除 run_code 沙箱提示噪声插件）

用例全表与未观测项。路由见 [AGENTS.md](AGENTS.md)，设计见 [design.md](design.md)。

## 用例总表

用例 ID 前缀：**N** = 单行剥除（`stripNoticeLine`）· **A** = 数组级（`stripSandboxNotice`）· **W** = 假 ctx 接线（`apply` + handler）· **C** = 文件契约 / 防漂移 · **M** = 真实挂载（手工，未自动化）。`node --test test` 现为 27 条（N1–N7 / A1–A6 / W0–W8 / C1–C5），全绿；M 系列见「覆盖边界」。

| ID | 测什么 | 怎么测 | 对应不变量 | 类型 |
|---|---|---|---|---|
| N1 | 末尾整行 notice（前有换行）被剥 | `stripNoticeLine('a\n' + NOTICE) === 'a'` | I2 | [机检] |
| N2 | 整段仅 notice ⇒ 空串 | `stripNoticeLine(NOTICE) === ''` | I2 | [机检] |
| N3 | notice 在中间（后面还有内容）不动 | `stripNoticeLine('x\n' + NOTICE + '\ny')` 原样 | I2 | [机检] |
| N4 | 内联出现（前不是换行）不动 | `stripNoticeLine('a ' + NOTICE)` 原样 | I2 | [机检] |
| N5 | notice 后带尾随空格 / 制表仍剥 | `stripNoticeLine(NOTICE + ' \t') === ''` | I2 | [机检] |
| N6 | 无 notice / 非字符串原样 | `'hi'→'hi'`；`null→null` | I2 | [机检] |
| N7 | notice 前的正文逐字保留 | `'line1\nline2\n'+NOTICE → 'line1\nline2'` | I2 | [机检] |
| A1 | 单 text 块末尾 notice 被剥 | `stripSandboxNotice([{type:'text',text:'a\n'+NOTICE}])` ⇒ `[{text:'a'}]` | I2 | [机检] |
| A2 | 仅 notice 的块 ⇒ 回退 EMPTY_OUTPUT | ⇒ `[{type:'text',text:EMPTY_OUTPUT}]` | I3 | [机检] |
| A3 | image + 仅 notice 的 text 块 ⇒ 保留 image、丢空 text、不回退 | 结果长度 1、`out[0]===img` | I4 | [机检] |
| A4 | 无 notice ⇒ 同一引用 | `out === input` | I5 | [机检] |
| A5 | 空数组 / 非数组原样 | `[]→[]`（同一引用）；`undefined→undefined` | I5 | [机检] |
| A6 | 多块仅末块含 notice：其它块原样、返回新数组 | `out!==input`、`out[0]===first`、`out[1].text==='a'` | I2 / I5 | [机检] |
| W0 | 恰好一个 post-execute 监听器、prepend=true、effect 标签在位 | `listeners.length===1`、`opts.prepend===true`、`labels[0]==='adg-sandbox-notice.strip()'` | I7 / I8 | [机检] |
| W1 | run_code accept 含末尾 notice ⇒ 结果被剥、无该行 | `out.content[0].text==='hello'`、`out!==decision` | I1 / I2 | [机检] |
| W2 | 非 run_code ⇒ 原 decision（同一引用） | `out === decision` | I1 / I5 | [机检] |
| W3 | block 决策 ⇒ 原 decision | `out === decision` | I1 | [机检] |
| W4 | accept-with-value ⇒ 原 decision | `out === decision` | I1 | [机检] |
| W5 | 无 notice ⇒ 原 decision（同一引用） | `out === decision` | I5 | [机检] |
| W6 | 仅 notice ⇒ 回退 EMPTY_OUTPUT | `out.content[0].text === EMPTY_OUTPUT` | I3 | [机检] |
| W7 | next 返回 null / exec 缺失不抛、返回原值 | `await run(...,null)===null`；exec 缺失时 `out===decision` | I6 | [机检] |
| W8 | disposer 移除监听器 | `ctx.dispose()` 后 `listeners.length===0` | I8 | [机检] |
| C1 | name === patch id === adg-sandbox-notice | 读 `cordis.patch.yml` 取 insert id 后相等 | I11 | [机检] |
| C2 | inject === ['tools'] | `deepEqual(inject, ['tools'])` | I8 | [机检] |
| C3 | package.json name / main / dsh.bundle.patch / engines 与实现一致 | 读 pkg 断言四个字段 | I11 | [机检] |
| C4 | 零第三方依赖：index.mjs / lib/strip.mjs 不含 @deepseek-ai | 读源码正则否定 | I10 | [机检] |
| C5 | NOTICE / EMPTY_OUTPUT 字面量钉死 | 与平台句逐字相等 | I9 | [机检] |
| M1 | 真 run_code 成功输出末尾无该句、正文其它字符数量不变 | 重启 dsh → 新建 Adg 对话 → 跑一次正常 run_code，读输出 | I2 / I7 | [人] |
| M2 | denied 情形只少噪声行、拒绝句仍在 | 同一会话造一次被沙箱拒绝的写，读结果 | I1 / I2 | [人] |

## 沙箱注意

- 命令 cwd 是本模块目录：`node --test test`；在 DSH 沙箱（workspace-write）里跑要加 `--test-isolation=none`（否则子进程隔离会触发文件策略拒绝）。
- 全部是**纯单测**：不 import cordis、不启 dsh、不读写仓库外文件（只读本模块自己的 `index.mjs` / `lib/strip.mjs` / `cordis.patch.yml` / `package.json`）。假 ctx 只实现 `apply()` 用到的 `effect` / `on`（见测试文件 `makeCtx` / `handlerOf`）。
- 零第三方依赖：`node --test` 用 Node 内建 test runner，无 `node_modules` 需求。

## 漂移检测

单测钉住下面这些“必须与外部对齐”的点；任何一处漂了都会先红：

- **插件名三处一致**（C1）：`export const name` ↔ `cordis.patch.yml` 的 insert id ↔ `package.json` 的 name，都是 `adg-sandbox-notice`。
- **NOTICE / EMPTY_OUTPUT 字面量**（C5）：必须与 PTC 渲染层那句、空输出占位逐字相同；**升级 dsh 后先跑单测**，平台若改了那句或占位，C5 会红。
- **末尾整行判定**（N1–N7）：若把“只剥末尾”放宽成“删所有出现”，N3 / N4 会红。
- **无变化返回同一引用**（A4 / W2 / W5）：若改成无条件返回新数组，这几条会红（等价于每次都替换结果）。
- **常量单点**（I9 / C5）：`NOTICE`、`EMPTY_OUTPUT` 只在 `lib/strip.mjs` 定义；`index.mjs` 只引用不重抄。
- **（未观测）文件清单对齐**：`install.ps1` 部署后逐文件比对稳定副本与 `node_modules` 副本；单测管不到这一步，改文件清单时要把 `package.json` 的 `files` 与 `install.ps1` 的 `$sandboxFiles` 同步。

## 覆盖边界（不许越界宣称）

- **单测证明不了运行期接线**：N / A / W / C 全部在**纯函数与假 ctx** 上跑，只能证明“判定对、剥除对、apply 会按预期调监听器、文件契约一致”；它证明不了真实 dsh 里 PTC 渲染链的时序、也证明不了与别的后处理器的顺序 —— 那是 M1 / M2 的事。
- **M1 / M2 是抽样，不是回归**：手工在真会话里看一眼，覆盖“正常成功 + 被拒绝”各一次；不代表所有工具 / 所有 profile 都验证过（本插件只对 `run_code` 生效，别的本就不该动）。
- **安装三格只证明“包在位 + 被选中”**：`install.ps1` 第 4c-19 步的读回断言三格（`node_modules` 真目录 + `dependencies` + `dsh.profile.bundles`）不证明运行期真的剥了那句 —— 那要重启后由 M1 观测。
- **不是安全 / 行为边界**：删这行只是“去掉平台默认状态话术”，**不改变**沙箱真实是否拒绝、也不代表某个操作通过了；不要把“没有这句话”当成任何安全或放行保证。
