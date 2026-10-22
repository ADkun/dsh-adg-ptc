// adg-delegate 的单元测试（零依赖：node:test + node:assert/strict）。
//
// 覆盖 design.md 的不变量（用例编号与 testing-guide.md 的「用例总表」一一对应）。
// 全程不写磁盘、不起 cordis、不碰真会话；唯一的外部真件是 `@deepseek-ai/dsh-tools` 的
// 真 `defineTool`（作者侧 schema 方言写错必须当场炸，这是 D1 的全部意义）。
//
// 跑法：cd delegate && node --test test
//       DSH 沙箱里加 --test-isolation=none（见 testing-guide.md）。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { createAskUserTool, createDelegateTool } from '../index.mjs';
import {
  ASK_TOOL_NAME,
  BUILTIN_DENY,
  CONTINUATION_TOOL,
  PERSONA_SECTION,
  RESERVED_PTC_NAME,
  SUBAGENT_KINDS,
  SUBAGENT_PROVIDER,
  TOOL_NAME,
  answerResult,
  applyChildFace,
  askUser,
  assertCallerAgent,
  buildFace,
  buildRequest,
  createChildFaces,
  createOwnerIndex,
  delegate,
  newChildId,
  planToolFilter,
  questionRequest,
  readRestrictableNames,
  resolveAskOwner,
  toolsNote,
} from '../lib/delegate.mjs';

/** 模块根目录：从 import.meta.url 推，绝不写死本机绝对路径。 */
const MODULE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 一份「典型 profile」的可用全局工具名：六个内置禁用名全在，外加 `notify_user`（它故意**不在**名单里）。 */
const KNOWN = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'web_search',
  'agent',
  'delegate',
  'workflow',
  'ralph',
  'set_child_permission',
  'ask_user_question',
  'notify_user',
  'compress',
  'send_message',
];

const BASE_ARGS = {
  description: '读一下 preset 的委派行',
  prompt: '目标：数清委派行条数。要做什么：只读 preset/agent.cordis.yml。不要做什么：不要改文件。验收标准：报出条数与行号。',
};

/**
 * 假调用方智能体。`view` 除了给对照表，还记下自己被喂的实参 ——
 * 「scope key ＝ 调用方 Agent 自己」是本插件依赖的平台约定，D9 会断言它。
 */
function fakeParent(names = KNOWN, seen = []) {
  return {
    id: 'scheduler-session-1',
    ctx: {
      tools: {
        view(scope) {
          seen.push(scope);
          return { restrictableNames: new Set(names) };
        },
      },
    },
  };
}

/**
 * 假 SubagentRuntime：只实现本插件会调的 `startActivation`（平台唯一入口），
 * 把收到的 spec 原样记下来，并回一个带 dispose 的 activation（回收要可观测）。
 *
 * 真实平台的时序是**先装配子代理、再投递首条 prompt、最后返回** —— `onCreate(spec)`
 * 就是本插件模拟"建立窗口"（`agent/created`）的那一格；`childId` 回显预留的那个 id。
 */
function fakeSubagents() {
  const calls = { startActivation: [], disposed: [] };
  const runtime = {
    calls,
    onCreate: undefined,
    async startActivation(spec) {
      calls.startActivation.push(spec);
      runtime.onCreate?.(spec);
      return {
        childId: spec.childId ?? 'child-session-1',
        messageId: 'message-1',
        dispose: async () => {
          calls.disposed.push(spec);
        },
      };
    },
  };
  return runtime;
}

/**
 * 假子代理（`agents.get(childId)` 回的那个活实例）：记下 `tools.restrict` 与
 * `systemPrompt.section` 的每次调用 —— 能力面走建立窗口 / 创建后窗口，
 * 测试就在这个窗口的接收端断言。
 */
function fakeChild() {
  const ledger = { restrict: [], sections: [] };
  const child = {
    id: 'child-session-1',
    ctx: {
      tools: {
        restrict: (filter) => ledger.restrict.push(filter),
      },
      systemPrompt: {
        getSectionOrder: (name) => `order-of-${name}`,
        section: (spec) => ledger.sections.push(spec),
      },
    },
  };
  return { child, ledger };
}

/**
 * 一套典型夹具：假 runtime + 假子代理 + agents 服务 + 配对表与能力面表。
 *
 * `establishment: true`（缺省）模拟平台真实时序 —— 子代理一被 announce，全局层的
 * `agent/created` 监听就把本次能力面贴上去（抢在首轮装配之前）；`false` 模拟"没赶上
 * 建立窗口"，此时 `delegate` 走创建后窗口的兜底路径（需要 agents 服务）。
 */
function fixture({ names = KNOWN, establishment = true } = {}) {
  const faces = createChildFaces();
  const subagents = fakeSubagents();
  const { child, ledger } = fakeChild();
  const agents = { get: (id) => (id === child.id ? child : undefined) };
  subagents.onCreate = (spec) => {
    child.id = spec.childId ?? child.id;
    if (establishment) faces.applyFor(child);
  };
  const deps = {
    services: () => ({ subagents, agents }),
    rememberFace: (childId, face) => faces.remember(childId, face),
    takeFace: (childId) => faces.take(childId),
  };
  return { subagents, child, ledger, agents, faces, deps, parent: fakeParent(names) };
}

function depsFor(subagents, warn, agents) {
  const faces = createChildFaces();
  return {
    services: () => ({ subagents, ...(agents === undefined ? {} : { agents }) }),
    rememberFace: (childId, face) => faces.remember(childId, face),
    takeFace: (childId) => faces.take(childId),
    ...(warn === undefined ? {} : { warn }),
  };
}

