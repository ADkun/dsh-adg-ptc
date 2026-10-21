// adg-delegate 的纯逻辑层：本次工具计划（内置 deny / 未知名剔除 / PTC 保留名拒绝）、
// 委派请求装配、唯一的「可续后台」派发路径（经平台 `startActivation`）+ 创建后窗口的
// 能力面下发（persona / toolFilter 贴到已建立的子代理身上），以及**子代理的提问通道**
// （`ask_user`：把子代理的问题以派它的那个调度者的名义问出去，见文件末尾一节）。
//
// 这里**零 import**：不碰 cordis、不碰文件系统、不碰真会话对象 —— 全是可离线单测的纯函数
// （唯一例外 `readRestrictableNames`，它只读调用方 ctx 上的工具视图，喂假对象同样成立）。
// 见 test/delegate.test.mjs 与 design.md 的 I1..I10。
// 插件的服务解析与注册在 ../index.mjs。

/** 工具名：全 DSH 内唯一；调度 persona 里写的就是这个字符串。 */
export const TOOL_NAME = 'delegate';

/**
 * 工具名：**子代理**的提问通道。平台自带的 `ask_user_question` 只认 live runtime root
 * （子代理调它拿 `DELEGATED_CALLER`），本工具补的就是这一格：子代理调它，问题以
 * **派它的那个调度者**的名义进 `user-questions/request`，于是问题卡片落在用户与调度者
 * 对话的那个会话里 —— 用户答完，子代理当场接着干。
 */
export const ASK_TOOL_NAME = 'ask_user';

/** 子代理 provider 名：与 preset 那条唯一委派行用的同一个（`provider: spawn`）。 */
export const SUBAGENT_PROVIDER = 'spawn';

/** 子代理的来源词表：本插件只产出可续子代理（平台的 startActivation 对 in-process provider 只有这一条路）。 */
export const SUBAGENT_KINDS = Object.freeze(['continuable']);

/**
 * 内置 deny 名单（安全边界，硬编码）：这些名字**永远**不进子代理的工具面，
 * 即使调用方在 `tools` 里点名要它们。清单只此一份，别在别处再拼一遍。
 *
 * 前四个是**能再开子代理**的入口 —— 放进任何一个，"一跳可达"当场失效：
 * - `agent`：preset 的 delegation 组里那条**静态**委派行的 toolName，子代理会从祖先层继承到它。
 * - `delegate`：本插件的入口，同一个委派机制的**动态**版。
 * - `workflow` / `ralph`：编排引擎，都能起子代理（`ralph` 那行的 config 是 `subagentProvider: spawn`）。
 *
 * 后两个只认 live runtime root：
 * - `set_child_permission` / `ask_user_question`：子代理拿不到人类答主，也没有"自己派出去的子代理"这回事。
 *
 * 刻意**不在**名单里的两个：
 * - `notify_user`：单向、不阻塞的提醒，`notify/design.md` 与 `preset/design.md` 的 R20 明确允许
 *   "让拿到 `notify_user` 的它自己发一条单向提醒"。
 * - `ask_user`（本插件自己的第二个工具）：它**就是**给子代理用的提问通道 —— 子代理撞上登录墙
 *   时直接问用户，问题卡片落在调度者的会话里（见本文件末尾与 design.md 的 I11）。
 *   `ask_user_question` 仍然留在名单里：它只认 live runtime root，子代理调它只会拿 `DELEGATED_CALLER`。
 */
export const BUILTIN_DENY = Object.freeze([
  'agent',
  'delegate',
  'workflow',
  'ralph',
  'set_child_permission',
  'ask_user_question',
]);

/**
 * PTC 传输保留名。它出现在 `toolFilter` 的 allow 或 deny 里，平台的 `tools.restrict()`
 * 都会直接抛错（`cannot name reserved PTC mode presentation transport "run_code"`），
 * 所以本插件**替它挡在前面**：调用方点名它，本工具当场拒绝（口径与理由见 design.md 的 I5）。
 */
