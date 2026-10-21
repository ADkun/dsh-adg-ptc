// adg-permission 的 cordis 插件入口：注册 `set_child_permission`。
//
// 入口形状由 dsh 的插件契约规定：
//   - 命名导出 `name` / `inject` / `apply`（契约要求的入口三件套）
//   - `name` 必须与 cordis.patch.yml 里 insert 行的 `id` 一致
//   - 工具定义走 `defineTool`（`output` 是硬要求，缺了直接 TypeError）
//
// 本文件只做「解析服务 + 派发两条路径」；纯逻辑在 lib/permission.mjs，可离线自测。
// 契约与红线见 AGENTS.md / design.md。

import { defineTool } from '@deepseek-ai/dsh-tools';

import { SANDBOX_MODES, assertNotWidening, isSandboxMode, sandboxModeEvent } from './lib/permission.mjs';

/** 插件名：必须等于 cordis.patch.yml 里 insert 行的 `id`。 */
export const name = 'adg-permission';

/** 本插件只依赖 tools 服务；其余服务（sessions / subagents / sandboxPolicy / sessionPersistence）
 *  在**调用那一刻**才 `ctx.get` —— 缺哪个就报哪个，而不是让整个 profile 起不来。 */
export const inject = ['tools'];

/** 工具名：全 DSH 内唯一；调度 persona 里写的就是这个字符串。 */
export const TOOL_NAME = 'set_child_permission';

/**
 * 工具描述。写给「一眼判断何时该用、以及它不会做什么」：
 * 用在「用户刚把本会话切到完全权限，而那个子代理是切换之前派出去的」这种场合。
 * 两条硬约束（血缘 + 单调）都在代码里拦，明写出来是为了让调度者不必靠试错去发现。
 */
const DESCRIPTION = [
  '把某个子代理的文件权限改到指定模式，用在「本会话刚被切到完全权限，而那个子代理是切换之前派出去的」这类场合：',
  '升级**已经派出去**的子代理，不必停掉再重派。两条硬约束（都在代码里拦，不靠自觉）：',
  '①只能改**你自己派出去的**子代理（血缘校验）；②**不得超过你自己当前的权限**（你自己是 read-only 时，连 workspace-write 都改不上去）。',
  '运行中的子代理立刻生效 —— 它下一次受限调用就按新模式走；已停下的子代理写进它的会话日志，下次恢复它时生效。',
  'approval 一律不动：子代理恒为 never，没有人能替它点同意。',
].join(' ');

/** 输出 schema：工具结果就是这四个字段。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', required: true, description: '被改的那个子代理会话 id' },
    mode: { type: 'string', required: true, enum: [...SANDBOX_MODES], description: '它现在的文件权限模式' },
    applied: {
      type: 'string',
      required: true,
      enum: ['live', 'persisted'],
      description: 'live = 会话在跑，下一步就按新模式走；persisted = 会话已停下，模式已写进它的日志，下次恢复时生效',
    },
    note: { type: 'string', required: true, description: '一句人话，说明这次改动的生效时机' },
  },
};

/**
 * 造出 `set_child_permission` 的工具定义。
 * 单独导出是为了让自测能用**真的** `defineTool` 造一遍定义 —— 作者侧 schema 方言
 * 写错时，真 `defineTool` 会当场抛 `JsonSchemaError`（见 design.md 的 D1）。
 *
 * @param {{defineTool?: Function, services?: () => object}} [deps]
 * @returns {object} dsh-tools 的 ToolDefinition
 */
export function createSetChildPermissionTool(deps = {}) {
  // 允许注入 `defineTool` 只是为了自测能拿真实现再编译一遍；运行时永远用真货。
  const compile = deps.defineTool ?? defineTool;

  return compile({
    name: TOOL_NAME,
    description: DESCRIPTION,
    // 作者侧方言是**隐式属性映射**（key 就是属性名），不是对象根 JSON Schema：
    // 写成 `{type:'object',properties:{…}}` 会被 `parameterSchemaSpecToJsonSchema` 拒掉
    // （`parameters.type must be a value schema object`）。必填由属性上的 `required: true` 表达。
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: '目标子代理的会话 id —— 就是 list_agents 或子代理结算通知里那个 id。只能填你自己派出去的。',
      },
      mode: {
        type: 'string',
        required: true,
        enum: [...SANDBOX_MODES],
        description: '要改成哪个模式。不得超过你自己当前的权限（三级序 read-only < workspace-write < danger-full-access）。',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `${value.agent_id} → ${value.mode}：${value.note}` }],
    },
    // 它会改另一个会话的日志，不是只读操作 —— 别和别的工具并发跑。
    isConcurrencySafe: () => false,
    timeoutMs: 30000,
    async execute(args, exec) {
      return setChildPermission(args, exec, deps);
    },
  });
}

/**
 * 跑一次改权限。
 * 抽出来是为了自测能直接喂假服务（不起 cordis、不碰磁盘、不碰真会话）。
 *
 * @param {{agent_id: string, mode: string}} args
 * @param {{agent?: object, signal?: AbortSignal}} exec 工具执行上下文
 * @param {{services?: () => object}} [deps]
 * @returns {Promise<{agent_id: string, mode: string, applied: 'live'|'persisted', note: string}>}
 */
