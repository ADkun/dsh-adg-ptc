// adg-skill-inject 的可测内核：section 文本构造 + 注入目标判定。
//
// 这个文件刻意不 import 任何 cordis API —— 只用 node:fs 与纯函数，
// `node --test test` 能在零依赖下直接测它；index.mjs 只做"把内核接到 cordis 上"。

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 思考框架技能的默认落点（install.ps1 / install.sh 第 1 节把仓库 skills/ 拷到用户技能根）。 */
export const DEFAULT_SKILL_PATH = join(
  process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh'),
  'skills',
  'thinking-framework',
  'SKILL.md',
);

/** section 名：每个 agent 的 scope 内唯一；重挂载时报重复注册是配置错误，不静默吞掉。 */
export const SECTION_NAME = 'adg:thinking-framework';

/** 本插件服务的 preset 身份（preset/agent.cordis.yml 生成物里的 config.id）。 */
export const TARGET_PRESET = 'adg-ptc';

/** section 的 order：落在调度 persona prefix（0）之后、PLAN_POLICY（500）之前。 */
export const SECTION_ORDER = 100;

/**
 * 剥掉 SKILL.md 头部的 YAML frontmatter，返回纯正文。
 * 技能文件的头两行 --- 是技能目录的登记元数据，不是要给模型看的思考指令。
 * @param {string} raw 文件全文
 */
export function stripFrontmatter(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  return text.slice(text.indexOf('\n', end + 1) + 1).replace(/^\n+/, '');
}

/** 缺文件 / 空文件时注入的降级短指令：框架正文拿不到，至少保住"先读再干活"的次序。 */
export const FALLBACK_TEXT = [
  '## 思考框架（正文缺失，降级指令）',
  '',
  '本会话的思考框架技能文件缺失，路径见下。开工先 `read` 它，按它组织你的思考再干活；',
  '找不到就如实向用户报告缺失，不要假装读过。',
].join('\n');

/** 注入正文的导语：用户自定义正文与技能文件正文共用同一句（标题可换成自定义的）。 */
function compose(customText, body) {
  return `${customText}\n\n以下全文是你在本会话的思考规范，按它组织每一次响应前的思考：\n\n${body}`;
}

/**
 * 从文件构造 section 正文。
 * @param {string} skillPath SKILL.md 绝对路径
 * @returns {{text: string, degraded: boolean}} 正文与是否降级
 */
export function sectionTextFor(skillPath) {
  if (!existsSync(skillPath)) return { text: FALLBACK_TEXT, degraded: true };
  try {
    const body = stripFrontmatter(readFileSync(skillPath, 'utf8')).trim();
    if (body.length === 0) return { text: FALLBACK_TEXT, degraded: true };
    return {
      text: compose('# 思考框架（thinking-framework）', body),
      degraded: false,
    };
  } catch {
    return { text: FALLBACK_TEXT, degraded: true };
  }
}

/**
 * 设置页的自定义正文优先，留空才回落到技能文件。
 *
 * 用户填了正文就**原样注入**（不再读文件，也不再剥 frontmatter —— 那份文本不是技能文件）；
 * 留空 / 全空白算「跟随技能文件」，与设置页的「留空即默认」口径一致。
 *
 * @param {{customText?: string, skillPath?: string}} [options]
 * @returns {{text: string, degraded: boolean, source: 'custom' | 'skill'}}
 */
export function resolveSectionText(options = {}) {
  const { customText, skillPath = DEFAULT_SKILL_PATH } = options;
  if (typeof customText === 'string' && customText.trim() !== '') {
    return {
      text: compose('# 思考框架（自定义注入）', customText.trim()),
      degraded: false,
      source: 'custom',
    };
  }
  return { ...sectionTextFor(skillPath), source: 'skill' };
}

/**
 * 注入目标判定（纯函数，逐 agent 调用一次）。
 *
 * 只给 **Adg 调度者**：
 *   - 子代理排除：dsh-subagent 给每个子代理的会话头写 `origin: 'subagent'`（durable）；
 *   - preset 判定：运行期优先 `composedPreset(ctx)`（standing mount，读 scope 链），
 *     会话头 `agentPreset` 字段作后备（两个都由 dsh-subagent / agent-preset-registry 写入）；
 *   - 两者都拿不到时**不注入**：宁可漏，不可把框架塞给非 Adg 会话。
 *
 * @param {{origin?: string, agentPreset?: string} | undefined} header 会话头（durable meta）
 * @param {string | undefined} composedPresetId 该 agent 的 standing mount preset id
 * @returns {boolean} 是否该给这个 agent 注入
 */
export function shouldInjectFor(header, composedPresetId) {
  if (header?.origin === 'subagent') return false;
  const presetId = composedPresetId ?? header?.agentPreset;
  return presetId === TARGET_PRESET;
}