export const RESERVED_PTC_NAME = 'run_code';

/**
 * 调用方（调度）智能体。没有它就没有"派出去"这回事 —— 与平台 subagent 工具同一条口径。
 * @param {{agent?: object}} [exec] 工具执行上下文
 * @param {string} [toolName] 报错时用的工具名（`ask_user` 与 `delegate` 共用这段断言）
 * @returns {object} 调用方 Agent
 */
export function assertCallerAgent(exec, toolName = TOOL_NAME) {
  const parent = exec?.agent;
  if (parent === undefined) {
    throw new Error(`${toolName}: 需要一个调用方智能体（exec.agent 是 undefined）`);
  }
  return parent;
}

/**
 * 本次**可用的全局工具名** = 调用方工具视图里的 `restrictableNames`。
 *
 * 这就是平台的 `tools.restrict()` 拿来做未知名校验的那张对照表 —— 本工具只是替它挡在前面，
 * 让调用方当场拿到「哪个名字不成立」的反馈，而不是等子代理建立时才炸。
 *
 * 读不出就**抛错**，不猜也不跳过（fail-closed）：内置 deny 是安全边界，而名单里可能含
 * 本 profile 未注册的名字（例如没装 `@deepseek-ai/dsh-tool-workflow` 就没有 `workflow`，
 * 没装 `adg-permission` 就没有 `set_child_permission`）；没有对照表就既
 * 保证不了边界、又可能下发一个平台会抛 `names unknown global tool` 的名字。
 *
 * @param {object} parent 调用方 Agent（`exec.agent`）
 * @returns {Set<string>} 本次可用的全局工具名
 */
export function readRestrictableNames(parent) {
  const tools = parent?.ctx?.tools;
  const view = tools?.view;
  if (typeof view !== 'function') {
    throw new Error(
      `${TOOL_NAME}: 读不出本次可用的全局工具名（exec.agent.ctx.tools.view 不是函数，API 形状变了）` +
        ' —— 拒绝在无法校验工具名、也无法安全下发内置 deny 名单的前提下委派',
    );
  }
  const read = view.call(tools, parent);
  const names = read?.restrictableNames;
  if (!(names instanceof Set) || names.size === 0) {
    throw new Error(
      `${TOOL_NAME}: 读不出本次可用的全局工具名` +
        `（tools.view(agent).restrictableNames 不是非空 Set，读到 ${describeValue(names)}）—— 拒绝委派`,
    );
  }
  return names;
}

/**
 * 把调用方给的 `tools` 与本次可用的全局工具名对照，算出这次真正下发的 `toolFilter`。
 *
 * 语义（与平台 `ToolRestriction` 同形，两者都是"只减不增"）：
 * - `tools` 省略 ⇒ 只下发 `{deny: <内置名单∩可用名>}`，子代理拿到它继承到的全部减去那几项。
 * - `tools` 给了 ⇒ 下发 `{allow: <清单∩可用名>, deny: <内置名单∩可用名>}`，先按 deny 去掉、再按 allow 只留。
 * - `tools` 是空数组 ⇒ `{allow: [], …}`：什么都不给。
 *
 * 三条处理口径（`ignored` 与 `tools` 一起回显给调用方，**不静默丢弃**）：
 * - 对照表里没有的名字 → `reason: 'unknown'`，剔除并写进 tools_note；
 * - 内置 deny 名单里的名字 → `reason: 'denied'`，剔除并写进 tools_note；
 * - `run_code` → **抛错**（唯一会让整次调用失败的名单项，理由见 design.md 的 I5）。
 *
 * @param {unknown} requested `args.tools` 原值
 * @param {Set<string>} knownNames 本次可用的全局工具名
 * @returns {{provided: boolean, denyNames: string[], tools: string[], ignored: {name: string, reason: 'unknown'|'denied'}[], filter: {allow?: string[], deny: string[]}|undefined}}
 */
