// adg-delegate 的 cordis 插件入口：注册全局工具 `delegate`。
//
// 入口形状由 dsh 的插件契约规定：
//   - 命名导出 `name` / `inject` / `apply`（契约要求的入口三件套）
//   - `name` 必须与 cordis.patch.yml 里 insert 行的 `id` 一致
//   - 工具定义走 `defineTool`（`output` 是硬要求，缺了直接 TypeError）
//
// 本文件只做「解析服务 + 派发」；纯逻辑（工具计划、请求装配、两条路径）在 lib/delegate.mjs，
// 可离线自测。契约与红线见 AGENTS.md / design.md。

import { defineTool } from '@deepseek-ai/dsh-tools';

import { ASK_TOOL_NAME, SUBAGENT_KINDS, TOOL_NAME, askUser, createChildFaces, createOwnerIndex, delegate } from './lib/delegate.mjs';

/** 插件名：必须等于 cordis.patch.yml 里 insert 行的 `id`。 */
export const name = 'adg-delegate';

/** 本插件只依赖 tools 服务；其余服务（subagents）在**调用那一刻**才 `ctx.get` ——
 *  缺哪个就报哪个，而不是让整个 profile 起不来。 */
export const inject = ['tools'];

export { ASK_TOOL_NAME, TOOL_NAME };

/**
 * 工具描述。写给「一眼判断何时该用、以及它做到了平台自带的 subagent 工具做不到的那件事」：
 * 平台每个 subagent 实例的 toolFilter 在**挂载期**写死，而本工具在**每一次委派**时现给。
 */
const DESCRIPTION = [
  '派一个子代理去做一件事，并**在这一次委派**指定它拿到的工具集合与 persona（这是平台自带委派做不到的：那边的滤镜在挂载期就写死了）。要按任务现配能力面就用本工具，别用那条挂载期写死的静态委派工具。',
  '`tools` 省略 = 不过滤，它拿到自己继承到的全部工具（再减去内置 deny 名单）；给了 = 只保留清单里那些；空数组 = 任务能力一个不给（平台续接通道 send_message 仍在，子代理要靠它回传结果）。',
  '`persona` 省略 = 它没有 persona 段；给了 = 这一次用它遮蔽子代理本来带的 persona。',
  '缺省（也是唯一）路径：派出的是 continuable 子代理，返回可接续、可 steer 的会话 id；`background: false` 在当前 dsh 版本不可用（平台 SubagentRuntime 只暴露 startActivation），给了会当场报错。',
  '清单里不成立的名字**不会**让整次调用失败，会逐条出现在 `tools_note` 里；`run_code` 例外，点名它当场报错。',
  '`agent` / `delegate` / `workflow` / `ralph` / `set_child_permission` / `ask_user_question` 永远不给子代理 —— 前四个都能再开子代理，这一步就是一跳可达；`notify_user`（单向提醒）与 `ask_user`（把子代理的问题问给用户：以你的名义进提问服务，卡片落在你这个会话里）都可以给。',
].join(' ');

/** 输出 schema：工具结果就是这六个字段。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    description: { type: 'string', required: true, description: '回显这次委派的短标签' },
    subagent_id: {
      type: 'string',
      required: true,
      description: '子代理会话 id，拿它去 list_agents / send_message 接续',
    },
    kind: { type: 'string', required: true, enum: [...SUBAGENT_KINDS], description: '这次派出的是哪种来源' },
    tools: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: '本次实际下发的工具清单；`tools` 省略时是空数组（未过滤的意思写在 tools_note 里）',
    },
    tools_note: { type: 'string', required: true, description: '一句人话：这次是"未过滤 = 拿到继承的全部"还是"只保留 N 个"，以及被忽略的点名' },
    persona: { type: 'string', required: true, enum: ['set', 'unset'], description: 'set = 这一次给了 persona；unset = 没给，子代理没有 persona 段' },
  },
};

/**
 * 造出 `delegate` 的工具定义。
 * 单独导出是为了让自测能用**真的** `defineTool` 造一遍定义 —— 作者侧 schema 方言
 * 写错时，真 `defineTool` 会当场抛 `JsonSchemaError`（见 design.md 的 D1）。
 *
 * @param {{defineTool?: Function, services?: () => object, rememberChild?: (childId: string, parent: object) => void}} [deps]
 * @returns {object} dsh-tools 的 ToolDefinition
 */
