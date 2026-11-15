/**
 * adg-harness-identity 的判定与覆盖常量（纯函数，不 import cordis，可 node --test 直接测）。
 *
 * 目标：把平台在每个 agent 系统提示词最开头固定添加的那一行
 * "You are an AI agent, powered by DeepSeek Harness." 完全去掉。
 *
 * 机制：平台在 global 层注册了 name='harness:identity' 的 section（它的第一段）。
 * 我们在**该 agent 自己的 scope**上注册一个**同名** section、正文为空字符串 ——
 * ScopedLayers.merge 让 scoped 同名项覆盖 global 同名项，renderPrompt 又按
 * text.length>0 过滤掉空段，于是那一行消失、且不留空行。
 *
 * 常量与平台对齐；升级 dsh 后按 design.md 第 5 节重核。
 */

/** 平台固定开场白 section 的名字（必须逐字相同才能覆盖）。 */
export const SECTION_NAME = 'harness:identity';

/** 平台 SECTION_ORDERS.HARNESS_IDENTITY === -1e3；order 只要求有限数（段会被丢弃），此值仅与平台对齐。 */
export const SECTION_ORDER = -1000;

/** 只对 Adg PTC 模式的 agent 生效（调度者与子代理同 preset 身份）。 */
export const TARGET_PRESET = 'adg-ptc';

/** 覆盖用的空正文：renderPrompt 会把它丢弃，从而不产生任何输出、也不留空行。 */
export const SHADOW_TEXT = '';

/**
 * 该 agent 是否要覆盖固定开场白。
 * @param {{agentPreset?: string}} [header] agent.session.header
 * @param {string} [composedPresetId] agentPresets.composedPreset(agent.ctx) 的返回值（优先）
 * @returns {boolean} 仅当 preset 身份确定为 adg-ptc 时为 true（拿不到即 false，fail-closed）
 */
export function shouldInjectFor(header, composedPresetId) {
  const presetId = composedPresetId ?? header?.agentPreset;
  return presetId === TARGET_PRESET;
}

/** 组装要注册到 agent scope 上的覆盖 section。 */
export function shadowSection() {
  return { name: SECTION_NAME, order: SECTION_ORDER, text: SHADOW_TEXT };
}