test('D1 工具定义能用真的 defineTool 编出来（作者侧方言与 output 对象根方言）', () => {
  const definition = createDelegateTool();

  assert.equal(definition.name, TOOL_NAME);
  assert.equal(TOOL_NAME, 'delegate');

  // parameters：隐式属性映射 + 属性上的 required:true → 顶层 required 数组；根是隐式开对象。
  assert.deepEqual(Object.keys(definition.parameters.properties), [
    'description',
    'prompt',
    'tools',
    'persona',
    'background',
  ]);
  assert.deepEqual(definition.parameters.required, ['description', 'prompt']);
  assert.deepEqual(definition.parameters.properties.tools.items, { type: 'string' });
  assert.equal(definition.parameters.properties.background.type, 'boolean');
  assert.ok(!('additionalProperties' in definition.parameters));

  // output：对象根 + 显式 additionalProperties:false + 属性上的 required:true。
  assert.equal(definition.output.schema.type, 'object');
  assert.equal(definition.output.schema.additionalProperties, false);
  assert.deepEqual(definition.output.schema.required, [
    'description',
    'subagent_id',
    'kind',
    'tools',
    'tools_note',
    'persona',
  ]);
  assert.deepEqual(definition.output.schema.properties.kind.enum, [...SUBAGENT_KINDS]);
  assert.deepEqual(definition.output.schema.properties.persona.enum, ['set', 'unset']);

  // 编出来的 `isConcurrencySafe(args)` 会先按 parameters 校验一遍实参，再问作者侧那支函数：
  // 实参不成立时返回 false（调度器保守地当独占），实参成立时才是本工具声明的 true。
  assert.equal(definition.isConcurrencySafe({ description: BASE_ARGS.description, prompt: BASE_ARGS.prompt }), true);
  assert.equal(definition.isConcurrencySafe({}), false);
  assert.equal(typeof definition.timeoutMs, 'number');

  // 反向对照一：把对象根形状写进 parameters，真 defineTool 当场拒（证明上面那套形状不是"随便写都过"）
  assert.throws(
    () =>
      defineTool({
        name: 'probe-object-root',
        description: 'd',
        parameters: { type: 'object', properties: { a: { type: 'string' } } },
        output: { schema: definition.output.schema, render: () => [] },
        async execute() {
          return {};
        },
      }),
    /parameters\.type must be a value schema object/,
  );

  // 反向对照二：output 是硬要求，缺了直接炸（真实现是读 `output.render` 时的 TypeError）
  assert.throws(
    () =>
      defineTool({
        name: 'probe-no-output',
        description: 'd',
        parameters: { a: { type: 'string' } },
        async execute() {
          return {};
        },
      }),
    /reading 'render'/,
  );
});

test('D2 tools 省略 ⇒ 只下发 deny、不含 allow；deny 必须与可用名求交', async () => {
  const fx = fixture();
  const out = await delegate({ ...BASE_ARGS }, { agent: fx.parent, signal: undefined }, fx.deps);

  // 内置 deny 走创建后窗口贴到子代理身上（平台的 request 已不承载 toolFilter）
  const filter = fx.ledger.restrict[0];
  assert.deepEqual(Object.keys(filter), ['deny']);
  assert.equal('allow' in filter, false);
  assert.deepEqual(filter.deny, [...BUILTIN_DENY]);
  assert.ok(filter.deny.every((name) => KNOWN.includes(name)));

  assert.deepEqual(out.tools, []);
  assert.equal(out.kind, 'continuable');
  assert.match(out.subagent_id, /^[0-9a-f-]{36}$/);
  assert.equal(out.persona, 'unset');
  assert.match(out.tools_note, /^未过滤：子代理拿到它继承到的全部工具/);
  assert.match(out.tools_note, new RegExp(`减去 ${BUILTIN_DENY.length} 项：${BUILTIN_DENY.join('、')}`));

  // 瘦 profile（只有 Read + delegate）：其余五个名字根本不在表里 ——
  // agent/workflow/ralph 要看对应工具插件是否挂载、set_child_permission 要看有没有装 adg-permission，
  // 绝不能把未注册的名字塞进 deny（平台会抛 names unknown global tool，整次委派失败）。
  const lean = fixture({ names: ['Read', 'delegate'] });
  await delegate({ ...BASE_ARGS }, { agent: lean.parent, signal: undefined }, lean.deps);
  assert.deepEqual(lean.ledger.restrict[0], { deny: ['delegate'] });
});

test('D3 tools 给清单 ⇒ allow 与 deny 同时下发（allow 只留清单里的可用名）', async () => {
  const fx = fixture();
  const out = await delegate(
    { ...BASE_ARGS, tools: ['Read', 'Bash', 'delegate'], persona: '你是一个只读侦察兵' },
    { agent: fx.parent, signal: undefined },
    fx.deps,
  );

  const filter = fx.ledger.restrict[0];
  assert.deepEqual(Object.keys(filter).sort(), ['allow', 'deny']);
  assert.deepEqual(filter.allow, ['Read', 'Bash', CONTINUATION_TOOL]);
  assert.deepEqual(filter.deny, [...BUILTIN_DENY]);
  assert.deepEqual(out.tools, ['Read', 'Bash', CONTINUATION_TOOL]);
  assert.equal(out.persona, 'set');
  assert.match(out.tools_note, /^只保留 3 个：Read、Bash、send_message/);
  assert.match(out.tools_note, /send_message 是平台续接通道/);
  assert.match(out.tools_note, /忽略了 1 个点名的名字：delegate（内置禁用）/);
});

