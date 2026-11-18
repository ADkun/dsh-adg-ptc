// 设置页「注入哪个技能」下拉的技能来源：枚举 ${DSH_HOME:-~/.dsh}/skills 下含 SKILL.md 的子目录。
//
// 为什么枚举目录而不是调 `skills` 服务：adg-skill-inject 的 section text 必须同步求值
// （dsh-system-prompt/lib/index.js:389 不 await），而设置页的下拉与注入必须看到同一份磁盘真相。
// 与 skill-inject/lib/section.mjs 的 `skillsRoot()` / `listSkills()` 同口径（testing-guide.md
// 有一条漂移检查：两处对同一个临时技能根列出的名字必须一致）。

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 用户技能根：`${DSH_HOME:-~/.dsh}/skills`（R10：不写死本机绝对路径）。 */
export function skillsRoot() {
  const base = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(base, 'skills');
}

/**
 * 列出技能根下所有可用技能名（含 SKILL.md 的子目录名，升序）。
 * @param {string} [root] 技能根（测试可传临时目录）
 * @returns {string[]}
 */
export function listSkillNames(root = skillsRoot()) {
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