export function planToolFilter(requested, knownNames) {
  if (!(knownNames instanceof Set)) {
    throw new Error(`${TOOL_NAME}: 内部错误 —— 可用工具名清单必须是 Set（got ${describeValue(knownNames)}）`);
  }
  if (requested !== undefined && !Array.isArray(requested)) {
    throw new Error(`${TOOL_NAME}: tools 必须是字符串数组（got ${describeValue(requested)}）`);
  }

  // 内置名单必须与本次可用名**求交**：未注册的名字写进 deny 会让平台当场抛
  // `tools.restrict() names unknown global tool …`，整次委派失败。
  const denyNames = BUILTIN_DENY.filter((toolName) => knownNames.has(toolName));

  if (requested === undefined) {
    return {
      provided: false,
      denyNames,
      tools: [],
      ignored: [],
      // 一个名字都减不掉时（这六个名字都不在本 profile）就没有要下发的滤镜。
      filter: denyNames.length === 0 ? undefined : { deny: denyNames },
    };
  }

  const tools = [];
  const ignored = [];
  const seen = new Set();
  for (const raw of requested) {
    if (typeof raw !== 'string' || raw === '') {
      throw new Error(`${TOOL_NAME}: tools 里只能放工具名字符串（got ${describeValue(raw)}）`);
    }
    if (raw === RESERVED_PTC_NAME) {
      throw new Error(
        `${TOOL_NAME}: 拒绝把 ${RESERVED_PTC_NAME} 放进本次工具面 —— 它是 PTC 传输保留名，` +
          '平台的 tools.restrict() 对它直接抛错；要限制的是工具，不是承载它们的传输。',
      );
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (BUILTIN_DENY.includes(raw)) {
      // 先判内置名单：这些名字给不了子代理是**本次设计**，不是本 profile 的偶然缺装。
      ignored.push({ name: raw, reason: 'denied' });
      continue;
    }
    if (!knownNames.has(raw)) {
      ignored.push({ name: raw, reason: 'unknown' });
      continue;
    }
    tools.push(raw);
  }

  return { provided: true, denyNames, tools, ignored, filter: { allow: tools, deny: denyNames } };
}

/**
 * `tools_note`：一句人话，说明这次是"未过滤 = 拿到继承到的全部"还是"只保留 N 个"，
 * 并列出被忽略的点名（未知名 / 内置禁用）。这是给模型看的反馈，不是日志。
 *
 * @param {ReturnType<typeof planToolFilter>} plan
 * @returns {string}
 */
export function toolsNote(plan) {
  const parts = [];
  if (!plan.provided) {
    parts.push(
      plan.denyNames.length === 0
        ? '未过滤：子代理拿到它继承到的全部工具（本次没有需要减去的内置名单项）'
        : `未过滤：子代理拿到它继承到的全部工具（另按内置 deny 名单减去 ${plan.denyNames.length} 项：${plan.denyNames.join('、')}）`,
    );
  } else if (plan.tools.length === 0) {
    parts.push('空清单：本次不给子代理任何工具');
  } else {
    parts.push(`只保留 ${plan.tools.length} 个：${plan.tools.join('、')}`);
  }
  if (plan.ignored.length > 0) {
    const described = plan.ignored.map(
      (item) => `${item.name}（${item.reason === 'denied' ? '内置禁用' : '这次没有这个工具名'}）`,
    );
    parts.push(`忽略了 ${plan.ignored.length} 个点名的名字：${described.join('、')}`);
  }
  return parts.join('；');
}

/**
 * 装配子代理委派请求。**永远不设 `maxDepth`**：平台默认 1，一跳可达由「内置 deny `delegate`」
 * 与这个默认值共同保证（preset 侧红线 6 是同一口径）。
 *
 * 平台契约（0.2.x `SubagentStartRequest`）：`request` 里只有 `prompt` 与 `parent` ——
 * `label` 与 `signal` 都在 `SubagentActivationSpec` 上、不进 request；**没有**
 * persona / toolFilter 字段（`startLocal` 组装子代理 composition 时只带 agentPreset），
 * 所以这次的能力面走创建后窗口（`applyChildFace`），不塞进 request。
 *
 * @param {{description: string, prompt: string}} args
 * @param {object} parent 调用方 Agent
 * @returns {object} `Omit<SubagentStartRequest, 'label' | 'signal'>` 形状
 */
export function buildRequest(args, parent) {
  return {
    prompt: [{ type: 'text', text: args.prompt }],
    parent,
  };
}

/**
 * 可续子代理的 `childId`。取不到就抛错，绝不回显一个 undefined 当成功。
 * @param {unknown} started `startActivation` 的返回值
 * @returns {string}
 */
export function continuableChildId(started) {
  const childId = started?.childId;
  if (typeof childId !== 'string' || childId === '') {
    throw new Error(
      `${TOOL_NAME}: startActivation 没有返回 childId（got ${describeValue(childId)}）` +
        ' —— 子代理可能已建立，但没有可接续的 id，不能当成成功回报',
    );
  }
  return childId;
}

/**
 * 把这次委派的能力面（persona / toolFilter）贴到**已建立**的子代理身上。
 *
 * 平台 0.2.x 把 per-child 组合从委派缝隙里拿掉了：`SubagentStartRequest` 没有
 * persona / toolFilter 字段，`startLocal` 组装 composition 时只带 agentPreset，
 * 平台参考实现（tool-subagent）也把这件事挪进了 Agent Preset。本插件要保住
 * 「每一次委派现给工具面与 persona」，只能用创建后窗口：子代理的 ctx 是 scoped 的，
 * `tools.restrict()` 与 `systemPrompt.section()` 都活生效 —— 它第一轮请求的
 * 系统提示词与工具目录在这之后才装配。形状与平台 `applyChildOverrides` 一致：
 * persona 注册成 `deployment:persona-prefix` 段（遮蔽部署 persona），toolFilter
 * 走 `tools.restrict()`（名字已在调用方视图上校验过，只减不增）。
 *
 * @param {object|undefined} child 子代理 Agent（`agents.get(childId)` 的活实例）
 * @param {{persona?: string, filter?: {allow?: string[], deny: string[]}}} face
 * @returns {string[]} 实际施加的项目（'toolFilter' / 'persona'）
 */
export function applyChildFace(child, { persona, filter } = {}) {
  if (child === undefined || child?.ctx === undefined) {
    throw new Error(
      `${TOOL_NAME}: 建立子代理后取不到它的活实例（agents.get 返回 ${describeValue(child)}）` +
        ' —— 这次的能力面与 persona 下不去，不能当成成功回报',
    );
  }
  const applied = [];
  if (filter !== undefined) {
    if (typeof child.ctx.tools?.restrict !== 'function') {
      throw new Error(
        `${TOOL_NAME}: 子代理 ctx.tools.restrict 不是函数（API 形状变了）—— ` +
          '工具面下不去，拒绝把没受限的子代理当成「已按清单下发」回报',
      );
    }
    child.ctx.tools.restrict(filter);
    applied.push('toolFilter');
  }
  if (persona !== undefined) {
    const systemPrompt = child.ctx.systemPrompt;
    if (typeof systemPrompt?.section !== 'function' || typeof systemPrompt?.getSectionOrder !== 'function') {
      throw new Error(
        `${TOOL_NAME}: 子代理 ctx.systemPrompt.section 不可用（API 形状变了）—— ` +
          'persona 下不去，拒绝把「没给 persona」当成「给了」回报',
      );
    }
    systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: persona,
    });
    applied.push('persona');
  }
  return applied;
}