test('D4 清单里的未知名被剔除、去重，并逐条出现在 tools_note 里（不静默丢弃）', async () => {
  const fx = fixture();
  const out = await delegate(
    { ...BASE_ARGS, tools: ['Read', 'Read', 'nosuch_tool', 'agent_brower', ''] },
    { agent: fx.parent, signal: undefined },
    fx.deps,
  ).catch((error) => error);

  // 空字符串是"不是工具名"的坏值（不是未知名），当场抛
  assert.ok(out instanceof Error);
  assert.match(out.message, /tools 里只能放工具名字符串/);

  const fx2 = fixture();
  const out2 = await delegate(
    { ...BASE_ARGS, tools: ['Read', 'Read', 'nosuch_tool', 'agent_brower'] },
    { agent: fx2.parent, signal: undefined },
    fx2.deps,
  );
  assert.deepEqual(out2.tools, ['Read', CONTINUATION_TOOL]);
  assert.match(out2.tools_note, /只保留 2 个：Read、send_message/);
  assert.match(out2.tools_note, /忽略了 2 个点名的名字/);
  assert.match(out2.tools_note, /nosuch_tool（这次没有这个工具名）/);
  assert.match(out2.tools_note, /agent_brower（这次没有这个工具名）/);

  // 纯函数层直接读：ignored 的结构就是模型看到的那份反馈
  // ignored 保持调用方点名的先后顺序（模型能一眼对上自己写的清单，而不是被重排过的一份）
  const plan = planToolFilter(['Read', 'nosuch_tool', 'delegate'], new Set(KNOWN));
  assert.deepEqual(plan.ignored, [
    { name: 'nosuch_tool', reason: 'unknown' },
    { name: 'delegate', reason: 'denied' },
  ]);
  assert.match(toolsNote(plan), /Read/);
});

test('D5 内置 deny 六个名字即使被点名也不进 allow（且仍在 deny 里）；notify_user 不在名单里', async () => {
  const fx = fixture();
  const out = await delegate(
    { ...BASE_ARGS, tools: [...BUILTIN_DENY, 'Read'] },
    { agent: fx.parent, signal: undefined },
    fx.deps,
  );

  const filter = fx.ledger.restrict[0];
  assert.deepEqual(filter.allow, ['Read', CONTINUATION_TOOL]);
  for (const denied of BUILTIN_DENY) {
    assert.ok(!filter.allow.includes(denied), `${denied} 不该进 allow`);
  }
  assert.deepEqual(filter.deny, [...BUILTIN_DENY]);
  assert.deepEqual(out.tools, ['Read', CONTINUATION_TOOL]);
  for (const denied of BUILTIN_DENY) {
    assert.match(out.tools_note, new RegExp(`${denied}（内置禁用）`));
  }
  assert.match(out.tools_note, new RegExp(`忽略了 ${BUILTIN_DENY.length} 个点名的名字`));

  // 反向对照：notify_user **刻意不在**名单里 —— 点名它就该真的给下去
  // （它单向、不阻塞；撞上登录墙的后台子代理要能自己第一时间提醒人，而不是等调度者中转）
  const notifyFx = fixture();
  const outNotify = await delegate(
    { ...BASE_ARGS, tools: ['Read', 'notify_user'] },
    { agent: notifyFx.parent, signal: undefined },
    notifyFx.deps,
  );
  const notifyFilter = notifyFx.ledger.restrict[0];
  assert.deepEqual(notifyFilter.allow, ['Read', 'notify_user', CONTINUATION_TOOL]);
  assert.deepEqual(notifyFilter.deny, [...BUILTIN_DENY]);
  assert.deepEqual(outNotify.tools, ['Read', 'notify_user', CONTINUATION_TOOL]);

  // 空数组：本 profile 没有续接通道时，allow 下发时必须是"已定义的空清单"，不能退化成不下发 allow
  const none = fixture({ names: ['Read'] });
  const out2 = await delegate({ ...BASE_ARGS, tools: [] }, { agent: none.parent, signal: undefined }, none.deps);
  assert.deepEqual(none.ledger.restrict[0].allow, []);
  assert.deepEqual(out2.tools, []);
  assert.match(out2.tools_note, /^空清单：本次不给子代理任何工具/);
});

test('D6 点名 run_code ⇒ 当场拒绝（抛错），且在调用任何服务之前', async () => {
  const fx = fixture();
  await assert.rejects(
    () =>
      delegate({ ...BASE_ARGS, tools: ['Read', RESERVED_PTC_NAME] }, { agent: fx.parent, signal: undefined }, fx.deps),
    (error) => {
      assert.match(error.message, /run_code/);
      assert.match(error.message, /PTC 传输保留名/);
      return true;
    },
  );
  assert.equal(fx.subagents.calls.startActivation.length, 0);
  assert.equal(fx.ledger.restrict.length, 0);

  // 纯函数层：run_code 走的是"抛错"，不是"剔除并写明"
  assert.throws(() => planToolFilter([RESERVED_PTC_NAME], new Set(KNOWN)), /run_code/);
});

test('D7 没有调用方智能体（exec.agent undefined）⇒ 抛错', async () => {
  assert.throws(() => assertCallerAgent(undefined), /delegate: 需要一个调用方智能体/);
  await assert.rejects(
    () => delegate({ ...BASE_ARGS }, {}, depsFor(fakeSubagents())),
    /delegate: 需要一个调用方智能体（exec.agent 是 undefined）/,
  );
  // 缺 subagents 服务也要报清楚（缺哪个报哪个）
  await assert.rejects(
    () => delegate({ ...BASE_ARGS }, { agent: fakeParent(), signal: undefined }, {}),
    /需要 subagents 服务/,
  );
});

