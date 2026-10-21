// adg-source-guard 的 cordis 插件入口。
//
// 为什么要这个插件：PTC 模式下模型经 `run_code` 干活，源码全文随
// `tool/call` 的 `arguments` 进上下文；结果侧平台默认只渲染日志与返回值，
// 所以"成功时源码不进上下文"这件事，本插件能管的是**结果侧**那一半 ——
// 不让源码从结果里再进一次。默认只把当次的执行意图补在最前面（平台不会渲染
// 它，源码省略掉之后这是模型回读时唯一知道"这次想干什么"的东西）；
// 失败路径反之：CodeRunFailedError 的 message 与 Captured output 是排查现场，
// 一个字都不改。
//
// 挂载点是 `tools/post-execute`（prepend），与 dsh-spill-policy 同一范式：
// 先 `await next()` 拿到已归一化的决策，再决定要不要改。本插件**不写盘、
// 不起进程、不解析 jobs**，只做数组拼接。
//
// 契约与红线见 AGENTS.md / design.md；生效口径见根 AGENTS.md 的「生效方式」。

import { applyPolicy } from './lib/policy.mjs';

export { applyPolicy, TOOL_NAME } from './lib/policy.mjs';

/** 插件名：必须等于 cordis.patch.yml 里 insert 行的 `id`。 */
export const name = 'adg-source-guard';

/** 只依赖 tools 运行时（post-execute 的注册面）。 */
export const inject = ['tools'];

/**
 * 插件入口：在全局层挂一个 prepend 的 `tools/post-execute` 监听器。
 *
 * 挂在全局层（无 scope）⇒ 覆盖本 profile 里每个会话的每一次工具执行，
 * 包括子代理 —— 判据在 `governs()` 里（顶层 run_code），与
 * dsh-spill-policy 的全局层注册同形状。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件挂载上下文
 */
export function apply(ctx) {
  ctx.effect(() => {
    const off = ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next();
      try {
        return applyPolicy({ exec, result, decision });
      } catch (error) {
        // 单次改写失败不许拖垮那次工具执行：落一条 warn，原样返回决策。
        // 失败路径的"原样保留"本来就是本插件的默认立场，这里只是把
        // 异常路径也收敛到同一个立场。
        ctx.logger?.warn?.(`adg-source-guard: skipping run_code result rewrite (${String(error)})`);
        return decision;
      }
    }, { prepend: true });
    return () => {
      if (typeof off === 'function') off();
    };
  }, 'adg-source-guard.post-execute()');
}