/**
 * 跑一次委派。抽出来是为了自测能直接喂假服务与假调用方（不起 cordis、不碰真会话）。
 *
 * @param {{description: string, prompt: string, tools?: string[], persona?: string, background?: boolean}} args
 * @param {{agent?: object, signal?: AbortSignal}} exec 工具执行上下文
 * @param {{services?: () => object, rememberChild?: (childId: string, parent: object) => void}} [deps]
 * @returns {Promise<{description: string, subagent_id: string, kind: string, tools: string[], tools_note: string, persona: 'set'|'unset'}>}
 */
export async function delegate(args, exec, deps = {}) {
  const parent = assertCallerAgent(exec);
  const knownNames = readRestrictableNames(parent);
  const plan = planToolFilter(args.tools, knownNames);
  const signal = exec?.signal;

  // 前台一次性路径在本机 dsh 版本里不存在：SubagentRuntime 没有 start / startContinuable，
  // 唯一入口 startActivation 对 in-process provider（spawn 声明了 prepareContinuable）
  // 一律走可续的 startLocal。与其静默把「前台」建成可续，不如当场说清。
  if (args.background === false) {
    throw new Error(
      `${TOOL_NAME}: background:false（前台一次性）在当前 dsh 版本不可用 —— ` +
        'SubagentRuntime 只暴露 startActivation，spawn provider 一律产出可续子代理；用缺省的后台可续委派。',
    );
  }

  const subagents = requireSubagents(deps);
  const request = buildRequest(args, parent);
  const started = await subagents.startActivation({
    provider: SUBAGENT_PROVIDER,
    label: args.description,
    request,
    signal,
    delivery: 'parent',
  });
  const childId = continuableChildId(started);

  // 能力面在创建后窗口贴上去；贴失败就当场回收这个子代理再抛错 —— 绝不把「没受限」当成功。
  const face = { persona: args.persona, filter: plan.filter };
  if (face.persona !== undefined || face.filter !== undefined) {
    try {
      const agents = deps.services?.()?.agents;
      if (typeof agents?.get !== 'function') {
        throw new Error(
          `${TOOL_NAME}: 需要 agents 服务（@deepseek-ai/dsh-agent 的 AgentRegistry）` +
            '来取回刚建立的子代理并下发这次的能力面',
        );
      }
      applyChildFace(agents.get(childId), face);
    } catch (error) {
      try {
        await started.dispose?.();
      } catch {
        /* 回收失败不掩盖原始错误：真正要报的是能力面那一条 */
      }
      throw error;
    }
  }

  // 留一条配对：子代理后来调 `ask_user` 时，靠它把问题以**你**的名义问出去（I13）。
  deps.rememberChild?.(childId, parent);
  return delegationResult(args, 'continuable', childId, plan);
}

