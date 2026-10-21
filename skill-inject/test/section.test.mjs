// adg-skill-inject 的单元测试：只测 lib/section.mjs 的纯函数（零依赖、不碰 cordis）。
// index.mjs 的接线部分（ctx.on / agentCtx.systemPrompt.section 的调用形状）按
// permission/testing-guide.md 的口径属于运行期行为，由真实挂载验证（根 README 的「真实挂载验证」）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_SKILL_PATH,
  FALLBACK_TEXT,
  SECTION_NAME,
  SECTION_ORDER,
  TARGET_PRESET,
  resolveSectionText,
  shouldInjectFor,
  sectionTextFor,
  stripFrontmatter,
} from '../lib/section.mjs';

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

test('sectionTextFor：真文件 → 正文带导语、不降级', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-skill-inject-'));
  try {
    const file = join(dir, 'SKILL.md');
    writeFileSync(file, '---\nname: x\n---\n\n# 思维规范框架\n\n先全面思考。\n', 'utf8');
    const { text, degraded } = sectionTextFor(file);
    assert.equal(degraded, false);
    assert.ok(text.startsWith('# 思考框架（thinking-framework）'));
    assert.ok(text.includes('# 思维规范框架'));
    assert.ok(text.includes('先全面思考。'));
    assert.ok(!text.includes('name: x'), 'frontmatter 不该出现在注入正文里');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sectionTextFor：文件缺失 → 降级指令', () => {
  const { text, degraded } = sectionTextFor(join(tmpdir(), 'adg-skill-inject-missing', 'SKILL.md'));
  assert.equal(degraded, true);
  assert.equal(text, FALLBACK_TEXT);
});

test('sectionTextFor：空文件 → 降级指令', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-skill-inject-'));
  try {
    const file = join(dir, 'SKILL.md');
    writeFileSync(file, '---\nname: x\n---\n\n   \n', 'utf8');
    const { text, degraded } = sectionTextFor(file);
    assert.equal(degraded, true);
    assert.equal(text, FALLBACK_TEXT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldInjectFor：Adg 调度者（运行期判定）→ 注入', () => {
  assert.equal(shouldInjectFor({ origin: undefined, agentPreset: 'adg-ptc' }, 'adg-ptc'), true);
});

test('shouldInjectFor：Adg 调度者（只有会话头后备）→ 注入', () => {
  assert.equal(shouldInjectFor({ agentPreset: 'adg-ptc' }, undefined), true);
});

test('shouldInjectFor：子代理 → 不注入（即使 preset 也是 adg-ptc）', () => {
  assert.equal(shouldInjectFor({ origin: 'subagent', agentPreset: 'adg-ptc' }, 'adg-ptc'), false);
});

test('shouldInjectFor：其他 preset（standard 等）→ 不注入', () => {
  assert.equal(shouldInjectFor({ agentPreset: 'standard' }, 'standard'), false);
});

test('shouldInjectFor：两者都拿不到 → 不注入（宁漏勿错）', () => {
  assert.equal(shouldInjectFor({}, undefined), false);
  assert.equal(shouldInjectFor(undefined, undefined), false);
});

test('契约常量：名字与取值符合仓库口径', () => {
  assert.equal(SECTION_NAME, 'adg:thinking-framework');
  assert.equal(SECTION_ORDER, 100);
  assert.equal(TARGET_PRESET, 'adg-ptc');
  assert.ok(DEFAULT_SKILL_PATH.includes('thinking-framework'));
});

// ── 自定义正文（设置页填的文本优先于技能文件）──────────────────────────────────

test('resolveSectionText：填了正文 → 用它，不读文件、不降级', () => {
  const { text, degraded, source } = resolveSectionText({
    customText: '先想清楚再动手。',
    skillPath: join(tmpdir(), 'adg-skill-inject-missing', 'SKILL.md'),
  });
  assert.equal(degraded, false);
  assert.equal(source, 'custom');
  assert.ok(text.startsWith('# 思考框架（自定义注入）'));
  assert.ok(text.includes('先想清楚再动手。'));
});

test('resolveSectionText：留空 / 全空白 → 回落到技能文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-skill-inject-'));
  try {
    const file = join(dir, 'SKILL.md');
    writeFileSync(file, '---\nname: x\n---\n\n# 思维规范框架\n', 'utf8');
    for (const customText of ['', '   ', undefined]) {
      const { text, degraded, source } = resolveSectionText({ customText, skillPath: file });
      assert.equal(degraded, false);
      assert.equal(source, 'skill');
      assert.ok(text.startsWith('# 思考框架（thinking-framework）'));
      assert.ok(text.includes('# 思维规范框架'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSectionText：留空且文件也缺 → 仍走降级指令', () => {
  const { text, degraded, source } = resolveSectionText({
    customText: '',
    skillPath: join(tmpdir(), 'adg-skill-inject-missing-2', 'SKILL.md'),
  });
  assert.equal(degraded, true);
  assert.equal(source, 'skill');
  assert.equal(text, FALLBACK_TEXT);
});
