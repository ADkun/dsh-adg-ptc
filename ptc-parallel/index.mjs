// adg-ptc-parallel 的 cordis 插件入口。
//
// 为什么要这个插件：PTC 模式下模型经 `run_code` 干活，一次 `run_code` 里可以发**多个**
// 工具子调用 —— 平台会并发执行那些"声明了并发安全"的调用。但模型往往不知道这件事，
// 于是把本可一次并行发完的活拆成好几轮 `run_code`：多一轮就多一份上下文、多一次等待。
// 本插件把"怎么用 PTC 并行"写成一段系统提示词，让它**在系统提示词里**，不需要模型
// 调任何工具、也不依赖模型自觉。
//
// 为什么要挂在 `agent/created` 而不是别的时机：
//   - 提示词是**每个 agent 自己的** —— 调度者与子代理各自有自己的系统提示词组装，
//     而 PTC 呈现是**按 scope** 解析的（见 lib/guide.mjs 的 isPtcAgent 注释）。
//     所以判定与注册都必须逐 agent 做：在一个 agent 的 scope 上注册，只影响那个 agent。
//   - 挂在 `agent/created` 上，是"这个 agent 刚存在、它的 scope 已经定下来"的那一刻 ——
//     此时判定呈现模式、注册 section 都还来得及。**运行中的旧 agent 不补挂**
//     （section 只在创建那一刻注册一次），改插件代码后要新会话才看得到。
//   - 注册挂在 `agent.ctx` 上 —— agent 注销时随 scope 自动拆除；插件自己的清理
//     只负责"拆监听器"这一件事，不追着 agent 收尸。
//
// **不注册任何工具**：本插件只往系统提示词里加一段话，不进任何 `allow`、不进
// `delegate` 的 `tools` 名单、不占 `KNOWN_TOOLS`。
//
// 入口形状与 skill-inject 同款（契约三件套 name / inject / apply）：
//   - `name` 必须与 cordis.patch.yml 里 insert 行的 `id` 一致；
//   - `inject: ['systemPrompt']` —— 只依赖系统提示词注册表，别的什么都不碰。
//
// 契约与红线见 AGENTS.md / design.md；生效口径见根 AGENTS.md 的「生效方式」。

import { GUIDE_TEXT, guideTextFor, isPtcAgent } from './lib/guide.mjs';

export { GUIDE_TEXT, guideTextFor, isPtcAgent };

/** 插件名：必须等于 cordis.patch.yml 里 insert 行的 `id`。 */
export const name = 'adg-ptc-parallel';

/** 只依赖 systemPrompt 服务。 */
export const inject = ['systemPrompt'];

/**
 * 插件入口：监听 agent/created，给每个**确认为 PTC 呈现**的 agent（调度者与子代理都算）
 * 在它自己的 agent.ctx 上注册一段"PTC 并行执行"section。
 *
 * 判定用公开 API：`ctx.get('tools').get('run_code', agent)` —— 它不为 undefined
 * 就说明**这个 scope 的呈现模式不是 native**，即这个 agent 是 PTC 呈现的
 * （理由见 lib/guide.mjs 的 isPtcAgent）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件挂载上下文
 */
export function apply(ctx) {
  ctx.effect(() => {
    const off = ctx.on('agent/created', (payload) => {
      try {
        const agent = payload?.agent;
        if (agent === void 0) return;
        if (!isPtcAgent(ctx, agent)) return;
        const agentCtx = agent.ctx;
        if (agentCtx === void 0) return;
        agentCtx.systemPrompt.section({
          // section 名：每个 agent 的 scope 内唯一；重挂载时报重复注册是配置错误，不静默吞掉。
          name: 'adg:ptc-parallel',
          // order 810：落在平台自己的 PTC-only 段（800）之后、文件引用段（900）之前 ——
          // 这一段是"怎么用 PTC"的操作指引，紧挨着 PTC-only 段读最顺。
          order: 810,
          // 正文是**provider**，不是常量字符串：提示词每次组装都会重新求值 text，
          // 而这个 agent 看得见的工具集合是会变的（工具面不同、dsh 升级后新增工具）。
          // 写死字符串等于把一次读数当锚 —— 所以每次组装都现算一遍：
          // 指引部分是常量，末尾的工具清单按当前 scope 现算。
          text: (context) => guideTextFor({ ctx, scope: context?.scope ?? context?.agent }),
        });
      } catch {
        // 单个 agent 的注册失败不拖垮其它 agent —— 这段指引缺席的最坏后果是
        // 回到"模型不知道 PTC 能并行"的旧状态，不是整个 profile 的插件层报错。
      }
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, 'adg-ptc-parallel.section()');
}
