// adg-source-guard 的单元测试：成败分流策略（纯函数，零依赖）。
//
// 跑法：cd source-guard && node --test test
//      DSH 沙箱（workspace-write）里必须加 --test-isolation=none。
//
// 判据与平台契约见 design.md；用例总表见 testing-guide.md。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAILURE_PREFIX,
  SUCCESS_PREFIX,
  TOOL_NAME,
  applyPolicy,
  governs,
  intentOf,
  successPrefixBlocks,
} from '../lib/policy.mjs';
import { name as PLUGIN_NAME } from '../index.mjs';

/** 顶层 run_code 的一次执行上下文（平台 ToolExecution 的最小面）。 */
function topExec(description = '统计仓库里的 js 文件数') {
  return {
    callId: 'call-1',
    name: TOOL_NAME,
    arguments: { code: 'const fs = require("fs"); /* ... */', description },
    parent: undefined,
  };
}

/** 成功结果（平台 ToolExecutionResult 的最小面：isError false + content）。 */
function okResult(content = [{ type: 'text', text: '42' }]) {
  return { isError: false, value: { logs: ['42'] }, content };
}

test('D1 管辖判据：顶层 run_code 命中', () => {
  assert.equal(governs(topExec()), true);
});

test('D2 管辖判据：非 run_code 一律不命中', () => {
  for (const name of ['read', 'write', 'bash', 'run_codeX', 'RUN_CODE', undefined]) {
    assert.equal(governs({ name, arguments: {}, parent: undefined }), false, `name=${String(name)}`);
  }
});

test('D3 管辖判据：PTC 子分发不命中（parent 非空）', () => {
  assert.equal(governs({ name: TOOL_NAME, arguments: {}, parent: 'token' }), false);
  assert.equal(governs({ name: TOOL_NAME, arguments: {}, parent: {} }), false);
});

test('D4 管辖判据：exec 缺形状时不抛错、不命中', () => {
  assert.equal(governs(null), false);
  assert.equal(governs(undefined), false);
  assert.equal(governs('run_code'), false);
  assert.equal(governs(42), false);
});

test('D5 意图读取：取 arguments.description 并 trim；缺失或非字符串返回空串', () => {
  assert.equal(intentOf(topExec('  抓日志  ')), '抓日志');
  assert.equal(intentOf(topExec()), '统计仓库里的 js 文件数');
  assert.equal(intentOf({ arguments: {} }), '');
  assert.equal(intentOf({ arguments: { description: 7 } }), '');
  assert.equal(intentOf({ arguments: null }), '');
  assert.equal(intentOf({}), '');
  assert.equal(intentOf(null), '');
});

test('D6 成功路径：意图块前置 + 原有正文，正文顺序不变', () => {
  const original = [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }];
  const decision = applyPolicy({ exec: topExec('跑一下'), result: okResult(original), decision: { kind: 'accept' } });
  assert.equal(decision.kind, 'accept');
  const texts = decision.content.map((block) => block.text);
  assert.equal(texts.length, 3);
  assert.equal(texts[0], '已执行代码：跑一下\n');
  assert.equal(texts[1], 'line1');
  assert.equal(texts[2], 'line2');
  // 原有 block 是原对象引用，未被复制改写
  assert.equal(decision.content[1], original[0]);
});

test('D7 成功路径：意图块带类型 text', () => {
  const blocks = successPrefixBlocks('意图');
  assert.deepEqual(Object.keys(blocks[0]).sort(), ['text', 'type']);
  assert.equal(blocks[0].type, 'text');
  // 缺省不带尾换行：换行只在"后面还有正文"时才有意义
  assert.equal(blocks[0].text, '已执行代码：意图');
});

test('D8 成功路径：意图缺失且前缀为空时不出任何块，正文与平台默认逐字相同', () => {
  const base = [{ type: 'text', text: '42' }];
  const decision = applyPolicy({ exec: topExec('  '), result: okResult(base), decision: { kind: 'accept' } });
  assert.equal(decision.content.length, 1);
  assert.equal(decision.content[0].text, '42');
  // 原有 block 保持原对象引用
  assert.equal(decision.content[0], base[0]);
});

test('D8b 成功路径：意图缺失时不出现"已执行代码："字样', () => {
  const blocks = successPrefixBlocks('');
  assert.deepEqual(blocks, []);
});

test('D9 成功路径：result 无 content 数组时只出意图块，不抛错', () => {
  const decision = applyPolicy({ exec: topExec(), result: { isError: false }, decision: { kind: 'accept' } });
  assert.equal(decision.content.length, 1);
  assert.equal(decision.content[0].text, '已执行代码：统计仓库里的 js 文件数');
});

