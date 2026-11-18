#!/usr/bin/env node
/**
 * check-docs.mjs — adg-doc-criterion 机检器（零依赖，Node >= 22）
 *
 * 用法：
 *   node check-docs.mjs [根目录] [--baseline <file>] [--write-baseline] [--strict-refs] [--rule]
 *
 * 退出码：0 全过（含基线豁免） / 1 有 ERROR / 2 运行错误（根目录不可读）
 *
 * 覆盖 SKILL.md 质量红线清单里标 [机检] 项的机械部分：
 *   7  行数预算
 *   8  versioned 知识文档 frontmatter 四字段 + status 封闭词表
 *   9  根 AGENTS.md 存在（无孤儿检查已移除，导航/文件覆盖由 aoci 承担）
 *   10 引用真实性（机械部分）：相对链接/图片目标存在（ERROR）。可选 --strict-refs 额外对反引号文件路径做尽力 WARN
 *   11 过程件隔离（changelog/handoff/pending/工作稿只在 git 化的临时目录里）
 *   12 引用形式：无本机绝对路径 / 跨仓库无 ../ / 行号引用 / 跨仓 URL 缺 ref 或裸 main/HEAD / 链接指向被 .gitignore 排除的内容
 *   15 roadmap 机械合规：四节齐、每条有验收判据、状态词表、行数
 *
 * 不覆盖（留 [评] / [人]）：语义判断（是否施工流程、理由是否充分、冷启动三问、
 *   模块 AGENTS 三信号、命令能否复跑、跨仓 URL 是否可达、roadmap 已实现项是否删除/进度工时）。
 */
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, basename, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const BT = String.fromCharCode(96);
const argv = process.argv.slice(2);
let rootArg = null, baselinePath = null, writeBaseline = false, showRule = false, strictRefs = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--baseline') baselinePath = argv[++i];
  else if (a === '--write-baseline') writeBaseline = true;
  else if (a === '--rule') showRule = true;
  else if (a === '--strict-refs') strictRefs = true;
  else if (a === '-h' || a === '--help') { console.log('用法：node check-docs.mjs [根目录] [--baseline <file>] [--write-baseline] [--strict-refs] [--rule]'); process.exit(0); }
  else rootArg = a;
}
const root = resolve(rootArg || process.cwd());
if (!existsSync(root) || !statSync(root).isDirectory()) { console.error('[FATAL] 根目录不可读: ' + root); process.exit(2); }

const COVERAGE = '机检覆盖：7 行数预算 / 8 frontmatter+status / 9 根AGENTS存在（无孤儿已移交 aoci） / 10 相对链接·图片存在（--strict-refs 额外反引号路径 WARN）/ 11 过程件隔离 / 12 引用形式(绝对路径·跨仓../·行号·跨仓URL裸分支·链接指向gitignore) / 15 roadmap机械合规。不覆盖：[评]/[人] 语义项。';
if (showRule) { console.log(COVERAGE); if (!rootArg) process.exit(0); }

const SKIP_DIR = new Set(['node_modules', '.git', '.hg', '.svn', 'bundle', 'dist', 'build', '.next', 'coverage', 'docs-work']);
const TEMP_DIR = 'docs-work';
const STATUS_WORDS = new Set(['draft', 'current', 'deprecated']);
const FRONTMATTER_DOCS = new Set(['design.md', 'testing-guide.md', 'roadmap.md']);
const PROCESS_NAMES = new Set(['changelog.md', 'handoff.md', 'pending.md']);
const ROADMAP_STATUS = new Set(['approved', 'in-progress', 'needs-decision']);
const DOCREF_SKIP_PREFIX = ['node_modules/', 'bundle/', 'dist/', 'build/', '.next/', 'coverage/', 'docs-work/', '.git/'];
const BARE_BRANCH = new Set(['main', 'master', 'HEAD', 'head']);

function budgetFor(rel) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  if (name === 'AGENTS.md') return parts.length === 1 ? 200 : 120;
  if (name === 'design.md') return 250;
  if (name === 'testing-guide.md') return 300;
  if (name === 'roadmap.md') return 60;
  return null;
}
function stripAociBlock(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const l of lines) {
    if (!inBlock && l.indexOf('aoci:begin') !== -1) { inBlock = true; continue; }
    if (inBlock) { if (l.indexOf('aoci:end') !== -1) inBlock = false; continue; }
    out.push(l);
  }
  return out.join('\n');
}
function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (SKIP_DIR.has(e.name)) continue; walk(join(dir, e.name), out); }
    else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'SKILL.md') out.push(join(dir, e.name));
  }
}
const issues = [];
const add = (level, code, file, line, msg) => issues.push({ level, code, file, line, msg });
const relPosix = (f) => relative(root, f).split(/[\\/]/).join('/');
const countLines = (txt) => { const a = txt.split(/\r?\n/); if (a.length && a[a.length - 1] === '') a.pop(); return a.length; };