/**
 * 本工具结果。`tools` 回显真的下发的清单（省略 tools 时是空数组，清单在 tools_note 里讲清）。
 * @returns {{description: string, subagent_id: string, kind: string, tools: string[], tools_note: string, persona: 'set'|'unset'}}
 */
function delegationResult(args, kind, subagentId, plan) {
  return {
    description: args.description,
    subagent_id: subagentId,
    kind,
    tools: plan.tools,
    tools_note: toolsNote(plan),
    persona: args.persona === undefined ? 'unset' : 'set',
  };
}

/**
 * `subagents` 服务（`@deepseek-ai/dsh-subagent` 的 `SubagentRuntime`）。
 * 不解析 `jobs`：本插件只走 startActivation 的可续路径，**没有**"后台一次性"那条路径（design.md 的 I4）。
 */
function requireSubagents(deps) {
  const services = deps.services?.() ?? {};
  if (services.subagents === undefined) {
    throw new Error(`${TOOL_NAME}: 需要 subagents 服务（@deepseek-ai/dsh-subagent 的 SubagentRuntime）`);
  }
  return services.subagents;
}

/**
 * 诊断用的值描述。读不出东西时要能说清"读到了什么"，而不是只说"读不出"。
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Set) return `Set(size=${value.size})`;
  if (Array.isArray(value)) return `Array(length=${value.length})`;
  return typeof value;
}

// ── 子代理的提问通道（`ask_user`）────────────────────────────────────────────
// 为什么需要它：平台的 `ask_user_question` 在带上调用者 agent 时只认 live runtime root
// （`dsh-user-questions` 的 `assertLiveRoot`），被委派的子代理拿到的是 `DELEGATED_CALLER` ——
// 「human interaction is unavailable while the calling agent is owned by another live agent;
// include the unresolved question or decision in the child agent's final result」。
// 于是登录墙 / 验证码这类**必须由人解决**的阻塞点只能靠调度者中转，或者靠子代理发一条
// 单向通知 + 轮询。本工具把这条路修直：提问的 owner 用**派它的那个调度者**，
// `user-questions/request` 就被 scope 到调度者的会话上，问题卡片出现在用户与调度者对话的
// 那个会话里；用户答完，`ask()` 的 Promise 落地，子代理当场接着干。
//
// 边界（刻意如此）：本工具**不改平台源码**、不绕过 `assertLiveRoot` —— 它交给服务的就是一个
// 真的 live runtime root（调度者），服务侧的每一条断言都照旧成立。

/**
 * 进程内的「子代理 → 派它的那个智能体」配对表。
 *
 * 本插件是全 DSH 里**唯一**的委派入口（preset 的 delegation 组只有一行，且子代理拿不到
 * `delegate`），所以每一次委派的 childId 都在这里留一条：子代理后来调 `ask_user` 时，
 * 靠它把问题以调度者的名义问出去。
 *
 * 表是进程内的：dsh 重启后旧配对丢失，那时子代理会拿到一条说清"问不到人、把未决问题写进
 * 最终结果"的报错 —— 与它调 `ask_user_question` 得到的指引一致，不是死路。
 *
 * @returns {{remember: (childId: unknown, parent: object|undefined) => void, ownerIdOf: (childId: unknown) => string|undefined, size: () => number}}
 */
