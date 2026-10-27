// adg-skill-inject 的单元测试：只测 lib/section.mjs 的纯函数（零依赖、不碰 cordis）。
// index.mjs 的接线部分（ctx.on / agentCtx.systemPrompt.section 的调用形状）按
// permission/testing-guide.md 的口径属于运行期行为，由真实挂载验证（根 README 的「真实挂载验证」）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_FRAMEWORK,
  DEFAULT_SKILL_PATH,
  FRAMEWORK_SKILLS,
  SECTION_NAME,
  SECTION_ORDER,
  TARGET_PRESET,
  fallbackText,
  frameworkOrDefault,
  isSubagentHeader,
  resolveSectionText,
  shouldInjectFor,
  skillDirFor,
  skillPathFor,
  sectionTextFor,
  stripFrontmatter,
} from '../lib/section.mjs';
import { sectionTextNow } from '../index.mjs';
import { STORE_NAME } from '../lib/user-settings.mjs';

/**
 * 跑一段代码，期间把 DSH_PROFILE_DIR 指向临时目录（设置文件的落点），跑完恢复并删目录。
 * 内容层闸门读的是设置文件，所以这一段用真实文件契约验，不 mock。
 */
function withSettingsDir(settings, run) {
  const saved = process.env.DSH_PROFILE_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'adg-skill-inject-gate-'));
  process.env.DSH_PROFILE_DIR = dir;
  try {
    if (settings !== undefined) {
      writeFileSync(join(dir, STORE_NAME), JSON.stringify(settings), 'utf8');
    }
    return run(dir);
  } finally {
    if (saved === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('stripFrontmatter：剥掉头部 frontmatter，保留正文', () => {
  const raw = '---\nname: "thinking-framework"\ndescription: "x"\n---\n\n# 正文标题\n\n正文第一段。\n';
  assert.equal(stripFrontmatter(raw), '# 正文标题\n\n正文第一段。\n');
});

test('stripFrontmatter：没有 frontmatter 的文件原样返回', () => {
  const raw = '# 直接正文\n';
  assert.equal(stripFrontmatter(raw), '# 直接正文\n');
});

test('stripFrontmatter：正文里出现 --- 不影响（只剥第一块）', () => {
  const raw = '---\na: 1\n---\n\n正文\n\n---\n\n再出现分隔线\n';
  const out = stripFrontmatter(raw);
  assert.ok(out.startsWith('正文'));
  assert.ok(out.includes('再出现分隔线'));
});

test('stripFrontmatter：CRLF 归一化', () => {
  const raw = '---\r\na: 1\r\n---\r\n\r\n正文\r\n';
  assert.equal(stripFrontmatter(raw), '正文\r\n'.replace(/\r\n/g, '\n'));
});

const THINKING_BODY = '---\nname: thinking-framework\n---\n\n# 思维规范框架\n\n先全面思考。\n';
const EXECUTION_BODY = '---\nname: execution-framework\n---\n\n### 执行框架 BEGIN ###\n\n00 工作循环\n';

test('sectionTextFor：真文件 → 正文带导语、不降级（导语标题随框架走）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-skill-inject-'));
  try {
    const thinking = join(dir, 'thinking-framework', 'SKILL.md');
    const execution = join(dir, 'execution-framework', 'SKILL.md');
    mkdirSync(join(dir, 'thinking-framework'), { recursive: true });
    mkdirSync(join(dir, 'execution-framework'), { recursive: true });
    writeFileSync(thinking, THINKING_BODY, 'utf8');
    writeFileSync(execution, EXECUTION_BODY, 'utf8');

    const t = sectionTextFor(thinking, 'thinking');
    assert.equal(t.degraded, false);
    assert.ok(t.text.startsWith('# 思考框架（thinking-framework）'));
    assert.ok(t.text.includes('# 思维规范框架'));
    assert.ok(t.text.includes('先全面思考。'));
    assert.ok(!t.text.includes('name: thinking-framework'), 'frontmatter 不该出现在注入正文里');

    const e = sectionTextFor(execution, 'execution');
    assert.equal(e.degraded, false);
    assert.ok(e.text.startsWith('# 执行框架（execution-framework）'));
    assert.ok(e.text.includes('### 执行框架 BEGIN ###'));
    assert.ok(e.text.includes('00 工作循环'));
    assert.ok(!e.text.includes('name: execution-framework'), 'frontmatter 不该出现在注入正文里');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sectionTextFor：框架缺省时按出厂框架（execution）写导语标题', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-skill-inject-'));
  try {
    const file = join(dir, 'SKILL.md');
    writeFileSync(file, EXECUTION_BODY, 'utf8');
    for (const omitted of [undefined, 'nope', 'Thinking']) {
      const { text, degraded } = sectionTextFor(file, omitted);
      assert.equal(degraded, false);
      assert.ok(text.startsWith('# 执行框架（execution-framework）'), String(omitted));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sectionTextFor：文件缺失 → 降级指令（提示实际要找的那份框架文件）', () => {
  const missing = join(tmpdir(), 'adg-skill-inject-missing', 'SKILL.md');
  assert.equal(sectionTextFor(missing).text, fallbackText('execution'), '缺省 = 出厂框架');
  assert.equal(sectionTextFor(missing, 'execution').text, fallbackText('execution'));
  assert.equal(sectionTextFor(missing, 'thinking').text, fallbackText('thinking'));
  assert.equal(sectionTextFor(missing).degraded, true);
});