test('D10 失败路径：isError true 原样返回，不加任何东西', () => {
  const failure = {
    isError: true,
    error: { message: 'code run failed (exception): boom\nCaptured output:\nat foo (prog.js:1:1)', info: { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' } },
    content: [{ type: 'text', text: 'code run failed (exception): boom' }],
  };
  const decision = applyPolicy({ exec: topExec(), result: failure, decision: { kind: 'accept', content: [{ type: 'text', text: '原文' }] } });
  assert.equal(decision.content.length, 1);
  assert.equal(decision.content[0].text, '原文');
});

test('D11 失败路径：即使上游决策已带 content 也不动它（逐块相等）', () => {
  const original = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
  const decision = applyPolicy({
    exec: topExec(),
    result: { isError: true, content: [] },
    decision: { kind: 'accept', content: original },
  });
  assert.equal(decision.content.length, 2);
  assert.deepEqual(decision.content, original);
});

test('D12 非 accept 决策原样返回（block 不碰）', () => {
  const feedback = [{ type: 'text', text: 'blocked' }];
  const decision = { kind: 'block', feedback };
  const out = applyPolicy({ exec: topExec(), result: okResult(), decision });
  assert.equal(out, decision);
});

test('D13 带 value 的 accept 原样返回（平台禁止 value+content 同取）', () => {
  const decision = { kind: 'accept', value: { logs: [] } };
  const out = applyPolicy({ exec: topExec(), result: okResult(), decision });
  assert.equal(out, decision);
});

test('D14 非管辖 exec 的决策原样返回（含别的工具与子分发）', () => {
  for (const exec of [{ name: 'read', arguments: {}, parent: undefined }, { name: TOOL_NAME, arguments: {}, parent: 'tok' }]) {
    const decision = { kind: 'accept' };
    const out = applyPolicy({ exec, result: okResult(), decision });
    assert.equal(out, decision);
  }
});

test('D15 decision 不是对象时原样返回，不抛错', () => {
  for (const decision of [null, undefined, 'accept', 0]) {
    assert.equal(applyPolicy({ exec: topExec(), result: okResult(), decision }), decision);
  }
});

test('D16 additionalContexts 等字段随决策透传，不被抹掉', () => {
  const contexts = [{ id: 'm1', role: 'user', content: [] }];
  const decision = { kind: 'accept', additionalContexts: contexts, meta: { keep: true } };
  const out = applyPolicy({ exec: topExec(), result: okResult(), decision });
  assert.equal(out.additionalContexts, contexts);
  assert.deepEqual(out.meta, { keep: true });
  assert.equal(Array.isArray(out.content), true);
});

test('D17 决策自带 content 时原样接在后面（不覆盖上游已产出的正文）', () => {
  const upstream = [{ type: 'text', text: 'upstream' }];
  const decision = { kind: 'accept', content: upstream };
  const out = applyPolicy({ exec: topExec('x'), result: okResult([{ type: 'text', text: 'result-side' }]), decision });
  assert.deepEqual(out.content.map((b) => b.text), ['已执行代码：x\n', 'upstream']);
});

test('D18 契约常量形状', () => {
  assert.equal(TOOL_NAME, 'run_code');
  assert.equal(FAILURE_PREFIX, '');
  // 默认前缀为空：成功路径只补意图，不重复解释"源码没有重复"
  assert.equal(SUCCESS_PREFIX, '');
});

test('D19 插件名 ↔ cordis.patch.yml 的 insert 行 id 逐字一致', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const yaml = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8');
  const match = yaml.match(/^\s*- id: (\S+)\s*$/m);
  assert.ok(match, 'cordis.patch.yml 里应有一行 `- id: <插件名>`');
  assert.equal(match[1], PLUGIN_NAME);
  assert.match(yaml, /- insert:/);
});

test('D20 源码里没有写死本机绝对路径', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of ['../index.mjs', '../lib/policy.mjs']) {
    const text = readFileSync(join(here, file), 'utf8');
    // 只认反斜杠形态的「盘符 + Users」与「盘符 + dsh」；D:/ 正斜杠与 UNC 另行人工评。
    assert.doesNotMatch(text, /[A-Za-z]:\\+Users/i, `${file} 出现 X:\\Users 绝对路径`);
    assert.doesNotMatch(text, /[A-Za-z]:\\+dsh/i, `${file} 出现 X:\\dsh 绝对路径`);
  }
});

test('D21 意图块在有正文时自带换行结尾；无正文时不带', () => {
  assert.equal(successPrefixBlocks('x', { followedByBody: true })[0].text, '已执行代码：x\n');
  assert.equal(successPrefixBlocks('x')[0].text, '已执行代码：x');
  assert.equal(successPrefixBlocks('x', { followedByBody: false })[0].text, '已执行代码：x');
});

test('D22 下游空串拼接后意图与正文之间仍有换行（边界不靠块）', () => {
  const base = [{ type: 'text', text: '正文第一行' }];
  const decision = applyPolicy({ exec: topExec('x'), result: okResult(base), decision: { kind: 'accept' } });
  // 模拟 provider / save-token 的 flatten：多个 text 块用空串拼接
  const joined = decision.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  assert.equal(joined, '已执行代码：x\n正文第一行');
});