test('D8 request 只有 prompt 与 parent；label/signal 归 spec，persona/toolFilter/maxDepth 都不进 request', () => {
  const parent = fakeParent();
  const request = buildRequest(BASE_ARGS, parent);
  assert.deepEqual(Object.keys(request), ['prompt', 'parent']);
  assert.deepEqual(request.prompt, [{ type: 'text', text: BASE_ARGS.prompt }]);
  assert.equal(request.parent, parent);
  // 平台契约：label 与 signal 在 SubagentActivationSpec 上；persona / toolFilter 走创建后窗口
  assert.equal('label' in request, false);
  assert.equal('signal' in request, false);
  assert.equal('persona' in request, false);
  assert.equal('toolFilter' in request, false);
  assert.equal('maxDepth' in request, false);
});

test('D9 走 startActivation（平台唯一入口），spec 键恰为平台要的那一组，能力面贴到子代理身上', async () => {
  const seen = [];
  const parent = fakeParent(KNOWN, seen);
  const fx = fixture();
  const signal = new AbortController().signal;

  const out = await delegate({ ...BASE_ARGS }, { agent: parent, signal }, fx.deps);

  assert.equal(fx.subagents.calls.startActivation.length, 1);
  const spec = fx.subagents.calls.startActivation[0];
  assert.deepEqual(Object.keys(spec), ['provider', 'label', 'childId', 'request', 'signal', 'delivery']);
  assert.equal(spec.provider, SUBAGENT_PROVIDER);
  assert.equal(SUBAGENT_PROVIDER, 'spawn');
  assert.equal(spec.label, BASE_ARGS.description);
  assert.equal(spec.signal, signal);
  assert.equal(spec.delivery, 'parent');
  // 预留 childId（I18）：能力面靠它才能在建立窗口里被认出来
  assert.equal(spec.childId, out.subagent_id);
  assert.deepEqual(Object.keys(spec.request), ['prompt', 'parent']);
  assert.equal(spec.request.parent, parent);
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: BASE_ARGS.prompt }]);
  assert.equal('maxDepth' in spec.request, false);
  assert.equal('persona' in spec.request, false);
  assert.equal('toolFilter' in spec.request, false);

  // 能力面在**建立窗口**下发：内置 deny 进 restrict；没给 persona ⇒ 仍注册一个**空**段
  // （空段 = 遮蔽掉继承来的调度者 persona；不注册就等于让子代理带着它开工，I7）
  assert.equal(fx.ledger.restrict.length, 1);
  assert.deepEqual(fx.ledger.restrict[0].deny, [...BUILTIN_DENY]);
  assert.equal('allow' in fx.ledger.restrict[0], false);
  assert.deepEqual(fx.ledger.sections, [
    { name: PERSONA_SECTION, order: 'order-of-DEPLOYMENT_PERSONA_PREFIX', text: '' },
  ]);

  assert.equal(out.kind, SUBAGENT_KINDS[0]);
  assert.equal(out.kind, 'continuable');
  assert.match(out.subagent_id, /^[0-9a-f-]{36}$/);
  assert.equal(out.description, BASE_ARGS.description);

  // 对照表是从**调用方自己的**工具视图里读的：view 的实参必须是那个 Agent 对象
  assert.deepEqual(seen, [parent]);

  // background: true 显式给了也走同一条路（平台没有别的路）
  const fx2 = fixture();
  const out2 = await delegate({ ...BASE_ARGS, background: true }, { agent: parent, signal }, fx2.deps);
  assert.equal(fx2.subagents.calls.startActivation.length, 1);
  assert.equal(out2.kind, 'continuable');

  // childId 取不到不许当成功回报
  const broken = {
    calls: { startActivation: [], disposed: [] },
    async startActivation() {
      return { messageId: 'message-1', dispose: async () => {} };
    },
  };
  await assert.rejects(
    () => delegate({ ...BASE_ARGS }, { agent: parent, signal }, depsFor(broken, undefined, { get: () => undefined })),
    /没有返回 childId/,
  );
});

test('D10 background:false ⇒ 当场报错（本机 dsh 没有 start，spawn 一律可续），且零服务调用', async () => {
  const fx = fixture();
  await assert.rejects(
    () => delegate({ ...BASE_ARGS, background: false }, { agent: fx.parent, signal: undefined }, fx.deps),
    /background:false（前台一次性）在当前 dsh 版本不可用/,
  );
  assert.equal(fx.subagents.calls.startActivation.length, 0);
  assert.equal(fx.ledger.restrict.length, 0);
});

test('D11 读不出可用工具名（view 形状不符）⇒ fail-closed 抛错，且不调用任何服务', async () => {
  const subagents = fakeSubagents();
  const agents = { get: () => undefined };
  const noView = { id: 'a', ctx: {} };
  const notSet = { id: 'a', ctx: { tools: { view: () => ({}) } } };
  const emptySet = { id: 'a', ctx: { tools: { view: () => ({ restrictableNames: new Set() }) } } };

  await assert.rejects(() => delegate(BASE_ARGS, { agent: noView }, depsFor(subagents, undefined, agents)), /tools\.view 不是函数/);
  await assert.rejects(() => delegate(BASE_ARGS, { agent: notSet }, depsFor(subagents, undefined, agents)), /不是非空 Set/);
  await assert.rejects(() => delegate(BASE_ARGS, { agent: emptySet }, depsFor(subagents, undefined, agents)), /不是非空 Set/);
  assert.equal(subagents.calls.startActivation.length, 0);

  // 形状对了就是一张 Set
  const known = readRestrictableNames(fakeParent());
  assert.ok(known instanceof Set);
  assert.ok(known.has('delegate'));
});