test('sectionTextFor：空文件 → 降级指令', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-skill-inject-'));
  try {
    const file = join(dir, 'SKILL.md');
    writeFileSync(file, '---\nname: x\n---\n\n   \n', 'utf8');
    for (const framework of ['thinking', 'execution']) {
      const { text, degraded } = sectionTextFor(file, framework);
      assert.equal(degraded, true);
      assert.equal(text, fallbackText(framework));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fallbackText：降级文案提示的是这次实际要找的那份框架，不写死 thinking', () => {
  const thinking = fallbackText('thinking');
  assert.ok(thinking.startsWith('## 思考框架（正文缺失，降级指令）'));
  assert.ok(thinking.includes('skills/thinking-framework/SKILL.md'));

  const execution = fallbackText('execution');
  assert.ok(execution.startsWith('## 执行框架（正文缺失，降级指令）'));
  assert.ok(execution.includes('skills/execution-framework/SKILL.md'));

  assert.equal(fallbackText('nope'), execution, '认不出的框架按出厂框架');
  assert.equal(fallbackText(), execution, '不给参数按出厂框架');
});

test('shouldInjectFor：Adg 调度者（运行期判定）→ 注入', () => {
  assert.equal(shouldInjectFor({ origin: undefined, agentPreset: 'adg-ptc' }, 'adg-ptc'), true);
});

test('shouldInjectFor：Adg 调度者（只有会话头后备）→ 注入', () => {
  assert.equal(shouldInjectFor({ agentPreset: 'adg-ptc' }, undefined), true);
});

test('shouldInjectFor：子代理 → 判据层不再排除它（子代理闸门已移到内容层）', () => {
  assert.equal(shouldInjectFor({ origin: 'subagent', agentPreset: 'adg-ptc' }, 'adg-ptc'), true);
});

test('shouldInjectFor：其他 preset（standard 等）→ 不注入', () => {
  assert.equal(shouldInjectFor({ agentPreset: 'standard' }, 'standard'), false);
});

test('shouldInjectFor：两者都拿不到 → 不注入（宁漏勿错）', () => {
  assert.equal(shouldInjectFor({}, undefined), false);
  assert.equal(shouldInjectFor(undefined, undefined), false);
});

test('isSubagentHeader：origin 是 subagent 才是子代理（别的 origin / 缺 origin 都不是）', () => {
  assert.equal(isSubagentHeader({ origin: 'subagent' }), true);
  assert.equal(isSubagentHeader({ origin: 'subagent', agentPreset: 'adg-ptc' }), true);
  assert.equal(isSubagentHeader({ origin: 'user' }), false);
  assert.equal(isSubagentHeader({ origin: undefined }), false);
  assert.equal(isSubagentHeader({ agentPreset: 'adg-ptc' }), false);
  assert.equal(isSubagentHeader(undefined), false);
});

// ── 内容层闸门（设置键 skillInjectSubagent）────────────────────────────────────

test('内容层闸门：开关关时子代理拿不到正文，调度者照旧拿到', () => {
  withSettingsDir({ skillInjectEnabled: true, skillInjectSubagent: false, skillInjectText: '框架正文' }, () => {
    assert.equal(sectionTextNow({ subagent: true }), '', '开关关 ⇒ 子代理没有正文');
    assert.notEqual(sectionTextNow(), '', '调度者照旧拿到正文');
    assert.ok(sectionTextNow().includes('框架正文'));
  });
});

test('内容层闸门：开关开时子代理拿到同一段正文', () => {
  withSettingsDir({ skillInjectEnabled: true, skillInjectSubagent: true, skillInjectText: '框架正文' }, () => {
    assert.equal(sectionTextNow({ subagent: true }), sectionTextNow(), '子代理与调度者拿同一段正文');
    assert.ok(sectionTextNow({ subagent: true }).includes('框架正文'));
  });
});

test('内容层闸门：设置文件里没有这一项时按「关」处理（子代理拿不到正文）', () => {
  withSettingsDir({ skillInjectEnabled: true, skillInjectText: '框架正文' }, () => {
    assert.equal(sectionTextNow({ subagent: true }), '');
    assert.notEqual(sectionTextNow(), '');
  });
});

test('内容层闸门：总开关关着时，子代理与调度者都没有正文', () => {
  withSettingsDir({ skillInjectEnabled: false, skillInjectSubagent: true, skillInjectText: '框架正文' }, () => {
    assert.equal(sectionTextNow({ subagent: true }), '');
    assert.equal(sectionTextNow(), '');
  });
});

test('契约常量：名字与取值符合仓库口径', () => {
  assert.equal(SECTION_NAME, 'adg:thinking-framework', 'section 唯一名与选哪份框架无关，保持不变');
  assert.equal(SECTION_ORDER, 100);
  assert.equal(TARGET_PRESET, 'adg-ptc');
  assert.equal(DEFAULT_FRAMEWORK, 'execution', '出厂框架 = 执行框架');
});

test('框架 → 技能文件：唯一事实源与路径拼装（不写死本机绝对路径）', () => {
  assert.ok(Object.isFrozen(FRAMEWORK_SKILLS));
  assert.deepEqual({ ...FRAMEWORK_SKILLS }, { thinking: 'thinking-framework', execution: 'execution-framework' });

  assert.equal(skillDirFor('thinking'), 'thinking-framework');
  assert.equal(skillDirFor('execution'), 'execution-framework');
  assert.equal(skillDirFor('nope'), 'execution-framework', '认不出的按出厂框架');
  assert.equal(skillDirFor(undefined), 'execution-framework');
  assert.equal(frameworkOrDefault('thinking'), 'thinking');
  assert.equal(frameworkOrDefault('nope'), 'execution');

  // 路径只由环境变量拼装：DSH_HOME 决定根，不给就落 ~/.dsh。
  const saved = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = join('X:', 'dsh-home');
    assert.equal(skillPathFor('thinking'), join('X:', 'dsh-home', 'skills', 'thinking-framework', 'SKILL.md'));
    assert.equal(skillPathFor('execution'), join('X:', 'dsh-home', 'skills', 'execution-framework', 'SKILL.md'));
    assert.equal(skillPathFor(), skillPathFor('execution'), '缺省 = 出厂框架');
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
  }
  assert.ok(DEFAULT_SKILL_PATH.endsWith(join('skills', 'execution-framework', 'SKILL.md')));
});

