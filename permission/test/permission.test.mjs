// adg-permission 的单元测试。
//
// 零依赖、零副作用：不起 cordis、不碰真会话、不写磁盘、不联网、不读 profile。
// 唯一的环境前提：`@deepseek-ai/dsh-tools` 必须能解析 —— 它是 peer 依赖，由 dsh 本身供给；
// 本机在仓库根放了一个 git-ignore 的 node_modules 桥（见 package.json 的 peerDependenciesMeta）。
//
// 跑法：
//   cd permission && node --test test
//   cd permission && node --test --test-isolation=none test      # DSH 沙箱里加这个 flag
//
// 用例编号 D1..D8 一一对应 design.md「核心数据模型」的不变量与「测试与验证」。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { defineTool } from '@deepseek-ai/dsh-tools';

import {
  SANDBOX_MODES,
  assertNotWidening,
  isSandboxMode,
  modeRank,
  sandboxModeEvent,
} from '../lib/permission.mjs';
import {
  TOOL_NAME,
  createSetChildPermissionTool,
  name as PLUGIN_NAME,
  setChildPermission,
} from '../index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// ── 假件：只实现被测代码真正碰到的那几个面 ────────────────────────────────────

class FakeLiveSession {
  constructor(id) {
    this.id = id;
    this.appended = [];
  }

  append(type, data) {
    this.appended.push({ type, data });
  }
}

function fakeServices(overrides = {}) {
  const calls = { flush: [], opened: [], closed: [], read: [], appended: [] };
  const live = overrides.live ?? undefined;

  const sessions = {
    get: (id) => (live !== undefined && live.id === id ? live : undefined),
    flush: async (session) => {
      calls.flush.push(session.id);
    },
  };

  const descendants = overrides.descendants ?? [
    { id: 'child-1', parentId: 'caller-1', depth: 1, mode: 'continuable', label: 'browser-ops' },
  ];

  const subagents = {
    listDescendants: async (parentId) => {
      calls.listParent = parentId;
      return descendants;
    },
  };

  const sandboxPolicy = {
    resolve: ({ session }) => ({ mode: overrides.callerMode ?? 'danger-full-access', sessionId: session?.id }),
  };

  const storedEvents = overrides.storedEvents ?? [{ type: 'session/start', seq: 0, time: 1, data: {} }];

  const sessionPersistence = {
    open: async (id, access, options) => {
      calls.opened.push({ id, access, options });
      return {
        read: async (offset, length, readOptions) => {
          calls.read.push({ offset, length, readOptions });
          if (overrides.readThrows === true) throw new Error('read blew up');
          return { events: storedEvents, eventState: {} };
        },
        append: async (events) => {
          if (overrides.appendThrows === true) throw new Error('append blew up');
          calls.appended.push(...events);
        },
        flush: async () => {
          if (overrides.flushThrows === true) throw new Error('flush blew up');
        },
        close: async () => {
          calls.closed.push(id);
          if (overrides.closeThrows === true) throw new Error('close blew up');
        },
      };
    },
  };

  return {
    calls,
    services: {
      sessions: overrides.noSessions === true ? undefined : sessions,
      subagents: overrides.noSubagents === true ? undefined : subagents,
      sandboxPolicy: overrides.noSandboxPolicy === true ? undefined : sandboxPolicy,
      sessionPersistence: overrides.noPersistence === true ? undefined : sessionPersistence,
    },
    live,
  };
}

function fakeExec(agent = { id: 'caller-1', session: { id: 'caller-1' } }) {
  return { agent, signal: undefined };
}

// ── D1：作者侧声明能被真的 defineTool 编译 ────────────────────────────────────

test('D1：真 defineTool 编译得过，且名字/描述对得上', () => {
  const tool = createSetChildPermissionTool({ services: () => fakeServices().services });
  assert.equal(tool.name, TOOL_NAME);
  assert.equal(TOOL_NAME, 'set_child_permission');
  assert.equal(PLUGIN_NAME, 'adg-permission');
  assert.match(tool.description, /不得超过你自己当前的权限/);
});

test('D1 反向对照：对象根形状会被真 defineTool 拒掉', () => {
  // 只断言"我们的写法不抛"是空转 —— 这里反过来钉住"写错了会抛"，
  // 证明 D1 那条断言真的在检查形状（parameters.type must be a value schema object）。
  assert.throws(
    () =>
      defineTool({
        name: 'shape-probe',
        description: 'probe',
        parameters: { type: 'object', properties: { a: { type: 'string' } } },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {} },
          render: () => [{ type: 'text', text: 'ok' }],
        },
        async execute() {
          return {};
        },
      }),
    /parameters\.type must be a value schema object/,
  );
});

