import { stripSandboxNotice } from './lib/strip.mjs';

/** 插件模块名：必须与 cordis.patch.yml 的 insert id 逐字一致。 */
export const name = 'adg-sandbox-notice';

/** 依赖工具服务：提供 tools/post-execute 水位事件。 */
export const inject = ['tools'];

/**
 * 全局层监听 tools/post-execute：在 run_code 的结果被渲染成文本之后（prepend 拿最终发言权，
 * 先 await next() 取下游决定），从它的 text 内容块里剥掉末尾那行 PTC 沙箱噪声。
 * 只动 run_code 的 accept 结果、只剥末尾整行、其它工具与其它内容一个字都不改；无变化时原样返回。
 */
export function apply(ctx) {
  ctx.effect(() => {
    const off = ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      try {
        if (decision === void 0 || decision === null) return decision;
        if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision;
        if (exec === void 0 || exec.name !== 'run_code') return decision;
        const content = decision.content ?? result?.content;
        const stripped = stripSandboxNotice(content);
        if (stripped === content) return decision;
        return { ...decision, content: stripped };
      } catch {
        // 任何异常都退回下游原决定：剥噪声是锦上添花，绝不能影响工具结果本身。
        return decision;
      }
    }, { prepend: true });
    return () => {
      if (typeof off === 'function') off();
    };
  }, 'adg-sandbox-notice.strip()');
}