// ── 自定义正文（设置页填的文本优先于技能文件）──────────────────────────────────

test('resolveSectionText：填了正文 → 用它，忽略框架选择、不读文件、不降级', () => {
  for (const framework of ['thinking', 'execution', undefined]) {
    const { text, degraded, source } = resolveSectionText({
      customText: '先想清楚再动手。',
      framework,
      skillPath: join(tmpdir(), 'adg-skill-inject-missing', 'SKILL.md'),
    });
    assert.equal(degraded, false);
    assert.equal(source, 'custom');
    assert.ok(text.startsWith('# 思考框架（自定义注入）'), '自定义正文那支的标题固定不变');
    assert.ok(text.includes('先想清楚再动手。'));
  }
});

test('resolveSectionText：留空 / 全空白 → 回落到技能文件（标题随框架变）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-skill-inject-'));
  try {
    const thinking = join(dir, 'thinking-framework', 'SKILL.md');
    const execution = join(dir, 'execution-framework', 'SKILL.md');
    mkdirSync(join(dir, 'thinking-framework'), { recursive: true });
    mkdirSync(join(dir, 'execution-framework'), { recursive: true });
    writeFileSync(thinking, THINKING_BODY, 'utf8');
    writeFileSync(execution, EXECUTION_BODY, 'utf8');
    for (const customText of ['', '   ', undefined]) {
      const t = resolveSectionText({ customText, framework: 'thinking', skillPath: thinking });
      assert.equal(t.degraded, false);
      assert.equal(t.source, 'skill');
      assert.equal(t.framework, 'thinking');
      assert.ok(t.text.startsWith('# 思考框架（thinking-framework）'));
      assert.ok(t.text.includes('# 思维规范框架'));

      const e = resolveSectionText({ customText, framework: 'execution', skillPath: execution });
      assert.equal(e.degraded, false);
      assert.equal(e.source, 'skill');
      assert.equal(e.framework, 'execution');
      assert.ok(e.text.startsWith('# 执行框架（execution-framework）'));
      assert.ok(e.text.includes('### 执行框架 BEGIN ###'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSectionText：留空且文件也缺 → 仍走降级指令', () => {
  const { text, degraded, source, framework } = resolveSectionText({
    customText: '',
    skillPath: join(tmpdir(), 'adg-skill-inject-missing-2', 'SKILL.md'),
  });
  assert.equal(degraded, true);
  assert.equal(source, 'skill');
  assert.equal(framework, 'execution', '不给框架 = 出厂框架');
  assert.equal(text, fallbackText('execution'));
});

// ── 端到端：设置键换一下，注入正文真的换一份技能文件（用仓库自己那两份真文件）─────

test('框架切换：skillInjectFramework 换一下，导语标题与技能文件名都跟着换', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = repoRoot;
  try {
    assert.equal(skillPathFor('thinking'), join(repoRoot, 'skills', 'thinking-framework', 'SKILL.md'));
    assert.equal(skillPathFor('execution'), join(repoRoot, 'skills', 'execution-framework', 'SKILL.md'));

    withSettingsDir({ skillInjectEnabled: true }, (dir) => {
      // 缺项 → 出厂框架：执行框架那份技能文件。
      const fallback = sectionTextNow();
      assert.ok(fallback.startsWith('# 执行框架（execution-framework）'));
      assert.ok(fallback.includes('### 执行框架 BEGIN ###'));

      for (const [framework, title] of [
        ['execution', '# 执行框架（execution-framework）'],
        ['thinking', '# 思考框架（thinking-framework）'],
      ]) {
        writeFileSync(join(dir, STORE_NAME), JSON.stringify({ skillInjectEnabled: true, skillInjectFramework: framework }));
        const text = sectionTextNow();
        assert.ok(text.startsWith(title), framework);
        assert.ok(
          text.includes(skillDirFor(framework)) || readFileSync(skillPathFor(framework), 'utf8').includes('框架'),
        );
      }

      // 非法值 → 回落到执行框架。
      writeFileSync(join(dir, STORE_NAME), JSON.stringify({ skillInjectEnabled: true, skillInjectFramework: 'Thinking' }));
      assert.ok(sectionTextNow().startsWith('# 执行框架（execution-framework）'), '非法值回落到出厂框架');
    });
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
  }
});