export function createDelegateTool(deps = {}) {
  // 允许注入 `defineTool` 只是为了自测能拿真实现再编译一遍；运行时永远用真货。
  const compile = deps.defineTool ?? defineTool;

  return compile({
    name: TOOL_NAME,
    description: DESCRIPTION,
    // 作者侧方言是**隐式属性映射**（key 就是属性名），不是对象根 JSON Schema：
    // 写成 `{type:'object',properties:{…}}` 会被 `parameterSchemaSpecToJsonSchema` 拒掉
    // （`parameters.type must be a value schema object`）。必填由属性上的 `required: true` 表达。
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: '短标签：进结算通知与 list_agents，用「谁、做什么」的形状，别写成长句。',
      },
      prompt: {
        type: 'string',
        required: true,
        description:
          '自足的委派正文：目标 / 要做什么 / 不要做什么 / 约束 / 验收标准。子代理看不到你与用户的对话，缺什么它只能猜。',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          '这一次给这个子代理的全局工具名清单。省略 = 不过滤（它拿到继承到的全部，再减去内置 deny 名单）；给了 = 只保留这些；空数组 = 任务能力一个不给（平台续接通道 send_message 仍在）。',
      },
      persona: {
        type: 'string',
        description: '这一次给这个子代理的 persona 文本（遮蔽它本来带的 persona 段）。省略 = 不给 persona 段。',
      },
      background: {
        type: 'boolean',
        description:
          'true（缺省）= 后台可续子代理。false 当前不可用（本机 dsh 的 SubagentRuntime 没有 start，spawn provider 一律可续），给了会当场报错。',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        { type: 'text', text: `${value.description} → ${value.kind} 子代理 ${value.subagent_id}（${value.tools_note}）` },
      ],
    },
    // 它只建立会话并投递初始 prompt，不改任何既有状态 —— 可以并发派发多条。
    isConcurrencySafe: () => true,
    // 本工具**不等待子代理跑完**：等的是「建立 + 投递 + 能力面下发」这一步（子代理 inbox
    // 接受初始 prompt），都是秒级动作。比 permission 的 30 秒小，
    // 因为那边等的是另一个会话的一次完整读写往返。
    timeoutMs: 15000,
    async execute(args, exec) {
      return delegate(args, exec, deps);
    },
  });
}

/**
 * `ask_user` 的工具描述。写给「子代理为什么该用它，而不是另外两条路」：`notify_user` 是单向的
 * （用户看到也回不了话），平台自带的 `ask_user_question` 只认 live runtime root（子代理调它
 * 拿 `DELEGATED_CALLER`）；本工具把问题以**派它的那个调度者**的名义问出去，用户答完子代理当场接着干。
 */
const ASK_DESCRIPTION = [
  '向用户提问并**等答复**。',
  '被委派的子代理调用它时，问题以**派你的那个调度者**的名义进用户提问服务 —— 卡片出现在用户与调度者对话的那个会话里，用户答完你当场继续，不用重派。调度者自己调用它就等于 `ask_user_question`。',
  '登录墙 / 验证码 / 二次验证 / 需要用户拍板：把有头窗口开到需要人的那一步，然后**立刻用本工具问**（例如「登录好了吗」「要不要换一种方式」），别去轮询登录态；`notify_user` 只能单向喊一声，用户没法回你。',
  '一次把相关问题问齐；有明确选项就写 `options`（推荐项放第一个，标签后面加 "(Recommended)"），只有自由文本才不给选项。',
  '它会一直等到用户提交答复（刻意不设超时）；用户不答，这次调用就一直挂着。',
].join(' ');

/**
 * `ask_user` 的输出 schema。
 * `asked_as` 回显这次是**以谁的名义**问的 —— 子代理看到 `scheduler` 就该明白：答复来自用户本人在
 * 调度者会话里提交的那张卡片，不是别人的转述。
 */
const ASK_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    asked_as: {
      type: 'string',
      required: true,
      enum: ['scheduler', 'self'],
      description: 'scheduler = 问题以派你的那个调度者的名义问出去（卡片在它的会话里）；self = 你自己就是提问的 owner',
    },
    answers: {
      type: 'array',
      required: true,
      description: '用户提交的一批答案，每个问题一条；`selected` 与 `custom` 都空 = 用户明确跳过了这个问题',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true, description: '回显问题 id' },
          selected: { type: 'array', required: true, items: { type: 'string' }, description: '用户选中的选项标签' },
          custom: { type: 'string', description: '用户自己写的答案（可选）' },
        },
      },
    },
  },
};