function stripFences(text) {
  const lines = text.split(/\r?\n/);
  const fenceRe = new RegExp('^\\s*(' + BT + '{3,}|~{3,})');
  let inFence = false;
  return lines.map((l) => {
    if (fenceRe.test(l)) { inFence = !inFence; return ''; }
    return inFence ? '' : l;
  });
}
function tokensOf(line) {
  const tokens = [];
  const spanRe = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
  let m;
  while ((m = spanRe.exec(line))) tokens.push(m[1]);
  for (const lm of line.matchAll(/\]\(([^)\s]+)/g)) tokens.push(lm[1]);
  return tokens;
}
function backtickSpans(line) {
  const out = [];
  const spanRe = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
  let m;
  while ((m = spanRe.exec(line))) out.push(m[1]);
  return out;
}

const LINENO_GENERIC = /[A-Za-z0-9_\-/\\]+\.(?:[A-Za-z][A-Za-z0-9]{0,7}):\d+(?:-\d+)?/g;
const LINENO_EXT = /[A-Za-z0-9_\-/\\]+\.(?:md|markdown|ts|tsx|mts|cts|js|mjs|cjs|jsx|py|go|java|kt|kts|rb|rs|c|cc|cpp|h|hpp|cs|php|swift|json|yaml|yml|toml|ini|cfg|sh|bash|zsh|ps1|bat|css|scss|less|html|vue|svelte|sql|txt|xml|proto):\d+(?:-\d+)?/gi;
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g;
const HOSTED_BLOB = /(?:github\.com|gitlab\.com|bitbucket\.org)\/[^/\s]+\/[^/\s]+\/(?:blob|tree)\/([^/\s?#]+)/i;

const files = [];
walk(root, files);

let gitRoot = null;
try { gitRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
const IS_GIT = !!gitRoot;
function isIgnored(abs) {
  if (!IS_GIT) return false;
  try { execFileSync('git', ['-C', root, 'check-ignore', '-q', abs], { stdio: 'ignore' }); return true; } catch { return false; }
}

for (const f of files) {
  const rel = relPosix(f);
  const text = readFileSync(f, 'utf8');
  const nLines = countLines(text);
  const name = basename(f);

  const budget = budgetFor(rel);
  const budgetLines = name === 'AGENTS.md' ? countLines(stripAociBlock(text)) : nLines;
  if (budget != null && budgetLines > budget) add('ERROR', 'BUDGET', rel, null, '行数 ' + budgetLines + ' 超预算 ' + budget + '（' + name + '）');

  if (FRONTMATTER_DOCS.has(name)) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) add('ERROR', 'FRONTMATTER', rel, 1, '缺 frontmatter（需 title/owner/status/last_reviewed）');
    else {
      const fm = m[1];
      for (const key of ['title', 'owner', 'status', 'last_reviewed']) {
        if (!new RegExp('^' + key + '\\s*:', 'm').test(fm)) add('ERROR', 'FRONTMATTER', rel, 1, 'frontmatter 缺字段 ' + key);
      }
      const sm = fm.match(/^status\s*:\s*(\S+)/m);
      if (sm && !STATUS_WORDS.has(sm[1])) add('ERROR', 'STATUS', rel, 1, 'status="' + sm[1] + '" 不在封闭词表 {draft,current,deprecated}');
    }
  }

  const plain = stripFences(text);

  // 本机绝对路径
  plain.forEach((l, i) => {
    const abLine = l.replace(/\\\//g, '/')
      .replace(/[A-Za-z]:\\[^\s'"()]*…/g, ' ')
      .replace(/\/(?:Users|home|var|opt|etc|srv|mnt|root)\/[^\s'"()]*…/g, ' ');
    if (/(^|[^\/\w])([A-Za-z]:\\|\/(?:Users|home|var|opt|etc|srv|mnt|root)\/)/.test(abLine)) add('ERROR', 'ABSPATH', rel, i + 1, '出现本机绝对路径（改同仓库相对路径，或跨仓库 URL+ref）');
  });

  // 行号引用：token 扫描 + 行扫描并集去重（同一 ref 不再双报）
  plain.forEach((l, i) => {
    const noUrl = l.replace(URL_RE, ' ');
    const hits = new Set();
    for (const t of tokensOf(l)) {
      if (/:\/\//.test(t)) continue;
      for (const mm of t.matchAll(LINENO_GENERIC)) hits.add(mm[0]);
      for (const mm of t.matchAll(LINENO_EXT)) hits.add(mm[0]);
      if (/#L\d+/.test(t)) hits.add(t);
      if (/第\s*\d+\s*行/.test(t)) hits.add(t);
      if (/\bline\s+\d+/i.test(t)) hits.add(t);
    }
    for (const mm of noUrl.matchAll(LINENO_EXT)) hits.add(mm[0]);
    for (const mm of l.matchAll(/#L\d+/g)) hits.add(mm[0]);
    for (const mm of l.matchAll(/第\s*\d+\s*行/g)) hits.add(mm[0]);
    for (const mm of l.matchAll(/\bline\s+\d+/gi)) hits.add(mm[0]);
    for (const h of hits) add('ERROR', 'LINENO', rel, i + 1, '引用中含行号（改用「文件 + 符号/小节名」等内容锚）: ' + h);
  });

  // 跨仓库文件系统相对路径逃出仓库根
  plain.forEach((l, i) => {
    for (const t of tokensOf(l)) {
      if (!/^\.\.?[\\\/]/.test(t)) continue;
      if (!gitRoot) continue;
      const resolved = resolve(dirname(f), t);
      if (relative(gitRoot, resolved).startsWith('..')) add('ERROR', 'CROSSREPO', rel, i + 1, '相对路径逃出仓库根（跨仓库禁用 ../）: ' + t);
    }
  });

  // 相对链接/图片存在性 + 不指向被 .gitignore 排除的内容
  plain.forEach((l, i) => {
    const noCode = l.replace(new RegExp(BT + '[^' + BT + ']*' + BT, 'g'), ' ');
    for (const lm of noCode.matchAll(/\]\(([^)\s]+)\)/g)) {
      const raw = lm[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#') || raw.startsWith('//')) continue;
      const clean = raw.split('#')[0].split('?')[0];
      if (!clean) continue;
      const abs = resolve(dirname(f), decodeURI(clean));
      if (!existsSync(abs)) add('ERROR', 'LINK', rel, i + 1, '相对链接目标不存在（死链）: ' + raw);
      else if (isIgnored(abs)) add('ERROR', 'LINKGITIGNORE', rel, i + 1, '链接指向被 .gitignore 排除的内容（克隆/网页端会 404）: ' + raw);
    }
  });

  // 跨仓 URL 缺显式 ref / 裸 main·HEAD
  plain.forEach((l, i) => {
    for (const um of l.matchAll(URL_RE)) {
      const url = um[0];
      const bm = url.match(HOSTED_BLOB);
      if (bm && BARE_BRANCH.has(bm[1])) add('ERROR', 'REF', rel, i + 1, '跨仓 URL 用裸分支 ' + bm[1] + '（改用 tag/sha 显式 ref）: ' + url);
    }
  });

  // 反引号里的同仓库文件路径存在性（--strict-refs 选做：外部包路径/模板/计算生成路径无法机械判定，尽力提示、可能误报，默认关）
  if (strictRefs) plain.forEach((l, i) => {
    for (const t of backtickSpans(l)) {
      if (!t || /\s/.test(t)) continue;
      if (!/^[A-Za-z0-9_./-]+$/.test(t)) continue;
      if (t.includes('\\')) continue;
      if (t.startsWith('.') || t.startsWith('/')) continue;
      if (!t.includes('/')) continue;
      if (DOCREF_SKIP_PREFIX.some((p) => t.startsWith(p))) continue;
      const last = t.split('/').pop();
      if (!last.includes('.')) continue;
      const p1 = resolve(root, t);
      const p2 = resolve(dirname(f), t);
      if (!existsSync(p1) && !existsSync(p2)) add('WARN', 'DOCREF', rel, i + 1, '（--strict-refs 尽力提示，含外部包路径可能误报）反引号路径不在仓库内: ' + t);
    }
  });

  // roadmap 机械合规
  if (name === 'roadmap.md') {
    const needs = ['在办', '已定待做', '待决策', '明确不做'];
    const missing = needs.filter((s) => !text.includes(s));
    if (missing.length) add('ERROR', 'ROADMAP', rel, null, 'roadmap 缺必备小节: ' + missing.join('、'));
    const ls = text.split(/\r?\n/);
    let inReject = false;
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i];
      if (/明确不做/.test(l)) inReject = true;
      if (/^\s*\|/.test(l) === false) continue;
      const cells = l.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length < 4) continue;
      if (cells.every((c) => /^[-: ]*$/.test(c))) continue;
      if (/目标/.test(cells[0]) || /验收判据/.test(cells[1])) continue;
      if (inReject) continue;
      const judge = cells[1], status = cells[2];
      if (!judge || /^[—\-\s]*$/.test(judge) || judge === '…') add('ERROR', 'ROADMAP', rel, i + 1, 'roadmap 条目缺验收判据: ' + cells[0]);
      if (!ROADMAP_STATUS.has(status)) add('ERROR', 'ROADMAP', rel, i + 1, 'roadmap 状态 "' + status + '" 不在词表 {approved,in-progress,needs-decision}');
    }
  }
}

// 过程件隔离：遍历全部文件（跳 SKIP_DIR），找游离的过程件
const allFiles = [];
(function walkAll(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (SKIP_DIR.has(e.name)) continue; walkAll(join(dir, e.name)); }
    else allFiles.push(join(dir, e.name));
  }
})(root);
const procFiles = allFiles.filter((f) => { const rel = relPosix(f); return PROCESS_NAMES.has(basename(f)) || rel.startsWith(TEMP_DIR + '/'); });
for (const f of procFiles) {
  const rel = relPosix(f);
  if (IS_GIT) {
    let ignored = false;
    try { execFileSync('git', ['-C', root, 'check-ignore', '-q', f], { stdio: 'ignore' }); ignored = true; } catch {}
    if (!ignored) add('ERROR', 'PROCESS', rel, null, '过程件未被 .gitignore 排除（移入 ' + TEMP_DIR + '/ 并忽略）');
    try { execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', f], { stdio: 'ignore' }); add('ERROR', 'PROCESS', rel, null, '过程件已被 git 跟踪'); } catch {}
  } else {
    add('WARN', 'PROCESS', rel, null, '非 git 仓库，无法验证过程件是否被忽略');
  }
}

// 根 AGENTS.md 存在性（无孤儿检查已移除：导航与文件覆盖由 aoci 承担，见 SKILL 红线 9 / 14）
const rootAgents = join(root, 'AGENTS.md');
if (!existsSync(rootAgents)) add('ERROR', 'ROOT', 'AGENTS.md', null, '根目录缺 AGENTS.md（每个治理域必须有根入口）');

// 基线豁免：把存量已知问题（多为历史行号引用）登记为 accepted，不让 CI 因存量失败
const defBaseline = baselinePath ? resolve(baselinePath) : join(root, TEMP_DIR, 'check-docs.baseline.json');
if (writeBaseline) {
  const errs = issues.filter((it) => it.level === 'ERROR');
  const payload = errs.map((it) => ({ code: it.code, file: it.file, msg: it.msg }));
  try { mkdirSync(dirname(defBaseline), { recursive: true }); writeFileSync(defBaseline, JSON.stringify(payload, null, 2) + '\n', 'utf8'); } catch (e) { console.error('[FATAL] 写基线失败: ' + e.message); process.exit(2); }
  console.log('[BASELINE] 已写入 ' + payload.length + ' 条存量问题到 ' + defBaseline);
  process.exit(0);
}
let baselineSet = null;
if (existsSync(defBaseline)) {
  try { baselineSet = new Set(JSON.parse(readFileSync(defBaseline, 'utf8')).map((x) => x.code + '|' + x.file + '|' + x.msg)); } catch {}
}
let suppressed = 0;
for (const it of issues) {
  if (it.level === 'ERROR' && baselineSet && baselineSet.has(it.code + '|' + it.file + '|' + it.msg)) { it.level = 'WARN'; it.msg += '（存量基线豁免）'; suppressed++; }
}

const seen = new Set();
const uniq = issues.filter((it) => { const k = it.level + '|' + it.code + '|' + it.file + '|' + (it.line || '') + '|' + it.msg; if (seen.has(k)) return false; seen.add(k); return true; });
uniq.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line || 0) - (b.line || 0)));
if (!uniq.length) { console.log('[PASS] 扫描 ' + files.length + ' 份 .md，无问题。'); process.exit(0); }
for (const it of uniq) console.log('[' + it.level + '] ' + it.code + ' ' + (it.line ? it.file + ':' + it.line : it.file) + ' — ' + it.msg);
const errs = uniq.filter((i) => i.level === 'ERROR').length;
console.log('\n汇总：' + files.length + ' 份 .md，ERROR ' + errs + '，WARN ' + (uniq.length - errs) + (suppressed ? '（基线豁免 ' + suppressed + '）' : ''));
process.exit(errs > 0 ? 1 : 0);