test('D12 入口三件套 / 工具名三处一致 / 零依赖 / 无本机绝对路径', async () => {
  const entry = await readFile(join(MODULE_ROOT, 'index.mjs'), 'utf8');
  const lib = await readFile(join(MODULE_ROOT, 'lib', 'delegate.mjs'), 'utf8');
  const patch = await readFile(join(MODULE_ROOT, 'cordis.patch.yml'), 'utf8');
  const pkg = JSON.parse(await readFile(join(MODULE_ROOT, 'package.json'), 'utf8'));

  assert.match(entry, /export const name = 'adg-delegate';/);
  assert.match(entry, /export const inject = \['tools'\];/);
  assert.match(entry, /export function apply\(ctx\) \{/);
  assert.match(patch, /^\s*- id: adg-delegate$/m);
  assert.match(patch, /^\s*name: adg-delegate$/m);
  assert.match(patch, /^- insert:$/m);
  assert.equal(pkg.name, 'adg-delegate');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './index.mjs');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');

  // 纯逻辑层零 import：不碰 cordis、不碰 dsh-*
  assert.ok(!/^\s*import\s/m.test(lib));
  assert.ok(!/from\s+'@deepseek-ai\//.test(lib));

  for (const [file, source] of [
    ['index.mjs', entry],
    ['lib/delegate.mjs', lib],
  ]) {
    assert.ok(!/[A-Za-z]:[\\/]/.test(source), `${file} 里出现盘符绝对路径`);
    assert.ok(!/~[\\/]/.test(source), `${file} 里出现用户根路径`);
  }
});

test('D13 真 defineTool 编出的定义能在假服务上跑通一次完整调用并 render 出一行人话', async () => {
  const fx = fixture();
  const definition = createDelegateTool({ services: fx.deps.services });
  const value = await definition.execute({ ...BASE_ARGS, tools: ['Read'] }, { agent: fx.parent, signal: undefined });

  assert.match(value.subagent_id, /^[0-9a-f-]{36}$/);
  assert.equal(value.kind, 'continuable');
  assert.deepEqual(value.tools, ['Read', CONTINUATION_TOOL]);
  // 能力面真的贴到了子代理身上
  assert.deepEqual(fx.ledger.restrict[0], { allow: ['Read', CONTINUATION_TOOL], deny: [...BUILTIN_DENY] });
  const rendered = definition.output.render({}, value);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, new RegExp(value.subagent_id));
  assert.match(rendered[0].text, /只保留 2 个：Read、send_message/);
});

// ── ask_user（I12）：子代理的提问通道 ────────────────────────────────────────
// 这几条测的是本插件对平台边界的那一处**绕行**：平台只准 live runtime root 提问
// （子代理调 `ask_user_question` 拿 `DELEGATED_CALLER`），所以提问的 owner 换成派它的那个人。
// 关键词：交出去的一定是**调度者**这个活实例，拿不到就抛错而不是降级成"以子代理名义问"。

test('D14 ask_user 的定义能用真 defineTool 编出来（参数在属性上必填，两值枚举的 asked_as）', () => {
  const definition = createAskUserTool();

  assert.equal(definition.name, ASK_TOOL_NAME);
  assert.equal(ASK_TOOL_NAME, 'ask_user');

  assert.deepEqual(definition.parameters.required, ['questions']);
  assert.equal(definition.parameters.properties.questions.type, 'array');
  assert.equal(definition.parameters.properties.questions.items.type, 'object');
  assert.deepEqual(definition.parameters.properties.questions.items.properties.id, {
    type: 'string',
    description: '稳定 id；答案按它回显。',
  });
  assert.deepEqual(definition.parameters.properties.questions.items.required, ['id', 'question']);
  assert.equal(definition.parameters.properties.questions.items.properties.multi_select.type, 'boolean');

  assert.equal(definition.output.schema.additionalProperties, false);
  assert.deepEqual(definition.output.schema.required, ['asked_as', 'answers']);
  assert.deepEqual(definition.output.schema.properties.asked_as.enum, ['scheduler', 'self']);

  // 它等的是人：声明成"同一次里不许并发"，且**刻意不设** timeoutMs（等的是人去登录，不是秒级动作）
  assert.equal(definition.isConcurrencySafe({ questions: [{ id: 'q1', question: '好了吗' }] }), false);
  assert.equal(definition.timeoutMs, undefined);
});

test('D15 子代理调用 ⇒ 以派它的那个调度者为 owner 问出去，答案是脱拷贝的', async () => {
  const parent = { id: 'scheduler-1' };
  const child = { id: 'child-session-1' };
  const asked = [];
  const userQuestions = {
    async ask(request) {
      asked.push(request);
      return { answers: [{ id: 'login', selected: ['好了'], custom: undefined }] };
    },
  };
  const agents = { get: (id) => (id === 'scheduler-1' ? parent : undefined) };

  const out = await askUser(
    [{ id: 'login', question: '登录好了吗？', header: '登录', options: [{ label: '好了', description: '我已在窗口里登录' }] }],
    { agent: child, signal: undefined },
    { services: () => ({ agents, userQuestions }), ownerIdOf: () => 'scheduler-1' },
  );

  assert.equal(out.asked_as, 'scheduler');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].agent, parent, 'agent 必须是调度者那个活实例，不是子代理');
  assert.deepEqual(asked[0].questions, [
    { id: 'login', question: '登录好了吗？', header: '登录', options: [{ label: '好了', description: '我已在窗口里登录' }] },
  ]);
  // 没写的键不许凭空出现（`multi_select` → `multiSelect` 只在给了的时候带）
  assert.ok(!('multiSelect' in asked[0].questions[0]));
  assert.deepEqual(out.answers, [{ id: 'login', selected: ['好了'] }]);
});

