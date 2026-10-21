// adg-notify 的 cordis 插件入口：注册 `notify_user`。
//
// 入口形状由 dsh 的插件契约规定：
//   - 命名导出 `name` / `inject` / `apply`（契约要求的入口三件套）
//   - `name` 必须与 cordis.patch.yml 里 insert 行的 `id` 一致
//   - 工具定义走 `defineTool`（`output` 是硬要求，缺了直接 TypeError）
//
// 本文件只做「把工具挂上去」；真正的 toast 在 lib/toast.mjs，用户在设置页里调的那三项在
// lib/user-settings.mjs。契约与红线见 AGENTS.md / design.md。

import { defineTool } from '@deepseek-ai/dsh-tools';

import { DEFAULT_APP_ID, DEFAULT_TITLE, sendToast } from './lib/toast.mjs';
import { USER_DEFAULTS, readUserDefaults, resolveRequest } from './lib/user-settings.mjs';

/** 插件名：必须等于 cordis.patch.yml 里 insert 行的 `id`。 */
export const name = 'adg-notify';

/** 本插件只依赖 tools 服务（别的什么都不 inject）。 */
export const inject = ['tools'];

/** 工具名：调度者在委派时写进 `delegate` 的 `tools` 里的就是这个字符串。全仓库/全 DSH 内唯一。 */
export const TOOL_NAME = 'notify_user';

/**
 * 工具描述。写给「一眼判断何时该用」：撞墙要人、以及需要人拍板的场合。
 * 不写「请用户回话」——它是单向通知，不阻塞。
 */
const DESCRIPTION = [
  '弹一条 Windows 桌面通知，把「该你动手了」推给用户，用于必须由人在本机完成的阻塞点：',
  '登录墙 / 验证码 / 二次验证（2FA）/ 设备确认，或需要用户拍板、出示凭据、',
  '在本机操作某个窗口的场合。正文请写清：卡在哪、用户具体要做什么。',
  '要用户**回话**的一律用 `ask_user`（本通知是单向的，回不了话）—— 通知正文里不要要求用户"回来告诉我"。',
  '**这是单向通知，不会阻塞、也不会等待用户回话**：调用后立刻返回，用户是否看到不影响本步继续。',
  '用户不在电脑前时通知可能没被看到——不要把它当成「已获得用户确认」，也不要用它代替 send_message。',
].join(' ');

/** 输出 schema：工具结果就是这五个字段。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    shown: { type: 'boolean', required: true, description: 'Windows 是否已受理这次 toast（true 只表示已投递，不表示人看到了）' },
    mechanism: { type: 'string', required: true, description: '投递机制，当前恒为 toast' },
    title: { type: 'string', required: true, description: '通知标题' },
    message: { type: 'string', required: true, description: '通知正文' },
    disappearAfterMs: { type: 'integer', required: true, description: '通知存活毫秒（<= 0 表示常驻提醒）' },
  },
};

/**
 * 造出 `notify_user` 的工具定义。
 * 单独导出是为了让自测能用**真的** `defineTool` 造一遍定义 —— 作者侧 schema 方言
 * 写错时，真 `defineTool` 会当场抛 `JsonSchemaError`（见 design.md N12）。
 *
 * @param {{
 *   send?: (input: object) => Promise<object>,
 *   defineTool?: Function,
 *   defaults?: () => {notifyTitle: string, notifySound: boolean, notifyPersist: boolean},
 * }} [deps]
 * @returns {object} dsh-tools 的 ToolDefinition
 */
export function createNotifyUserTool(deps = {}) {
  const send = deps.send ?? ((input) => sendToast(input));
  // 允许注入 `defineTool` 只是为了自测能拿真实现再编译一遍；运行时永远用真货。
  const compile = deps.defineTool ?? defineTool;
  // `deps.defaults` 是「设置页那一层」的取值点：运行时由 apply 接上真文件读取（见下），
  // 不传就是出厂默认 —— 自测因此不碰真实文件系统，行为也与历史一致。
  const readDefaults = deps.defaults ?? (() => USER_DEFAULTS);

  return compile({
    name: TOOL_NAME,
    description: DESCRIPTION,
    // 作者侧方言是**隐式属性映射**（key 就是属性名），不是对象根 JSON Schema：
    // 写成 `{type:'object',properties:{…}}` 会被 `parameterSchemaSpecToJsonSchema` 拒掉
    // （`parameters.type must be a value schema object`）。必填由属性上的 `required: true` 表达。
    // 见 @deepseek-ai/dsh-tools 的 `compilePropertyMap` / `parameterSchemaSpecToJsonSchema`。
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: '推给用户看的正文：卡在哪 / 用户具体要做什么。会显示在通知里。要用户回话的一律用 `ask_user`。',
      },
      title: {
        type: 'string',
        description: `通知标题，默认用设置页的「通知默认标题」（出厂 "${'DSH 通知'}"）。想点名来源时可写成例如 "浏览器操作需要你登录"。`,
      },
      silent: {
        type: 'boolean',
        description: 'true = 静音弹出（不响提示音）。默认跟随设置页的「响提示音」（出厂出声）。',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value?.shown === true
              ? `已发送 Windows 通知：${value.title ?? DEFAULT_TITLE}｜${value.message}（单向通知，不等用户回话）`
              : `通知未发出：${JSON.stringify(value)}`,
        },
      ],
    },
    // 纯本地副作用，互相之间没有共享状态；多个子代理同时通知不会打架。
    isConcurrencySafe: () => true,
    // PowerShell 冷启动 + WinRT 投影实测在 1 秒量级；15 秒是"卡死就别等了"的上限。
    timeoutMs: 15000,
    async execute(args) {
      // 失败一律抛错（脚本缺失 / PowerShell 不可用 / 非零退出 / 超时），
      // 绝不返回 { shown: false } 冒充成功 —— 见 design.md 的 D4。
      //
      // 这一次调用的参数 > 设置页的值。`readDefaults()` **每次调用**重读一次设置文件，
      // 所以设置页一保存，下一次调用的行为就变了（不需要重启 dsh）。
      const request = resolveRequest(args, readDefaults());

      const result = await send(request);
      return {
        shown: result.shown === true,
        mechanism: result.mechanism ?? 'toast',
        title: result.title,
        message: result.message,
        disappearAfterMs: result.disappearAfterMs,
      };
    },
  });
}

/**
 * cordis 插件入口。
 * @param {{tools: {register: (definition: object) => () => void}}} ctx
 * @param {{appId?: string, timeoutMs?: number, scriptPath?: string, powerShellPath?: string}} [config]
 */
export function apply(ctx, config = {}) {
  const overrides = {
    appId: typeof config.appId === 'string' ? config.appId : DEFAULT_APP_ID,
    timeoutMs: config.timeoutMs,
    scriptPath: config.scriptPath,
    powerShellPath: config.powerShellPath,
  };
  const tool = createNotifyUserTool({
    send: (input) => sendToast(input, overrides),
    // 生产路径的文件读取点。**不在注册时读、每次调用读**：这是「保存后立即生效」的全部实现。
    defaults: () => readUserDefaults(),
  });
  ctx.tools.register(tool);
  ctx.logger?.debug?.(`adg-notify: registered tool "${TOOL_NAME}"`);
}