// ── D2：三级序与单调守卫 ──────────────────────────────────────────────────────

test('D2：SANDBOX_MODES 从窄到宽，modeRank 与之一致', () => {
  assert.deepEqual([...SANDBOX_MODES], ['read-only', 'workspace-write', 'danger-full-access']);
  assert.equal(modeRank('read-only'), 0);
  assert.equal(modeRank('workspace-write'), 1);
  assert.equal(modeRank('danger-full-access'), 2);
});

test('D2：未知模式不当"最窄"，真值和幻影值一律 undefined', () => {
  assert.equal(isSandboxMode('read-only'), true);
  assert.equal(isSandboxMode('workspace'), false);
  assert.equal(isSandboxMode(''), false);
  assert.equal(modeRank('DANGER-FULL-ACCESS'), undefined);
  assert.equal(modeRank(2), undefined);
  assert.equal(modeRank(undefined), undefined);
});

test('D2：同权限与降级放行，放大一律拒', () => {
  assert.equal(assertNotWidening('read-only', 'read-only'), 0);
  assert.equal(assertNotWidening('workspace-write', 'read-only'), 0);
  assert.equal(assertNotWidening('danger-full-access', 'workspace-write'), 1);
  assert.equal(assertNotWidening('danger-full-access', 'danger-full-access'), 2);

  assert.throws(() => assertNotWidening('read-only', 'workspace-write'), /拒绝放大权限/);
  assert.throws(() => assertNotWidening('read-only', 'danger-full-access'), /拒绝放大权限/);
  assert.throws(() => assertNotWidening('workspace-write', 'danger-full-access'), /拒绝放大权限/);
});

test('D2：读不出调用方模式时拒绝，而不是放过去', () => {
  assert.throws(() => assertNotWidening(undefined, 'read-only'), /读不出调用方自己的文件权限/);
  assert.throws(() => assertNotWidening('custom', 'read-only'), /读不出调用方自己的文件权限/);
});

test('D2：未知目标模式报可用值', () => {
  assert.throws(() => assertNotWidening('danger-full-access', 'root'), /未知权限模式/);
  assert.throws(() => assertNotWidening('danger-full-access', 'root'), /read-only \/ workspace-write \/ danger-full-access/);
});

// ── D3：事件信封 ──────────────────────────────────────────────────────────────

test('D3：事件信封是 {type,seq,time,data}，且故意不带 source', () => {
  const event = sandboxModeEvent('workspace-write', 7, 1234);
  assert.deepEqual(event, {
    type: 'sandbox/mode',
    seq: 7,
    time: 1234,
    data: { mode: 'workspace-write' },
  });
  // 带上 source 会在旧格式日志的 v0→v1 迁移里被拒（只认 "delegation"）。
  assert.equal('source' in event, false);
  assert.equal('source' in event.data, false);
});

test('D3：信封只接受已知模式与合法 seq', () => {
  assert.throws(() => sandboxModeEvent('root', 0, 1), /unusable sandbox mode/);
  assert.throws(() => sandboxModeEvent('read-only', -1, 1), /unusable seq/);
  assert.throws(() => sandboxModeEvent('read-only', 1.5, 1), /unusable seq/);
});

// ── D4：运行中的子代理走 live 路径 ────────────────────────────────────────────

test('D4：会话在跑时追加事件并 flush，返回 live', async () => {
  const live = new FakeLiveSession('child-1');
  const { services, calls } = fakeServices({ live });

  const result = await setChildPermission({ agent_id: 'child-1', mode: 'danger-full-access' }, fakeExec(), {
    services: () => services,
  });

  assert.deepEqual(live.appended, [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }]);
  assert.deepEqual(calls.flush, ['child-1']);
  assert.equal(calls.opened.length, 0, 'live 路径不该碰持久化层');
  assert.equal(result.applied, 'live');
  assert.equal(result.mode, 'danger-full-access');
  assert.equal(result.agent_id, 'child-1');
  assert.match(result.note, /下一步就按新模式走/);
});