test('D16 调度者自己调用 ⇒ owner 就是自己（asked_as: self），multi_select 映射成 multiSelect', async () => {
  const parent = { id: 'scheduler-1' };
  const asked = [];
  const userQuestions = { ask: async (request) => (asked.push(request), { answers: [{ id: 'q', selected: ['继续'] }] }) };

  const out = await askUser(
    [{ id: 'q', question: '继续吗？', multi_select: true }],
    { agent: parent },
    { services: () => ({ agents: { get: () => undefined }, userQuestions }), ownerIdOf: () => undefined },
  );

  assert.equal(out.asked_as, 'self');
  assert.equal(asked[0].agent, parent);
  assert.equal(asked[0].questions[0].multiSelect, true);
});

test('D17 拿不到调度者的活实例 ⇒ 抛错且**不**去问（绝不降级成以子代理名义问）', async () => {
  const child = { id: 'child-session-1' };
  let asked = 0;
  const userQuestions = { ask: async () => (asked += 1, { answers: [] }) };

  await assert.rejects(
    () =>
      askUser([{ id: 'q', question: 'x' }], { agent: child }, {
        services: () => ({ agents: { get: () => undefined }, userQuestions }),
        ownerIdOf: () => 'scheduler-gone',
      }),
    /不是活着的会话/,
  );
  assert.equal(asked, 0);

  // agents 服务没挂载也一样：不猜、不降级
  assert.throws(() => resolveAskOwner(child, 'scheduler-1', undefined), /需要 agents 服务/);

  // userQuestions 服务没挂载 ⇒ 说清是缺哪条链路，而不是"不可用"三个字
  await assert.rejects(
    () => askUser([{ id: 'q', question: 'x' }], { agent: child }, { services: () => ({}), ownerIdOf: () => undefined }),
    /需要 userQuestions 服务/,
  );
});

test('D18 问题与答案的形状当场校验（空数组 / 空 id / 重复 id / 缺正文 / 服务没给 answers）', () => {
  const parent = { id: 'p' };

  assert.throws(() => questionRequest(undefined, parent), /至少要有 1 个问题/);
  assert.throws(() => questionRequest([], parent), /至少要有 1 个问题/);
  assert.throws(() => questionRequest([{ question: 'x' }], parent), /非空的字符串 id/);
  assert.throws(() => questionRequest([{ id: 'a', question: 'x' }, { id: 'a', question: 'y' }], parent), /出现了两次/);
  assert.throws(() => questionRequest([{ id: 'a', question: '   ' }], parent), /缺少 question 正文/);
  assert.throws(() => answerResult({}), /没有返回 answers 数组/);
  assert.throws(() => answerResult({ answers: undefined }), /没有返回 answers 数组/);

  // 问题正文与选项都脱拷贝：服务拿到的是新对象，改它不会改调用方的数组
  const source = { id: 'a', question: 'x', options: [{ label: 'l' }] };
  const request = questionRequest([source], parent);
  request.questions[0].options[0].label = 'changed';
  assert.equal(source.options[0].label, 'l');

  // 没有调用方智能体 ⇒ 抛错（与委托路径同一条前端约束）
  assert.throws(() => assertCallerAgent({}, ASK_TOOL_NAME), /需要一个调用方智能体/);
});

test('D19 配对表只记成形的一对；ask_user 不许在 BUILTIN_DENY 里（子代理必须有提问通道）', () => {
  const owners = createOwnerIndex();
  assert.equal(owners.ownerIdOf('child-1'), undefined);

  owners.remember('child-1', { id: 'scheduler-1' });
  assert.equal(owners.ownerIdOf('child-1'), 'scheduler-1');

  owners.remember('', { id: 'scheduler-1' }); // 空 childId 不记
  owners.remember('child-2', {}); // 没有 id 的调用方不记
  owners.remember('child-3', undefined);
  assert.equal(owners.size(), 1);
  assert.equal(owners.ownerIdOf(undefined), undefined);

  // 这条是**红线级**的：禁掉 ask_user 就等于把子代理打回"单向喊一声 + 轮询"
  assert.ok(!BUILTIN_DENY.includes(ASK_TOOL_NAME));
  assert.ok(BUILTIN_DENY.includes('ask_user_question'), '平台那条仍要对子代理关闭');
});

test('D20 可续路径把 (childId → 调度者) 交给配对表', async () => {
  const parent = fakeParent();
  const pairs = [];
  const fx = fixture();
  await delegate(BASE_ARGS, { agent: parent }, {
    ...fx.deps,
    rememberChild: (childId, owner) => pairs.push([childId, owner]),
  });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0][1], parent);
  assert.match(pairs[0][0], /^[0-9a-f-]{36}$/);
});

test('D21 真 defineTool 编出的 ask_user 能在假服务上跑通一次完整调用并 render 出一行人话', async () => {
  const parent = { id: 'scheduler-1' };
  const asked = [];
  const definition = createAskUserTool({
    services: () => ({
      agents: { get: (id) => (id === 'scheduler-1' ? parent : undefined) },
      userQuestions: { ask: async (request) => (asked.push(request), { answers: [{ id: 'q1', selected: ['好了'] }] }) },
    }),
    ownerIdOf: () => 'scheduler-1',
  });

  const value = await definition.execute(
    { questions: [{ id: 'q1', question: '登录好了吗？', options: [{ label: '好了' }] }] },
    { agent: { id: 'child-1' } },
  );

  assert.equal(value.asked_as, 'scheduler');
  assert.equal(asked[0].agent, parent);
  const rendered = definition.output.render({}, value);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /scheduler/);
  assert.match(rendered[0].text, /好了/);
});

// ── 创建后窗口的能力面下发（I16）────────────────────────────────────────────
// 平台把 per-child persona / toolFilter 从委派缝隙里拿掉了；本插件用与平台
// applyChildOverrides 同形的方式在创建后窗口贴上去。这几条钉住形状与 fail-closed 口径。