export async function setChildPermission(args, exec, deps = {}) {
  const caller = exec?.agent;
  if (caller === undefined) {
    // 没有调用方就没有"它派出去的子代理"这回事。
    throw new Error(`${TOOL_NAME}: 需要一个调用方智能体（exec.agent 是 undefined）`);
  }

  const { sessions, subagents, sandboxPolicy, sessionPersistence } = deps.services?.() ?? {};
  if (subagents === undefined || sessions === undefined) {
    throw new Error(
      `${TOOL_NAME}: 需要 subagents 与 sessions 两个服务（@deepseek-ai/dsh-subagent / @deepseek-ai/dsh-session）`,
    );
  }

  const mode = args.mode;
  // 先过单调守卫再动任何东西：读不出调用方自己的权限就拒绝，不猜。
  assertNotWidening(callerSandboxMode(sandboxPolicy, caller), mode);

  const target = await findOwnDescendant(subagents, caller, args.agent_id, exec?.signal);
  const live = sessions.get(target.id);

  if (live !== undefined) {
    // 会话在内存里：直接往它的日志追加一条 `sandbox/mode`，下一次受限调用就按新模式解析。
    live.append('sandbox/mode', { mode });
    await sessions.flush(live);
    return {
      agent_id: target.id,
      mode,
      applied: 'live',
      note: '会话在跑，下一步就按新模式走',
    };
  }

  if (target.mode !== 'continuable') {
    throw new Error(
      `${TOOL_NAME}: ${JSON.stringify(target.id)} 不是可续的子代理（mode=${String(target.mode)}），` +
        '写进它日志的模式永远不会再被读到 —— 要它换权限就重派一个',
    );
  }
  if (sessionPersistence === undefined) {
    throw new Error(
      `${TOOL_NAME}: 目标子代理已停下，写它的日志需要 sessionPersistence 服务（@deepseek-ai/dsh-session-persistence）`,
    );
  }

  await appendModeToStoredSession(sessionPersistence, target.id, mode, exec?.signal);
  return {
    agent_id: target.id,
    mode,
    applied: 'persisted',
    note: '会话已停下，模式已写进它的会话日志，下次恢复它（send_message）时生效',
  };
}

/**
 * 调用方**当前**的文件权限模式。
 * 会话有效模式 = 该会话最后一次 `sandbox/mode` 折叠值，缺省时回落部署默认值 ——
 * 这正是模型上下文里那行 `Current DSH file policy:` 的来源，两边必须同一个读数。
 */
function callerSandboxMode(sandboxPolicy, caller) {
  if (sandboxPolicy === undefined) {
    throw new Error(`${TOOL_NAME}: 读不到调用方的文件权限（缺 sandboxPolicy 服务）—— 拒绝改权限`);
  }
  const session = caller.session;
  if (session === undefined) {
    throw new Error(`${TOOL_NAME}: 调用方没有会话（caller.session 是 undefined）—— 拒绝改权限`);
  }
  const mode = sandboxPolicy.resolve({ session })?.mode;
  if (!isSandboxMode(mode)) {
    throw new Error(`${TOOL_NAME}: 读不出调用方自己的文件权限（got ${String(mode)}）—— 拒绝改权限`);
  }
  return mode;
}

/**
 * 在**自己**的子代理树里找目标。
 * 血缘用 `listDescendants` 判 —— 它是父会话自己日志里 `subagent/catalog` 的折叠结果，
 * 所以"不是我的子代理"根本不会出现在这张表里，不需要另写一套比对。
 */
async function findOwnDescendant(subagents, caller, agentId, signal) {
  const entries = await subagents.listDescendants(caller.id, signal);
  const target = (entries ?? []).find((entry) => entry !== undefined && entry.id === agentId);
  if (target === undefined || target.kind === 'diagnostic') {
    throw new Error(
      `${TOOL_NAME}: ${JSON.stringify(String(agentId))} 不是你派出去的子代理（id 从 list_agents 取）`,
    );
  }
  return target;
}

/**
 * 往一个**已经停下**的会话日志里追加一条 `sandbox/mode`。
 *
 * 走持久化层而不是 `session.append()`：非活跃会话已从内存会话表脱离，
 * `ctx.sessions.get()` 取不到它，`sessions.flush()` 也会抛 `… is not live in this store`。
 * 写句柄会拿到跨进程写租约（别人持有就抛 `already owned`），所以这一段是安全的；
 * 事件信封与 seq 由本插件自己给（持久化层只校验连续，不替你编号）。
 */
async function appendModeToStoredSession(sessionPersistence, id, mode, signal) {
  const options = signal === undefined ? {} : { signal };
  const handle = await sessionPersistence.open(id, 'write', options);
  try {
    const stored = await handle.read(0, void 0, options);
    // 会话日志里 seq 恒等于下标（dsh-session 的 `Session.seq` 就是这么算的），下一个就是条数。
    await handle.append([sandboxModeEvent(mode, stored.events.length, Date.now())]);
    await handle.flush(options);
  } finally {
    // 关句柄失败不该盖掉主错误：真正要报的是上面那条。
    try {
      await handle.close();
    } catch {
      /* 故意吞掉：见上 */
    }
  }
}

/**
 * 注册 `set_child_permission`。
 * 服务在**每次调用**时现取：注册顺序、以及某些服务是否挂载，都不该由 apply 时机决定。
 * @param {object} ctx cordis 上下文（global 层）
 */
export function apply(ctx) {
  ctx.tools.register(
    createSetChildPermissionTool({
      services: () => ({
        sessions: ctx.get('sessions'),
        subagents: ctx.get('subagents'),
        sandboxPolicy: ctx.get('sandboxPolicy'),
        sessionPersistence: ctx.get('sessionPersistence'),
      }),
    }),
  );
  ctx.logger?.debug?.(`[${name}] 已注册 ${TOOL_NAME}`);
}