test('D4：live 路径不动 approval（子代理恒 never，没人能替它点同意）', async () => {
  const live = new FakeLiveSession('child-1');
  const { services } = fakeServices({ live });
  await setChildPermission({ agent_id: 'child-1', mode: 'workspace-write' }, fakeExec(), { services: () => services });
  assert.equal(
    live.appended.some((event) => event.type === 'approval/policy'),
    false,
  );
});

test('D4：live 路径也过单调守卫 —— 只读会话改不动', async () => {
  const live = new FakeLiveSession('child-1');
  const { services } = fakeServices({ live, callerMode: 'read-only' });
  await assert.rejects(
    () => setChildPermission({ agent_id: 'child-1', mode: 'workspace-write' }, fakeExec(), { services: () => services }),
    /拒绝放大权限/,
  );
  assert.deepEqual(live.appended, []);
});

// ── D5：已停下的子代理走持久化路径 ────────────────────────────────────────────

test('D5：会话已停下时写进它的日志，seq 接在现有事件之后，返回 persisted', async () => {
  const storedEvents = [
    { type: 'session/start', seq: 0, time: 1, data: {} },
    { type: 'user/message', seq: 1, time: 2, data: {} },
    { type: 'session/end-seed', seq: 2, time: 3, data: { inherited: true } },
  ];
  const { services, calls } = fakeServices({ live: undefined, storedEvents });

  const result = await setChildPermission({ agent_id: 'child-1', mode: 'workspace-write' }, fakeExec(), {
    services: () => services,
  });

  assert.equal(calls.opened.length, 1);
  assert.equal(calls.opened[0].id, 'child-1');
  assert.equal(calls.opened[0].access, 'write');
  assert.equal(calls.appended.length, 1);
  assert.equal(calls.appended[0].type, 'sandbox/mode');
  assert.deepEqual(calls.appended[0].data, { mode: 'workspace-write' });
  assert.equal(calls.appended[0].seq, 3, 'seq 必须等于现有事件条数（日志里 seq 恒等于下标）');
  assert.equal(typeof calls.appended[0].time, 'number');
  assert.deepEqual(calls.closed, ['child-1']);
  assert.equal(result.applied, 'persisted');
  assert.match(result.note, /下次恢复/);
});

test('D5：持久化写失败时也一定关句柄（不泄漏写租约）', async () => {
  for (const override of [{ appendThrows: true }, { flushThrows: true }]) {
    const { services, calls } = fakeServices(override);
    await assert.rejects(
      () => setChildPermission({ agent_id: 'child-1', mode: 'read-only' }, fakeExec(), { services: () => services }),
      /blew up/,
    );
    assert.deepEqual(calls.closed, ['child-1'], `句柄没关：${JSON.stringify(override)}`);
  }
});

test('D5：close 自己失败不掩盖主错误', async () => {
  const { services } = fakeServices({ appendThrows: true, closeThrows: true });
  await assert.rejects(
    () => setChildPermission({ agent_id: 'child-1', mode: 'read-only' }, fakeExec(), { services: () => services }),
    /append blew up/,
  );
});

// ── D6：守卫与拒答路径 ────────────────────────────────────────────────────────

test('D6：没有调用方智能体就没有"我的子代理"这回事', async () => {
  const { services } = fakeServices();
  await assert.rejects(
    () => setChildPermission({ agent_id: 'child-1', mode: 'read-only' }, {}, { services: () => services }),
    /需要一个调用方智能体/,
  );
});

test('D6：缺 sessions / subagents 服务时明确报缺哪个', async () => {
  const noSessions = fakeServices({ noSessions: true });
  await assert.rejects(
    () => setChildPermission({ agent_id: 'child-1', mode: 'read-only' }, fakeExec(), { services: () => noSessions.services }),
    /需要 subagents 与 sessions 两个服务/,
  );

  const noSubagents = fakeServices({ noSubagents: true });
  await assert.rejects(
    () => setChildPermission({ agent_id: 'child-1', mode: 'read-only' }, fakeExec(), { services: () => noSubagents.services }),
    /需要 subagents 与 sessions 两个服务/,
  );
});

test('D6：缺 sandboxPolicy 时拒绝改权限（单调守卫读不出调用方）', async () => {
  const { services } = fakeServices({ noSandboxPolicy: true });
  await assert.rejects(
    () => setChildPermission({ agent_id: 'child-1', mode: 'read-only' }, fakeExec(), { services: () => services }),
    /缺 sandboxPolicy 服务/,
  );
});

