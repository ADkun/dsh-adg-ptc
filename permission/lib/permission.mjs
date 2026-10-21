// adg-permission 的纯逻辑层：权限三级序、单调守卫、事件信封。
//
// 这里不碰 cordis、不碰文件系统、不碰会话对象 —— 全是可离线单测的纯函数
// （见 test/permission.test.mjs 与 design.md 的 D1..D5）。
// 插件的服务面在 ../index.mjs。

/**
 * dsh 的三种文件权限模式，**从窄到宽**。清单只此一份，别在别处再拼一遍。
 *
 * 与 `@deepseek-ai/dsh-sandbox-policy` 的 `SANDBOX_MODES` 同序同值；
 * 本文件不 import 它，是为了让纯逻辑层零依赖、能离线跑。
 */
export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);

const RANK = new Map(SANDBOX_MODES.map((mode, index) => [mode, index]));

/**
 * 是不是一个已知的权限模式。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSandboxMode(value) {
  return typeof value === 'string' && RANK.has(value);
}

/**
 * 模式的宽窄序（read-only < workspace-write < danger-full-access）。
 * **未知模式一律返回 undefined**：宁可当场报错，也不许把它当成"最窄"放过去。
 * @param {unknown} value
 * @returns {number|undefined}
 */
export function modeRank(value) {
  return isSandboxMode(value) ? RANK.get(value) : undefined;
}

/**
 * 单调守卫：调用方**不得把自己的权限放大**给子代理。
 *
 * 这是本工具比"提示级闸门"强的那一条 —— 它由代码拦，不靠调度者自觉：
 * 调用方自己只有 read-only 时，连 workspace-write 都改不上去。
 * 失败即抛（`dsh-tools` 会把 message 原样交给调用它的模型）。
 *
 * @param {unknown} callerMode 调用方**当前**的文件权限模式
 * @param {unknown} targetMode 想给子代理设的模式
 * @returns {number} 通过时返回目标模式的宽窄序
 */
export function assertNotWidening(callerMode, targetMode) {
  const callerRank = modeRank(callerMode);
  if (callerRank === undefined) {
    throw new Error(
      `set_child_permission: 读不出调用方自己的文件权限（got ${String(callerMode)}）—— 拒绝改权限`,
    );
  }
  const targetRank = modeRank(targetMode);
  if (targetRank === undefined) {
    throw new Error(
      `set_child_permission: 未知权限模式 ${JSON.stringify(targetMode)}（可选 ${SANDBOX_MODES.join(' / ')}）`,
    );
  }
  if (targetRank > callerRank) {
    throw new Error(
      `set_child_permission: 拒绝放大权限 —— 调用方自己是 "${callerMode}"，给不了子代理 "${targetMode}"`,
    );
  }
  return targetRank;
}

/**
 * 一个 `sandbox/mode` 事件的信封，与 `dsh-session` 的 `Session.append()` 现场造出来的同形
 * （`{ type, seq, time, data }`）。写这条事件就是"改权限"的全部动作：策略在**每一次受限调用**
 * 时按会话日志重解析，所以后写的事件天然覆盖委派那一刻写下的那条。
 *
 * **故意不写 `source`**：v0→v1 迁移里 `sandbox/mode` 的 `source` 只接受 `"delegation"` 一个字面量
 * （`@deepseek-ai/dsh-session-format-v0-to-v1`）；"父级改的"不是委派，写别的字符串会让旧格式日志
 * 过不了迁移校验，所以省略 —— 与 `@deepseek-ai/dsh-sandbox-policy` 的 `setSandboxMode()` 一致。
 *
 * @param {string} mode 目标模式
 * @param {number} seq 这条事件在目标会话日志里的序号（= 现有事件条数）
 * @param {number} time 毫秒时间戳
 * @returns {{type: string, seq: number, time: number, data: {mode: string}}}
 */
export function sandboxModeEvent(mode, seq, time) {
  if (!isSandboxMode(mode)) {
    throw new Error(`unusable sandbox mode ${JSON.stringify(mode)}`);
  }
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`unusable seq ${String(seq)}`);
  }
  return { type: 'sandbox/mode', seq, time, data: { mode } };
}