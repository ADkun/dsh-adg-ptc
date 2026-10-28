// adg-skill-inject 的可测内核：section 文本构造 + 注入目标判定。
//
// 这个文件刻意不 import 任何 cordis API —— 只用 node:fs 与纯函数，
// `node --test test` 能在零依赖下直接测它；index.mjs 只做"把内核接到 cordis 上"。

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 三份可注入的用户技能：设置键 `skillInjectFramework` 的内部值 → 技能目录名。
 * **唯一事实源** —— 路径拼装、导语标题、降级文案、index.mjs 的取值都从这里派生。
 */
export const FRAMEWORK_SKILLS = Object.freeze({
  elegant: 'elegant-framework',
  thinking: 'thinking-framework',
  execution: 'execution-framework',
});

/** 框架 → 中文名（导语标题与降级文案共用；键集与 `FRAMEWORK_SKILLS` 一致）。 */
const FRAMEWORK_LABELS = Object.freeze({
  elegant: '优雅框架',
  thinking: '思考框架',
  execution: '执行框架',
});

/** 出厂框架：与登记表（`settings/lib/schema.mjs` 的 `skillInjectFramework.default`）一致。 */
export const DEFAULT_FRAMEWORK = 'elegant';

/** 用户技能根：按 `${DSH_HOME:-~/.dsh}` 逐级拼装（R9：这里不许出现任何本机绝对路径）。 */
function skillsRoot() {
  return join(process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh'), 'skills');
}

/** 认不出的框架名一律回落到出厂框架（设置文件的宽容口径与 lib/user-settings.mjs 一致）。 */
export function frameworkOrDefault(value) {
  return Object.prototype.hasOwnProperty.call(FRAMEWORK_SKILLS, value) ? value : DEFAULT_FRAMEWORK;
}

/** 框架 → 技能目录名。 */
export function skillDirFor(framework) {
  return FRAMEWORK_SKILLS[frameworkOrDefault(framework)];
}

/** 框架 → 那份技能的 SKILL.md 落点（install.ps1 / install.sh 第 1 节把仓库 skills/ 拷到用户技能根）。 */
export function skillPathFor(framework = DEFAULT_FRAMEWORK) {
  return join(skillsRoot(), skillDirFor(framework), 'SKILL.md');
}

/** 出厂框架那份技能的落点（等价于 `skillPathFor(DEFAULT_FRAMEWORK)`）。 */
export const DEFAULT_SKILL_PATH = skillPathFor(DEFAULT_FRAMEWORK);

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
 * 缺文件 / 空文件时注入的降级短指令：框架正文拿不到，至少保住"先读再干活"的次序。
 * 提示的是**这次实际要找的那份**技能文件（elegant / thinking / execution 各说各的），不写死其中一份。
 * @param {string} framework 框架内部值（认不出的按出厂框架处理）
 */
export function fallbackText(framework = DEFAULT_FRAMEWORK) {
  const name = skillDirFor(framework);
  const label = FRAMEWORK_LABELS[frameworkOrDefault(framework)];
  return [
    `## ${label}（正文缺失，降级指令）`,
    '',
    `本会话的${label}技能文件（skills/${name}/SKILL.md）缺失，路径见下。开工先 \`read\` 它，按它组织你的思考再干活；`,
    '找不到就如实向用户报告缺失，不要假装读过。',
  ].join('\n');
}

/** 注入正文的导语：用户自定义正文与技能文件正文共用同一句（标题可换成自定义的）。 */
function compose(customText, body) {
  return `${customText}\n\n以下全文是你在本会话的思考规范，按它组织每一次响应前的思考：\n\n${body}`;
}

/** 导语标题：技能文件那支随框架变，自定义正文那支固定。 */
function frameworkTitle(framework) {
  return `# ${FRAMEWORK_LABELS[frameworkOrDefault(framework)]}（${skillDirFor(framework)}）`;
}

/**
 * 从文件构造 section 正文。
 * @param {string} skillPath SKILL.md 绝对路径
 * @param {string} [framework] 框架内部值（决定导语标题与降级文案）
 * @returns {{text: string, degraded: boolean}} 正文与是否降级
 */
export function sectionTextFor(skillPath, framework = DEFAULT_FRAMEWORK) {
  if (!existsSync(skillPath)) return { text: fallbackText(framework), degraded: true };
  try {
    const body = stripFrontmatter(readFileSync(skillPath, 'utf8')).trim();
    if (body.length === 0) return { text: fallbackText(framework), degraded: true };
    return {
      text: compose(frameworkTitle(framework), body),
      degraded: false,
    };
  } catch {
    return { text: fallbackText(framework), degraded: true };
  }
}

/**
 * 设置页的自定义正文优先，留空才回落到技能文件。
 *
 * 用户填了正文就**原样注入**（不再读文件，也不再剥 frontmatter —— 那份文本不是技能文件）；
 * 留空 / 全空白算「跟随技能文件」，与设置页的「留空即默认」口径一致。
 *
 * @param {{customText?: string, framework?: string, skillPath?: string}} [options]
 * @returns {{text: string, degraded: boolean, source: 'custom' | 'skill', framework: string}}
 */
export function resolveSectionText(options = {}) {
  const framework = frameworkOrDefault(options.framework);
  const skillPath = options.skillPath ?? skillPathFor(framework);
  const { customText } = options;
  if (typeof customText === 'string' && customText.trim() !== '') {
    return {
      text: compose('# 思考框架（自定义注入）', customText.trim()),
      degraded: false,
      source: 'custom',
      framework,
    };
  }
  return { ...sectionTextFor(skillPath, framework), source: 'skill', framework };
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