test('D22 applyChildFace：persona **一律**注册成 deployment:persona-prefix 段（没给就是空段＝遮蔽）、toolFilter 走 restrict；形状不符 fail-closed', () => {
  const { child, ledger } = fakeChild();
  const applied = applyChildFace(child, { persona: '你是只读侦察兵', filter: { deny: ['delegate'] } });
  assert.deepEqual(applied, ['toolFilter', 'persona']);
  assert.deepEqual(ledger.restrict, [{ deny: ['delegate'] }]);
  assert.deepEqual(ledger.sections, [
    { name: 'deployment:persona-prefix', order: 'order-of-DEPLOYMENT_PERSONA_PREFIX', text: '你是只读侦察兵' },
  ]);

  // 没给 persona ⇒ 仍注册**空**段：不注册就是不遮蔽，子代理会带着继承来的调度者 persona 开工
  const bare = fakeChild();
  assert.deepEqual(applyChildFace(bare.child, {}), ['persona']);
  assert.equal(bare.ledger.restrict.length, 0);
  assert.deepEqual(bare.ledger.sections, [{ name: PERSONA_SECTION, order: 'order-of-DEPLOYMENT_PERSONA_PREFIX', text: '' }]);

  // 取不到活实例 ⇒ 抛错
  assert.throws(() => applyChildFace(undefined, { filter: { deny: ['delegate'] } }), /取不到子代理的活实例/);

  // restrict 不是函数 ⇒ 抛错（绝不把没受限的子代理当成"已按清单下发"）
  const noRestrict = { id: 'c', ctx: { tools: {} } };
  assert.throws(() => applyChildFace(noRestrict, { filter: { deny: ['delegate'] } }), /tools\.restrict 不是函数/);

  // systemPrompt 形状不符 ⇒ 抛错（绝不把"没给 persona"当成"给了"）
  const noPrompt = { id: 'c', ctx: { tools: { restrict: () => {} } } };
  assert.throws(() => applyChildFace(noPrompt, { persona: 'p' }), /systemPrompt\.section 不可用/);
});

test('D28 能力面在**建立窗口**贴上（子代理首轮装配之前）—— 不是等 startActivation 返回之后', async () => {
  const fx = fixture();
  // 平台真实时序：装配 → 投递首条 prompt → 返回。断言"贴上"发生在返回之前
  let restrictedAtReturn = 0;
  const spec = (await delegate({ ...BASE_ARGS, persona: '你是档案管理员' }, { agent: fx.parent, signal: undefined }, fx.deps));
  assert.equal(spec.persona, 'set');
  restrictedAtReturn = fx.ledger.sections.length;
  assert.equal(restrictedAtReturn, 1, '建立窗口里就该有 persona 段');
  assert.deepEqual(fx.ledger.sections, [
    { name: PERSONA_SECTION, order: 'order-of-DEPLOYMENT_PERSONA_PREFIX', text: '你是档案管理员' },
  ]);
  // 建立窗口贴过之后，创建后窗口不再重复贴（否则同名段重复注册会抛）
  assert.equal(fx.ledger.restrict.length, 1);
  assert.equal(fx.ledger.sections.length, 1);
});

test('D29 没赶上建立窗口 ⇒ 退回创建后窗口贴一次（兜底不静默）', async () => {
  const fx = fixture({ establishment: false });
  const out = await delegate({ ...BASE_ARGS, persona: '你是档案管理员' }, { agent: fx.parent, signal: undefined }, fx.deps);
  assert.equal(out.persona, 'set');
  assert.deepEqual(fx.ledger.sections, [
    { name: PERSONA_SECTION, order: 'order-of-DEPLOYMENT_PERSONA_PREFIX', text: '你是档案管理员' },
  ]);
});

test('D30 建立窗口里贴失败 ⇒ 不吞掉：回收子代理后把原始错误抛给调用方', async () => {
  const fx = fixture();
  const brokenChild = { ctx: { tools: { restrict: () => {} } } };
  fx.child.ctx = brokenChild.ctx; // 没有 systemPrompt ⇒ applyChildFace 抛错
  await assert.rejects(
    () => delegate({ ...BASE_ARGS, persona: 'p' }, { agent: fx.parent, signal: undefined }, fx.deps),
    /systemPrompt\.section 不可用/,
  );
  assert.equal(fx.subagents.calls.disposed.length, 1);
});

test('D31 预留 childId 与平台回显不一致 ⇒ 抛错（能力边界不可信，不许当成功）', async () => {
  const fx = fixture();
  fx.subagents.startActivation = async (spec) => ({
    childId: 'someone-else',
    messageId: 'm',
    dispose: async () => {},
  });
  await assert.rejects(
    () => delegate({ ...BASE_ARGS }, { agent: fx.parent, signal: undefined }, fx.deps),
    /与预留的/,
  );
  assert.equal(fx.faces.size(), 0, '不一致时登记表不许残留');
});

test('D32 buildFace：persona 恒为字符串（没给＝空串，不是 undefined）；newChildId 每次不同', () => {
  const plan = planToolFilter(undefined, new Set(KNOWN));
  assert.deepEqual(buildFace({}, plan), { persona: '', filter: plan.filter });
  assert.equal(buildFace({ persona: 'p' }, plan).persona, 'p');
  assert.equal(buildFace({ persona: 42 }, plan).persona, '', '非字符串一律当没给');

  const a = newChildId();
  const b = newChildId();
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});

test('D33 回显的 persona 只认**非空字符串**：空串也算 unset（不许把"贴了空段"报成给了）', async () => {
  for (const [persona, expected] of [
    ['你是档案管理员', 'set'],
    ['', 'unset'],
    [undefined, 'unset'],
  ]) {
    const fx = fixture();
    const args = persona === undefined ? { ...BASE_ARGS } : { ...BASE_ARGS, persona };
    const out = await delegate(args, { agent: fx.parent, signal: undefined }, fx.deps);
    assert.equal(out.persona, expected);
    // 无论 set/unset，persona 段**都**注册了（unset 时是一段空串，靠它遮蔽继承来的调度者 persona）
    assert.equal(fx.ledger.sections.length, 1);
    assert.equal(fx.ledger.sections[0].text, persona ?? '');
  }
});

