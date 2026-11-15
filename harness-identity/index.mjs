import { shadowSection, shouldInjectFor } from './lib/section.mjs';

/** 插件模块名：必须与 cordis.patch.yml 的 insert id 逐字一致。 */
export const name = 'adg-harness-identity';

/** 依赖的系统提示词服务：提供 ctx.systemPrompt.section()。 */
export const inject = ['systemPrompt'];

/**
 * 全局层监听 agent/created：对每个 adg-ptc 的 agent（调度者与子代理都算），
 * 在**它自己的 scope** 上注册同名空文本 'harness:identity' section，覆盖平台固定开场白。
 * 注册在 agent.ctx 上，agent 注销时随 scope 自动拆除；本插件只负责拆监听器。
 */
export function apply(ctx) {
  ctx.effect(() => {
    const off = ctx.on('agent/created', (payload) => {
      try {
        const agent = payload?.agent;
        if (agent === void 0) return;
        const header = agent.session?.header;
        const composed = ctx.get('agentPresets')?.composedPreset?.(agent.ctx);
        if (!shouldInjectFor(header, composed)) return;
        const agentCtx = agent.ctx;
        if (agentCtx === void 0) return;
        agentCtx.systemPrompt.section(shadowSection());
      } catch {
        // 判据或注册抛错都安全跳过：拿不到就不覆盖，绝不拖垮其它 agent 的创建。
      }
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, 'adg-harness-identity.section()');
}