export function createOwnerIndex() {
  const owners = new Map();
  return {
    remember(childId, parent) {
      if (typeof childId !== 'string' || childId === '') return;
      const ownerId = parent?.id;
      if (typeof ownerId !== 'string' || ownerId === '') return;
      owners.set(childId, ownerId);
    },
    ownerIdOf(childId) {
      return typeof childId === 'string' ? owners.get(childId) : undefined;
    },
    size() {
      return owners.size;
    },
  };
}

/**
 * 这次提问该以谁的名义问。
 *
 * - 调用方是**调度者自己**（配对表里没有它 / owner 就是它）⇒ 以它自己的名义问（等价于
 *   `ask_user_question` 的语义，`asked_as: 'self'`）。
 * - 调用方是**被委派的子代理** ⇒ 交给派它的那个智能体（`asked_as: 'scheduler'`）——
 *   问的是同一个人的同一个会话，只是 owner 换成了有权问的那个活 root。
 *
 * 拿不到 owner 的活实例就**抛错**，不悄悄退化成"以子代理自己的名义问"：那会当场撞
 * `DELEGATED_CALLER`，报错反而离病灶更远。错误文本要自己说清下一步（把未决问题写进最终结果）。
 *
 * @param {object} caller 调用方 Agent（子代理或调度者）
 * @param {string|undefined} ownerId 配对表里记的调度者 id
 * @param {object|undefined} agents `agents` 服务（AgentRegistry）
 * @returns {object} 提问时该传的 owner Agent
 */
export function resolveAskOwner(caller, ownerId, agents) {
  if (ownerId === undefined || ownerId === caller.id) return caller;
  if (agents === undefined || typeof agents.get !== 'function') {
    throw new Error(
      `${ASK_TOOL_NAME}: 需要 agents 服务（@deepseek-ai/dsh-agent 的 AgentRegistry）` +
        `来把提问交还给委派你的那个智能体（owner ${ownerId}）`,
    );
  }
  const owner = agents.get(ownerId);
  if (owner === undefined) {
    throw new Error(
      `${ASK_TOOL_NAME}: 委派你的调度者（agent ${ownerId}）此刻不是活着的会话，问不到人 —— ` +
        '把未决问题与可选项写进你的最终结果，让调度者去问用户。',
    );
  }
  return owner;
}