/**
 * 造出 `ask_user` 的工具定义。与 `createDelegateTool` 一样单独导出，让自测用真 `defineTool` 编译一遍。
 *
 * @param {{defineTool?: Function, services?: () => object, ownerIdOf?: (childId: string) => string|undefined}} [deps]
 * @returns {object} dsh-tools 的 ToolDefinition
 */
export function createAskUserTool(deps = {}) {
  const compile = deps.defineTool ?? defineTool;

  return compile({
    name: ASK_TOOL_NAME,
    description: ASK_DESCRIPTION,
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: '要问用户的问题；一次问齐，一个问题一条。',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: '稳定 id；答案按它回显。' },
            question: { type: 'string', required: true, description: '具体要问的话；用用户看得懂的词，别用内部代号。' },
            header: { type: 'string', description: '可选短标题（如「登录」「权限」）。' },
            options: {
              type: 'array',
              description: '可选项。有推荐项就放第一个，并在标签后面加 "(Recommended)"。',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true, description: '短的选项标签。' },
                  description: { type: 'string', description: '一句话说明取舍或影响。' },
                },
              },
            },
            multi_select: { type: 'boolean', description: '是否可多选，缺省 false。' },
          },
        },
      },
    },
    output: {
      schema: ASK_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `${value.asked_as} ${JSON.stringify(value.answers)}` }],
    },
    // 它等的是人：同一次里并发问出多张卡片只会让人更难答。让平台串行化同一智能体的工具调用。
    isConcurrencySafe: () => false,
    // 刻意**不设 `timeoutMs`**：它等的是人去登录 / 过验证码，几分钟很正常，而平台对工具调用本身
    // 没有默认超时（`delegate` 设 15000 是因为它等的是"建立会话"这种秒级动作）。
    async execute(args, exec) {
      return askUser(args.questions, exec, deps);
    },
  });
}

/**
 * 注册 `delegate` 与 `ask_user`。
 * 服务在**每次调用**时现取：注册顺序、以及某些服务是否挂载，都不该由 apply 时机决定。
 * `jobs` 故意不解析 —— 本插件的后台一律走 continuable（见 design.md 的 I4）。
 *
 * @param {object} ctx cordis 上下文（global 层）
 */
export function apply(ctx) {
  // 本插件是全 DSH 唯一的委派入口，所以「子代理 → 派它的那个调度者」这张表只有这里能填。
  const owners = createOwnerIndex();
  // 「预留 childId → 待贴能力面」表：让 persona 在子代理**建立窗口**里贴上，抢在首轮装配之前（I7 / I18）。
  const faces = createChildFaces();
  const services = () => ({
    subagents: ctx.get('subagents'),
    agents: ctx.get('agents'),
    userQuestions: ctx.get('userQuestions'),
  });

  // 建立窗口监听：`delegate` 派出的子代理一被 announce 就贴能力面。平台在
  // `startActivation` 里先装配子代理、再投递首条 prompt、最后才返回 —— 等返回再贴就晚了，
  // 子代理第一轮系统提示词会带着它从 preset 继承来的**调度者 persona**（这正是本监听的用处）。
  // 监听器必须同步完成注册（section / restrict 都是同步注册、活生效），异常只记状态不抛
  // （见 lib/delegate.mjs 的 createChildFaces）。
  ctx.effect(() => {
    const off = ctx.on('agent/created', (payload) => {
      faces.applyFor(payload?.agent);
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, 'adg-delegate.child-face()');

  ctx.tools.register(
    createDelegateTool({
      services,
      rememberChild: (childId, parent) => owners.remember(childId, parent),
      rememberFace: (childId, face) => faces.remember(childId, face),
      takeFace: (childId) => faces.take(childId),
    }),
  );
  ctx.tools.register(
    createAskUserTool({
      services,
      ownerIdOf: (childId) => owners.ownerIdOf(childId),
    }),
  );
  ctx.logger?.debug?.(`[${name}] 已注册 ${TOOL_NAME} 与 ${ASK_TOOL_NAME}`);
}