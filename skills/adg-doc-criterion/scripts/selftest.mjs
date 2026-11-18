#!/usr/bin/env node
/**
 * selftest.mjs — check-docs.mjs 的回归夹具（零依赖，Node >= 22）
 * 用法：node selftest.mjs   退出码：0 全过 / 1 有用例失败
 * 每个用例在系统临时目录造一个 fixture，跑 check-docs.mjs，断言命中/未命中特定 code。
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const BT = String.fromCharCode(96);
const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, 'check-docs.mjs');
const base = join(tmpdir(), 'check-docs-selftest-' + Date.now().toString(36));
mkdirSync(base, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };
function mk(name, files, git) {
  const dir = join(base, name);
  for (const rel of Object.keys(files)) {
    const fp = join(dir, rel); mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, files[rel], 'utf8');
  }
  if (git) spawnSync('git', ['init', '-q', dir]);
  return dir;
}
function run(root, extra) {
  const a = [CHECKER, root].concat(extra || []);
  const r = spawnSync(process.execPath, a, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const count = (out, sub) => out.split(sub).length - 1;

const FM = ['---', 'title: x', 'owner: t', 'status: current', 'last_reviewed: 2025-01-01', '---', ''].join('\n');
function goodFiles(tail) {
  const A = ['# Demo 治理域', '', '一句话：演示用最小治理域（导航由 aoci 覆盖，本文件不列文件清单）。', ''].join('\n');
  const design = FM + ['# queue 设计', '', '## 职责与边界', '负责：队列。', '', '## 核心数据模型', '### Task（不可变值对象）', '- 不变量：', '  - I1: id 唯一。', '', '## 对外接口', 'enqueue()。', '', tail || '## 测试见 [testing-guide.md](testing-guide.md)。', ''].join('\n');
  const tg = FM + ['# queue 测试', '', '## 用例总表', '| 用例ID | 断言 |', '|---|---|', '| T1 | 不变量 I1 |', ''].join('\n');
  const rm = FM + ['# roadmap', '', '## 在办', '| 目标 | 验收判据 | 状态 | 关联 |', '|---|---|---|---|', '| A | 有边界用例 | in-progress | queue/design.md |', '', '## 已定待做', '| 目标 | 验收判据 | 状态 | 关联 |', '|---|---|---|---|', '| B | 有单测 | approved | queue/design.md |', '', '## 待决策', '| 目标 | 验收判据 | 状态 | 关联 |', '|---|---|---|---|', '| C | 先定阈值 | needs-decision | queue/design.md |', '', '## 明确不做', '| 目标 | 理由 |', '|---|---|', '| D | 超出职责 |', ''].join('\n');
  return { 'AGENTS.md': A, 'queue/design.md': design, 'queue/testing-guide.md': tg, 'roadmap.md': rm };
}

console.log('check-docs.mjs 自测：');
{ const d = mk('good', goodFiles(), false); const r = run(d); ok(r.code === 0, '合格治理域 exit 0（' + r.code + '）'); }
{ const f = goodFiles(); const d = mk('noroot', { 'queue/design.md': f['queue/design.md'] }, false); const r = run(d); ok(r.code === 1 && r.out.includes('ROOT'), '缺根 AGENTS → ROOT ERROR'); }
{ const many = Array.from({ length: 206 }, (_, i) => 'line ' + i).join('\n'); const d = mk('budget', { 'AGENTS.md': many }, false); const r = run(d); ok(r.out.includes('BUDGET'), '超预算 → BUDGET'); }
{ const body = Array.from({ length: 150 }, (_, i) => 'body ' + i).join('\n'); const aociBlk = ['<!-- aoci:begin -->'].concat(Array.from({ length: 100 }, (_, i) => 'aoci ' + i)).concat(['<!-- aoci:end -->']).join('\n'); const d = mk('aoci-budget', { 'AGENTS.md': body + '\n' + aociBlk }, false); const r = run(d); ok(r.code === 0 && !r.out.includes('BUDGET'), 'aoci 托管块不计入 budget（250+ 行仍 exit 0）'); }
{ const f = goodFiles(); f['queue/design.md'] = '---\ntitle: x\nowner: t\nstatus: wip\nlast_reviewed: 2025-01-01\n---\n# x\n'; const d = mk('status', f, false); const r = run(d); ok(r.out.includes('STATUS'), 'status 非法 → STATUS'); }
{ const f = goodFiles(); f['queue/design.md'] = goodFiles()['queue/design.md'] + '\n备份在 C:\\Users\\alice\\a.md\n'; const d = mk('abs', f, false); const r = run(d); ok(r.out.includes('ABSPATH'), '本机绝对路径 → ABSPATH'); }
{ const f = goodFiles('定位见 ' + BT + 'lib/index.js:230-234' + BT + ' 。'); const d = mk('lineno', f, false); const r = run(d); ok(count(r.out, 'LINENO') === 1 && r.out.includes('lib/index.js:230-234'), 'range 行号只报 1 条·去重（实际 ' + count(r.out, 'LINENO') + '）'); }
{ const f = goodFiles(); f['queue/design.md'] = goodFiles()['queue/design.md'] + '\n见 [x](nope.md) 。\n'; const d = mk('deadlink', f, false); const r = run(d); ok(r.out.includes('LINK'), '死链 → LINK'); }
{ const f = goodFiles(); f['queue/design.md'] = goodFiles()['queue/design.md'] + '\n见 ' + BT + '../../outside/x.md' + BT + ' 。\n'; const d = mk('crossrepo', f, true); const r = run(d); ok(r.out.includes('CROSSREPO'), '跨仓 ../ → CROSSREPO'); }
{ const f = goodFiles(); f['queue/design.md'] = goodFiles()['queue/design.md'] + '\n见 https://github.com/acme/repo/blob/main/x.md 。\n'; const d = mk('url', f, false); const r = run(d); ok(r.out.includes('REF'), 'URL 裸 main → REF'); }
{ const f = goodFiles(); f['roadmap.md'] = '---\ntitle: x\nowner: t\nstatus: current\nlast_reviewed: 2025-01-01\n---\n# r\n## 在办\n| 目标 | 验收判据 | 状态 | 关联 |\n|---|---|---|---|\n| A |  | doing | q |\n## 已定待做\n## 待决策\n## 明确不做\n'; const d = mk('rmbad', f, false); const r = run(d); ok(r.out.includes('ROADMAP'), 'roadmap 坏状态/空判据 → ROADMAP'); }
{ const f = goodFiles('定位见 ' + BT + 'lib/index.js:230-234' + BT + ' 。'); const d = mk('baseline', f, true); const bl = join(base, 'store', 'bl.json'); const w = run(d, ['--baseline', bl, '--write-baseline']); const r = run(d, ['--baseline', bl]); ok(w.code === 0 && r.code === 0 && r.out.includes('基线豁免'), '基线：写入后复跑 exit 0（' + r.code + '）'); }
{ const f = goodFiles('见 ' + BT + 'no/such/file.md' + BT + ' 。'); const d = mk('docref', f, false); const d1 = run(d); const d2 = run(d, ['--strict-refs']); ok(d1.code === 0 && !d1.out.includes('DOCREF') && d2.out.includes('DOCREF') && d2.code === 0, 'DOCREF 默认关、--strict-refs 才 WARN'); }
{ const r = run(join(HERE, '..', 'examples', 'perfect')); ok(r.code === 0, 'examples/perfect 满分样张 exit 0'); }

{ const f = goodFiles(); f['queue/design.md'] = f['queue/design.md'] + '\n' + ['备份 /var/lib/x.md','备份 /opt/a.md','备份 /etc/b.md','备份 /srv/c.md','备份 /mnt/d.md','备份 /root/e.md','备份 /Users/z/f.md','备份 /home/u/g.md'].join('\n') + '\n'; const d = mk('abs-unix', f, false); const r = run(d); ok(r.code === 1 && count(r.out, 'ABSPATH') >= 8, 'N2 unix 各根绝对路径 → ABSPATH（实际 ' + count(r.out, 'ABSPATH') + '）'); }
{ const f = goodFiles(); f['queue/design.md'] = f['queue/design.md'] + '\n见 https://x/y.js#L30\n正文见第 12 行\nsee line 42\n'; const d = mk('lineno-variants', f, false); const r = run(d); ok(r.code === 1 && count(r.out, 'LINENO') >= 3, 'N3 URL#L / 第N行 / line N → LINENO（实际 ' + count(r.out, 'LINENO') + '）'); }
{ const f = goodFiles(); f['queue/design.md'] = f['queue/design.md'] + '\n端口 http://localhost:8080 时间 12:30 版本 v1.2.3\n'; const d = mk('lineno-fp', f, false); const r = run(d); ok(r.code === 0 && !r.out.includes('LINENO'), 'N3 端口/时间/版本不误报 LINENO（exit ' + r.code + '）'); }
{ const d = mk('non-git-clean', goodFiles(), false); const r = run(d); ok(!/fatal:/.test(r.out), 'N5 非 git 根无 fatal 噪声'); }
console.log('\n自测结果：PASS ' + pass + ' / FAIL ' + fail);
rmSync(base, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
