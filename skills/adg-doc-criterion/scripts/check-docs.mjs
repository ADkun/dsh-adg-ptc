#!/usr/bin/env node
/**
 * check-docs.mjs — adg-doc-criterion 的机检器（零依赖，Node >= 22）
 *
 * 用法：
 *   node check-docs.mjs [根目录]        # 默认当前目录；递归扫描所有 .md
 *
 * 退出码：0 全过 / 1 有 ERROR / 2 运行错误（根目录不可读）
 *
 * 覆盖 SKILL.md 质量红线标 [机检] 的项：
 *   行数预算 / frontmatter 四字段与 status 词表 / 本机绝对路径 / 引用内行号 /
 *   跨仓库文件系统相对路径逃出仓库 / 相对链接死链 / 过程件隔离 / 孤儿文档（启发式）
 * 不覆盖（留 [评] / [人]）：是否写成施工流程、理由是否充分、冷启动三问答不答得准等。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const BT = String.fromCharCode(96);
const root = resolve(process.argv[2] || process.cwd());
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error('[FATAL] 根目录不可读: ' + root);
  process.exit(2);
}

const SKIP_DIR = new Set(['node_modules', '.git', '.hg', '.svn', 'bundle', 'dist', 'build', '.next', 'coverage', 'docs-work']);
const TEMP_DIR = 'docs-work';
const STATUS_WORDS = new Set(['draft', 'current', 'deprecated']);
const FRONTMATTER_DOCS = new Set(['design.md', 'testing-guide.md', 'roadmap.md']);
const PROCESS_NAMES = new Set(['changelog.md', 'handoff.md', 'pending.md']);

function budgetFor(rel) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  if (name === 'AGENTS.md') return parts.length === 1 ? 200 : 120;
  if (name === 'design.md') return 250;
  if (name === 'testing-guide.md') return 300;
  if (name === 'roadmap.md') return 60;
  if (name === '_index.md') return 80;
  return null;
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

const files = [];
walk(root, files);

let gitRoot = null;
try { gitRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); } catch {}

for (const f of files) {
  const rel = relPosix(f);
  const text = readFileSync(f, 'utf8');
  const nLines = countLines(text);
  const name = basename(f);

  const budget = budgetFor(rel);
  if (budget != null && nLines > budget) add('ERROR', 'BUDGET', rel, null, '行数 ' + nLines + ' 超预算 ' + budget + '（' + name + '）');

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

  plain.forEach((l, i) => {
    if (/(^|[^\/])([A-Za-z]:\\|\/Users\/|\/home\/)/.test(l)) add('ERROR', 'ABSPATH', rel, i + 1, '出现本机绝对路径（改同仓库相对路径，或跨仓库 URL+ref）');
  });

  // 行号引用：既查反引号段/链接目标，也查正文里的「文件.ext:行号」形态（先剥掉 URL，避免 http://host:port 误伤）
  plain.forEach((l, i) => {
    const noUrl = l.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g, ' ');
    for (const t of tokensOf(l)) {
      if (!/:\/\//.test(t) && (/[A-Za-z0-9_\-\/\\]+\.(?:[A-Za-z][A-Za-z0-9]{0,7}):\d+/.test(t) || /#L\d+/.test(t) || /第\s*\d+\s*行/.test(t) || /\bline\s+\d+/i.test(t))) {
        add('ERROR', 'LINENO', rel, i + 1, '引用中含行号（改用「文件 + 符号/小节名」等内容锚）: ' + t);
      }
    }
    const extRe = /[A-Za-z0-9_\-\/\\]+\.(?:md|markdown|ts|tsx|mts|cts|js|mjs|cjs|jsx|py|go|java|kt|kts|rb|rs|c|cc|cpp|h|hpp|cs|php|swift|json|yaml|yml|toml|ini|cfg|sh|bash|zsh|ps1|bat|css|scss|less|html|vue|svelte|sql|txt|xml|proto):\d+/gi;
    let mm;
    while ((mm = extRe.exec(noUrl))) add('ERROR', 'LINENO', rel, i + 1, '引用中含行号（改用「文件 + 符号/小节名」等内容锚）: ' + mm[0]);
  });

  plain.forEach((l, i) => {
    for (const t of tokensOf(l)) {
      if (!/^\.\.?[\\\/]/.test(t)) continue;
      if (!gitRoot) continue;
      const resolved = resolve(dirname(f), t);
      if (relative(gitRoot, resolved).startsWith('..')) add('ERROR', 'CROSSREPO', rel, i + 1, '相对路径逃出仓库根（跨仓库禁用 ../）: ' + t);
    }
  });

  // 链接目标存在性（相对链接/图片）：不存在即 ERROR（死链比没链接更糟）；先剥掉行内代码，避免把示例语法当链接
  plain.forEach((l, i) => {
    const noCode = l.replace(new RegExp(BT + '[^' + BT + ']*' + BT, 'g'), ' ');
    for (const lm of noCode.matchAll(/\]\(([^)\s]+)\)/g)) {
      const raw = lm[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#') || raw.startsWith('//')) continue;
      const clean = raw.split('#')[0].split('?')[0];
      if (!clean) continue;
      const abs = resolve(dirname(f), decodeURI(clean));
      if (!existsSync(abs)) add('ERROR', 'LINK', rel, i + 1, '相对链接目标不存在（死链）: ' + raw);
    }
  });
}

const allFiles = [];
(function walkAll(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name === '.git') continue; walkAll(join(dir, e.name)); }
    else allFiles.push(join(dir, e.name));
  }
})(root);
const procFiles = allFiles.filter((f) => { const rel = relPosix(f); return PROCESS_NAMES.has(basename(f)) || rel.startsWith(TEMP_DIR + '/'); });
let gitOk = true;
try { execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }); } catch { gitOk = false; }
for (const f of procFiles) {
  const rel = relPosix(f);
  if (gitOk) {
    let ignored = false;
    try { execFileSync('git', ['-C', root, 'check-ignore', '-q', f]); ignored = true; } catch {}
    if (!ignored) add('ERROR', 'PROCESS', rel, null, '过程件未被 .gitignore 排除（移入 ' + TEMP_DIR + '/ 并忽略）');
    try { execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', f], { stdio: 'ignore' }); add('ERROR', 'PROCESS', rel, null, '过程件已被 git 跟踪'); } catch {}
  } else {
    add('WARN', 'PROCESS', rel, null, '非 git 仓库，无法验证过程件是否被忽略');
  }
}

const rootAgents = join(root, 'AGENTS.md');
const finalNames = new Set(['AGENTS.md', 'design.md', 'testing-guide.md', 'roadmap.md', '_index.md']);
if (existsSync(rootAgents)) {
  const ra = readFileSync(rootAgents, 'utf8');
  for (const f of files) {
    const name = basename(f);
    if (!finalNames.has(name)) continue;
    const rel = relPosix(f);
    if (rel === 'AGENTS.md') continue;
    const dir = rel.split('/').slice(0, -1).join('/');
    const covered = ra.includes(rel) || (dir && ra.includes(dir));
    if (!covered) add('WARN', 'ORPHAN', rel, null, '根 AGENTS.md 未指到（相对路径或所在目录都没出现）');
  }
} else {
  add('WARN', 'ROOT', 'AGENTS.md', null, '根目录缺 AGENTS.md（每个治理域必须有根入口）');
}

const seen = new Set();
const uniq = issues.filter((it) => { const k = it.level + '|' + it.code + '|' + it.file + '|' + (it.line || '') + '|' + it.msg; if (seen.has(k)) return false; seen.add(k); return true; });
uniq.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line || 0) - (b.line || 0)));
if (!uniq.length) { console.log('[PASS] 扫描 ' + files.length + ' 份 .md，无问题。'); process.exit(0); }
for (const it of uniq) console.log('[' + it.level + '] ' + it.code + ' ' + (it.line ? it.file + ':' + it.line : it.file) + ' — ' + it.msg);
const errs = uniq.filter((i) => i.level === 'ERROR').length;
console.log('\n汇总：' + files.length + ' 份 .md，ERROR ' + errs + '，WARN ' + (uniq.length - errs));
process.exit(errs > 0 ? 1 : 0);