test('D34 建立窗口监听器不把异常抛回平台：applyFor 吞下错误只记状态', () => {
  const faces = createChildFaces();
  faces.remember('child-x', { persona: 'p', filter: undefined });
  // ctx 缺 systemPrompt ⇒ applyChildFace 抛，但 applyFor 不许把这条错误抛给 agent/created 的派发方
  const broken = { id: 'child-x', ctx: { tools: { restrict: () => {} } } };
  assert.equal(faces.applyFor(broken), true);
  const entry = faces.take('child-x');
  assert.equal(entry.status, 'failed');
  assert.match(String(entry.error), /systemPrompt\.section 不可用/);

  // 没登记的 agent / 已经收口过的 agent ⇒ 一律返回 false（监听器是全局的，别人的 agent 也会经过）
  assert.equal(faces.applyFor({ id: 'someone-else', ctx: {} }), false);
  assert.equal(faces.applyFor(undefined), false);
  assert.equal(faces.applyFor(broken), false);
});

test('D23 能力面下发失败 ⇒ 回收子代理再抛错；agents 服务缺失同理（绝不留下没受限的子代理当成功）', async () => {
  const parent = fakeParent();

  // 兜底路径（没赶上建立窗口）取不回子代理 ⇒ 回收 + 抛错
  const noAgents = fakeSubagents();
  const noAgentsDeps = {
    services: () => ({ subagents: noAgents }),
    rememberFace: () => {},
    takeFace: () => undefined,
  };
  await assert.rejects(
    () => delegate({ ...BASE_ARGS }, { agent: parent, signal: undefined }, noAgentsDeps),
    /需要 agents 服务/,
  );
  assert.equal(noAgents.calls.disposed.length, 1);

  // agents.get 取不到活实例 ⇒ applyChildFace 抛错 ⇒ 回收
  const fx = fixture({ establishment: false });
  fx.agents.get = () => undefined;
  await assert.rejects(
    () => delegate({ ...BASE_ARGS }, { agent: parent, signal: undefined }, fx.deps),
    /取不到子代理的活实例/,
  );
  assert.equal(fx.subagents.calls.disposed.length, 1);

  // 正常路径不回收
  const ok = fixture();
  await delegate({ ...BASE_ARGS }, { agent: ok.parent, signal: undefined }, ok.deps);
  assert.equal(ok.subagents.calls.disposed.length, 0);
});

// ── send_message 是平台续接通道（I17）────────────────────────────────────
// 平台在 startActivation 时就按子代理继承到的工具目录追加了续接提示；本插件在创建后窗口
// 下发的 allow 不能把它剥掉，否则提示与工具面自相矛盾。这几条钉住"无条件保留"的口径。

test('D24 send_message 是平台续接通道：显式传 tools 没点名它，allow 仍含它', () => {
  const plan = planToolFilter(['Read', 'Bash'], new Set(KNOWN));
  assert.deepEqual(plan.tools, ['Read', 'Bash', CONTINUATION_TOOL]);
  assert.ok(plan.filter.allow.includes(CONTINUATION_TOOL));
  assert.deepEqual(plan.filter.allow, ['Read', 'Bash', CONTINUATION_TOOL]);
  // 点名过就不再重复追加
  const named = planToolFilter(['Read', CONTINUATION_TOOL], new Set(KNOWN));
  assert.deepEqual(named.tools, ['Read', CONTINUATION_TOOL]);
  // tools_note 反映保留事实（不静默）
  assert.match(toolsNote(plan), new RegExp(CONTINUATION_TOOL + ' 是平台续接通道'));
});

test('D25 knownNames 里没有 send_message ⇒ 不强行注入（且不抛错）', () => {
  const lean = new Set(['Read', 'delegate', 'notify_user']);
  const plan = planToolFilter(['Read', 'Bash'], lean);
  assert.deepEqual(plan.tools, ['Read']);
  assert.ok(!plan.filter.allow.includes(CONTINUATION_TOOL));
  // 纯 deny 分支也不受影响
  const denyOnly = planToolFilter(undefined, lean);
  assert.deepEqual(denyOnly.tools, []);
  // 空清单在没有续接通道时仍是空清单
  const empty = planToolFilter([], lean);
  assert.deepEqual(empty.tools, []);
  assert.deepEqual(empty.filter.allow, []);
  assert.match(toolsNote(empty), /^空清单：本次不给子代理任何工具/);
});

test('D26 tools: [] 时 send_message 仍在（平台提示照样会被追加）', async () => {
  const fx = fixture();
  const out = await delegate({ ...BASE_ARGS, tools: [] }, { agent: fx.parent, signal: undefined }, fx.deps);
  assert.deepEqual(fx.ledger.restrict[0].allow, [CONTINUATION_TOOL]);
  assert.deepEqual(out.tools, [CONTINUATION_TOOL]);
  assert.match(out.tools_note, /^只保留 1 个：send_message/);
  assert.match(out.tools_note, new RegExp(CONTINUATION_TOOL + ' 是平台续接通道'));
});

test('D27 tools_note 文案反映 send_message 被保留的原因', () => {
  const plan = planToolFilter(['Read', 'Bash'], new Set(KNOWN));
  const note = toolsNote(plan);
  assert.match(note, /只保留 3 个：Read、Bash、send_message/);
  assert.match(note, /send_message 是平台续接通道，不是任务能力，本次一并保留以便回传结果/);
});
