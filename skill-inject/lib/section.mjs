// adg-skill-inject 的可测内核：section 文本构造 + 注入目标判定。
//
// 这个文件刻意不 import 任何 cordis API —— 只用 node:fs / node:os / node:path 与纯函数，
// `node --test test` 能在零依赖下直接测它；index.mjs 只做"把内核接到 cordis 上"。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 出厂注入技能：与登记表（`settings/lib/schema.mjs` 的 `skillInjectSkill.default`）一致。
 * 值就是该技能在用户技能根下的目录名。
 */
export const DEFAULT_SKILL = 'execution-framework';

/** 技能目录名的合法语法（与 settings/lib/schema.mjs 的 skill 校验同一条正则；防路径穿越的最后一道闸）。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 用户技能根：按 `${DSH_HOME:-~/.dsh}/skills` 拼装（R10：这里不许出现任何本机绝对路径）。 */
export function skillsRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'skills');
}

/**
 * 列出当前技能根下所有可用技能名（含 SKILL.md 的子目录名，升序）。
 *
 * 设置页的下拉「从当前 DSH 能使用的技能列表中选择」靠它列出候选。这里枚举目录、不调
 * `skills` 服务，是因为系统提示词的 section text 必须**同步**求值
 * （dsh-system-prompt/lib/index.js:389 不 await），而注入与下拉必须看到同一份磁盘真相。
 *
 * @param {string} [root] 技能根（测试可传临时目录；缺省按环境变量拼）
 * @returns {string[]} 技能目录名数组（升序，空/不存在时为 []）
 */
export function listSkills(root = skillsRoot()) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

/** 技能目录名 → 它的 SKILL.md 落点（install.ps1 / install.sh 第 1 节把仓库 skills/ 拷到用户技能根）。 */
export function skillPathFor(skill = DEFAULT_SKILL) {
  return join(skillsRoot(), skill, 'SKILL.md');
}

/** 出厂技能那份的落点（等价于 `skillPathFor(DEFAULT_SKILL)`）。 */
export const DEFAULT_SKILL_PATH = skillPathFor(DEFAULT_SKILL);

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

/**
 * 缺文件 / 空文件时注入的降级短指令：正文拿不到，至少保住"先读再干活"的次序。
 * 提示的是**这次实际要找的那份**技能文件（按技能名点名），不写死其中一份。
 * @param {string} skill 技能目录名（缺省 = 出厂技能）
 */
export function fallbackText(skill = DEFAULT_SKILL) {
  return [
    `## ${skill}（正文缺失，降级指令）`,
    '',
    `本会话要注入的技能文件（skills/${skill}/SKILL.md）缺失，路径见下。开工先 \`read\` 它，按它组织你的思考再干活；`,
    '找不到就如实向用户报告缺失，不要假装读过。',
  ].join('\n');
}

/**
 * 从文件构造 section 正文：**原样**返回 SKILL.md 的正文（frontmatter 剥掉），不加任何标题或导语。
 * @param {string} skillPath SKILL.md 绝对路径
 * @param {string} [skill] 技能目录名（只用于降级文案点名哪份文件）
 * @returns {{text: string, degraded: boolean}} 正文与是否降级
 */
export function sectionTextFor(skillPath, skill = DEFAULT_SKILL) {
  if (!existsSync(skillPath)) return { text: fallbackText(skill), degraded: true };
  try {
    const body = stripFrontmatter(readFileSync(skillPath, 'utf8')).trim();
    if (body.length === 0) return { text: fallbackText(skill), degraded: true };
    return { text: body, degraded: false };
  } catch {
    return { text: fallbackText(skill), degraded: true };
  }
}

/**
 * 设置页的自定义正文优先，留空才回落到所选技能文件。
 *
 * 用户填了正文就**原样注入**（不再读文件，也不再剥 frontmatter —— 那份文本不是技能文件）；
 * 留空 / 全空白算「跟随所选技能文件」，与设置页的「留空即默认」口径一致。
 *
 * @param {{customText?: string, skill?: string, skillPath?: string}} [options]
 * @returns {{text: string, degraded: boolean, source: 'custom' | 'skill', skill: string}}
 */
export function resolveSectionText(options = {}) {
  const skill = typeof options.skill === 'string' && options.skill.trim() !== '' ? options.skill : DEFAULT_SKILL;
  if (!SKILL_NAME.test(skill)) {
    return { text: fallbackText(DEFAULT_SKILL), degraded: true, source: 'skill', skill };
  }
  const skillPath = options.skillPath ?? skillPathFor(skill);
  const { customText } = options;
  if (typeof customText === 'string' && customText.trim() !== '') {
    return { text: customText.trim(), degraded: false, source: 'custom', skill };
  }
  return { ...sectionTextFor(skillPath, skill), source: 'skill', skill };
}

/**
 * 这个 agent 是不是子代理：dsh-subagent 给每个子代理的会话头写 `origin: 'subagent'`（durable）。
 *
 * 子代理**是否也注入**由内容层闸门（设置键 `skillInjectSubagent`）决定，判据层不再排除它。
 *
 * @param {{origin?: string, agentPreset?: string} | undefined} header 会话头（durable meta）
 * @returns {boolean} 是否是子代理
 */
export function isSubagentHeader(header) {
  return header?.origin === 'subagent';
}

/**
 * 注入目标判定（纯函数，逐 agent 调用一次）。
 *
 * 只看 **preset 身份**：
 *   - preset 判定：运行期优先 `composedPreset(ctx)`（standing mount，读 scope 链），
 *     会话头 `agentPreset` 字段作后备（两个都由 dsh-subagent / agent-preset-registry 写入）；
 *   - 拿不到时**不注入**：宁可漏，不可把框架塞给非 Adg 会话。
 *   - 子代理排除已按用户要求移到**内容层**闸门（设置键 `skillInjectSubagent`，默认关）。
 *
 * @param {{origin?: string, agentPreset?: string} | undefined} header 会话头（durable meta）
 * @param {string | undefined} composedPresetId 该 agent 的 standing mount preset id
 * @returns {boolean} 是否该给这个 agent 注入
 */
export function shouldInjectFor(header, composedPresetId) {
  const presetId = composedPresetId ?? header?.agentPreset;
  return presetId === TARGET_PRESET;
}