test('D6：血缘校验 —— 不是自己派出去的子代理一律拒', async () => {
  const { services } = fakeServices({ descendants: [] });
  await assert.rejects(
    () => setChildPermission({ agent_id: 'someone-elses-child', mode: 'read-only' }, fakeExec(), { services: () => services }),
    /不是你派出去的子代理/,
  );

  const diagnostic = fakeServices({
    descendants: [{ id: 'child-1', parentId: 'caller-1', depth: 1, kind: 'diagnostic', mode: 'one-shot' }],
  });
  await assert.rejects(
    () => setChildPermission({ agent_id: 'child-1', mode: 'read-only' }, fakeExec(), { services: () => diagnostic.services }),
    /不是你派出去的子代理/,
  );
});

test('D6：血缘只认调用方自己的子树（用调用方 id 去问）', async () => {
  const { services, calls } = fakeServices();
  await setChildPermission({ agent_id: 'child-1', mode: 'read-only' }, fakeExec(), { services: () => services });
  assert.equal(calls.listParent, 'caller-1');
});

test('D6：已停下且不可续的子代理拒改（写了也不会被读到）', async () => {
  const { services } = fakeServices({
    descendants: [{ id: 'child-1', parentId: 'caller-1', depth: 1, mode: 'one-shot' }],
  });
  await assert.rejects(
    () => setChildPermission({ agent_id: 'child-1', mode: 'read-only' }, fakeExec(), { services: () => services }),
    /不是可续的子代理/,
  );
  // 并给出可行替代：重派一个。
  await assert.rejects(
    () => setChildPermission({ agent_id: 'child-1', mode: 'read-only' }, fakeExec(), { services: () => services }),
    /要它换权限就重派一个/,
  );
});

test('D6：缺 sessionPersistence 时明说写日志需要它', async () => {
  const { services } = fakeServices({ noPersistence: true });
  await assert.rejects(
    () => setChildPermission({ agent_id: 'child-1', mode: 'read-only' }, fakeExec(), { services: () => services }),
    /需要 sessionPersistence 服务/,
  );
});

// ── D7：源码纪律 ──────────────────────────────────────────────────────────────

test('D7：源码里不写死本机绝对路径', () => {
  const sources = ['index.mjs', join('lib', 'permission.mjs')];
  const forbidden = [/[A-Za-z]:\\{1,2}Users([\\/]|$)/, /[A-Za-z]:\\{1,2}dsh([\\/]|$)/i];
  for (const relative of sources) {
    const text = readFileSync(join(repoRoot, relative), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(text), false, `${relative} 命中 ${pattern}`);
    }
  }
});

test('D7：入口三件套齐备，且插件名与 patch 行 id 一致', async () => {
  const text = readFileSync(join(repoRoot, 'index.mjs'), 'utf8');
  assert.match(text, /export const name = 'adg-permission'/);
  assert.match(text, /export const inject = \['tools'\]/);
  assert.match(text, /export function apply\(ctx\)/);

  const patch = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /- id: adg-permission/);
  assert.match(patch, /name: adg-permission/);
});

// ── D8：真定义能跑通一次完整调用（编译面 + 执行面接得上） ─────────────────────

test('D8：经真 defineTool 编译出来的定义，execute 能跑通', async () => {
  const live = new FakeLiveSession('child-1');
  const { services, calls } = fakeServices({ live });
  const tool = createSetChildPermissionTool({ services: () => services });

  // defineTool 契约：编译产物上的 execute 就是要跑的那一次调用。
  const result = await tool.execute({ agent_id: 'child-1', mode: 'danger-full-access' }, fakeExec());

  assert.equal(result.applied, 'live');
  assert.deepEqual(calls.flush, ['child-1']);
  assert.deepEqual(live.appended, [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }]);
});

test('D8：输出渲染出一行人话（不是把对象丢给模型）', () => {
  const tool = createSetChildPermissionTool({ services: () => fakeServices().services });
  const rendered = tool.output.render(
    { agent_id: 'child-1', mode: 'danger-full-access' },
    { agent_id: 'child-1', mode: 'danger-full-access', applied: 'live', note: '会话在跑，下一步就按新模式走' },
  );
  assert.deepEqual(rendered, [{ type: 'text', text: 'child-1 → danger-full-access：会话在跑，下一步就按新模式走' }]);
});