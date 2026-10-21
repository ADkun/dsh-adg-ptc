// adg-source-guard 的可测内核：run_code 工具结果的成败分流策略。
//
// 这个文件刻意不 import 任何 cordis API —— 只用纯函数，`node --test test`
// 能在零依赖下直接测它；index.mjs 只做"把内核接到 tools/post-execute 上"。
//
// 策略只有一句话：**顶层 run_code 成功 → 结果里只补"意图"；失败 → 一个字都
// 不改**。判据与平台契约见 design.md。
//
// 为什么默认没有解释性前缀：源码不进结果是平台默认行为（run_code 的 render
// 只拼 logs + 返回值），每次成功都解释一遍"源码没有重复"只是噪音。真正只有
// 本插件能提供的信息是当次的执行意图（平台不渲染 `description`），所以默认
// 只补它；`SUCCESS_PREFIX` 留作要显式宣告时的开关。

/** 本插件唯一管辖的工具名（平台保留名，PTC 模式的呈现传输层）。 */
export const TOOL_NAME = 'run_code';

/**
 * 成功路径的结果前缀：默认空串 —— 只补意图，不解释"为什么没有源码"。
 * 想改成显式宣告（例如 'run_code 成功：源码未随本结果重复。'）就设成非空串，
 * 失败路径不受影响。
 */
export const SUCCESS_PREFIX = '';

/** 失败路径的前缀：本插件**不**加（失败路径原样返回），这个常量只是文档锚点。 */
export const FAILURE_PREFIX = '';

/**
 * 是否是本插件的管辖对象：顶层（非 PTC 子分发）的 run_code。
 *
 * `exec.parent` 非空表示这是一次由 run_code 程序内部发起的子分发（平台在
 * dsh-tools/lib/index.js 的子分发绑定里给它挂 `parent: exec.token`）。
 * run_code 本身永远不可能是子分发（程序里拿不到 run_code），这道判定是
 * 防御性的：将来平台若放开，本插件也不该去改程序内部的结果。
 *
 * @param {{name?: unknown, parent?: unknown}} exec
 * @returns {boolean}
 */
export function governs(exec) {
  if (exec === null || typeof exec !== 'object') return false;
  if (exec.name !== TOOL_NAME) return false;
  return exec.parent === void 0 || exec.parent === null;
}

/**
 * 从 run_code 的入参里取出"执行意图"（平台必填的 `description`）。
 * 读不出来就返回空串 —— 意图缺失不是错误，只是结果里不多那一行。
 *
 * @param {{arguments?: unknown}} exec
 * @returns {string}
 */
export function intentOf(exec) {
  const args = exec?.arguments;
  if (args === null || typeof args !== 'object') return '';
  const description = args.description;
  return typeof description === 'string' ? description.trim() : '';
}

/**
 * 构造成功路径要加到结果正文前面的块。
 *
 * `SUCCESS_PREFIX` 为空（默认）时只出「意图：」一行；前缀与意图都空时返回
 * 空数组 —— 那次调用的结果正文与平台默认逐字相同（不硬塞一个空块）。
 * @param {string} intent 当次执行的意图（可为空串）
 * @returns {{type: 'text', text: string}[]}
 */
export function successPrefixBlocks(intent) {
  const lines = [];
  if (SUCCESS_PREFIX.length > 0) lines.push(SUCCESS_PREFIX);
  if (intent.length > 0) lines.push(`意图：${intent}`);
  return lines.length > 0 ? [{ type: 'text', text: lines.join('\n') }] : [];
}

/**
 * 把策略应用到一次已归一化的 dispatch 结果上。
 *
 * 五条硬规则（违反即返工，理由见 design.md）：
 * 1. 不是顶层 run_code → 原样返回（别的工具、程序内部的子分发都不碰）；
 * 2. `decision.kind !== 'accept'` → 原样返回（block/其它决策不属本插件管辖）；
 * 3. 决策带了 `value` → 原样返回（平台禁止同一次 accept 既替换 value 又替换
 *    content，见 dsh-tools/lib/index.js 的 postExecute）；
 * 4. `result.isError === true` → 原样返回（失败路径的 CodeRunFailedError 全文
 *    与 Captured output 必须完整留在上下文里）；
 * 5. 既无正文可保留、又无意可补 → 原样返回（不让结果比平台默认多一个空数组）。
 *
 * 其余情况（顶层 run_code 成功）：返回带 `content` 的 accept 决策，
 * 内容 = 意图块（可有可无）+ 原有正文。原有正文取 `decision.content`
 * （数组时）否则 `result.content`（数组时）—— 本插件的 `next()` 默认不产
 * content，真正要保留的输出在 `result.content`。
 * `additionalContexts` 等其它字段随 decision 原样透传。
 *
 * @param {{exec: unknown, result: unknown, decision: unknown}} input
 * @returns {unknown} 可以直接 `return` 给 `tools/post-execute` 的决策
 */
export function applyPolicy({ exec, result, decision }) {
  if (decision === null || typeof decision !== 'object') return decision;
  if (!governs(exec)) return decision;
  if (decision.kind !== 'accept') return decision;
  if (Object.hasOwn(decision, 'value')) return decision;
  if (result !== null && typeof result === 'object' && result.isError === true) return decision;
  const base = Array.isArray(decision.content)
    ? decision.content
    : Array.isArray(result?.content) ? result.content : [];
  const prefix = successPrefixBlocks(intentOf(exec));
  if (prefix.length === 0 && base.length === 0) return decision;
  return {
    ...decision,
    kind: 'accept',
    content: [...prefix, ...base],
  };
}