/**
 * 把模型给的问题翻译成用户提问服务的请求形状（与平台 `ask_user_question` 的翻译同形，
 * 只多一个"owner 换成调度者"的参数）。
 *
 * 必填与唯一性在**这里**判：`ask()` 自己只判"至少一个问题"与重复 id，问题正文缺失会让
 * 卡片显示成空白 —— 那是最难排查的一类失败，宁可当场抛错。
 *
 * @param {unknown} questions `args.questions`
 * @param {object} agent 提问的 owner（`resolveAskOwner` 的结果）
 * @param {AbortSignal|undefined} signal 工具调用被中断时用来取消等待
 * @returns {object} `userQuestions.ask` 的请求
 */
export function questionRequest(questions, agent, signal) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(`${ASK_TOOL_NAME}: questions 至少要有 1 个问题`);
  }
  const seen = new Set();
  const mapped = questions.map((question) => {
    const id = question?.id;
    if (typeof id !== 'string' || id === '') {
      throw new Error(`${ASK_TOOL_NAME}: 每个问题都要有非空的字符串 id`);
    }
    if (seen.has(id)) {
      throw new Error(`${ASK_TOOL_NAME}: 问题 id ${JSON.stringify(id)} 在这次调用里出现了两次`);
    }
    seen.add(id);
    const text = question?.question;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error(`${ASK_TOOL_NAME}: 问题 ${JSON.stringify(id)} 缺少 question 正文`);
    }
    return {
      id,
      question: text,
      ...(question.header !== undefined ? { header: question.header } : {}),
      ...(question.options !== undefined ? { options: question.options.map((option) => ({ ...option })) } : {}),
      ...(question.multi_select !== undefined ? { multiSelect: question.multi_select } : {}),
    };
  });
  return { questions: mapped, agent, signal };
}

/**
 * 把服务返回的答案拷成模型可见的结果（**脱拷贝**：不把服务自己的数组交出去）。
 * @param {unknown} result `userQuestions.ask` 的返回值
 * @returns {{id: string, selected: string[], custom?: string}[]}
 */
export function answerResult(result) {
  const answers = result?.answers;
  if (!Array.isArray(answers)) {
    throw new Error(`${ASK_TOOL_NAME}: 用户提问服务没有返回 answers 数组（got ${describeValue(answers)}）`);
  }
  return answers.map((answer) => ({
    id: answer.id,
    selected: [...answer.selected],
    ...(answer.custom !== undefined ? { custom: answer.custom } : {}),
  }));
}

/**
 * 跑一次提问。抽出来同样是为了自测能直接喂假服务与假调用方。
 *
 * @param {unknown} questions `args.questions`
 * @param {{agent?: object, signal?: AbortSignal}} exec 工具执行上下文
 * @param {{services?: () => object, ownerIdOf?: (childId: string) => string|undefined}} [deps]
 * @returns {Promise<{answers: {id: string, selected: string[], custom?: string}[], asked_as: 'self'|'scheduler'}>}
 */
export async function askUser(questions, exec, deps = {}) {
  const caller = assertCallerAgent(exec, ASK_TOOL_NAME);
  const services = deps.services?.() ?? {};
  const owner = resolveAskOwner(caller, deps.ownerIdOf?.(caller.id), services.agents);
  const userQuestions = services.userQuestions;
  if (typeof userQuestions?.ask !== 'function') {
    throw new Error(
      `${ASK_TOOL_NAME}: 需要 userQuestions 服务（@deepseek-ai/dsh-user-questions 的 UserQuestionService）` +
        ' —— 这个 profile 没装工具化的用户提问链路',
    );
  }
  const result = await userQuestions.ask(questionRequest(questions, owner, exec?.signal));
  return { answers: answerResult(result), asked_as: owner.id === caller.id ? 'self' : 'scheduler' };
}