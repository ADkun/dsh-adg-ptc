// adg-skill-inject 的 cordis 插件入口。
//
// 为什么要这个插件：思考框架技能先前的装载方式是"调度 persona 写一段【思考框架闸门】，
// 要求调度者自己去 read 那份 SKILL.md" —— 那依赖模型的自觉性，实测会漏。
// 本插件把它换成机制保证：
//   1. apply() 时按设置页的配置读正文（留空就读 SKILL.md，剥掉 YAML frontmatter），
//      注册成一段 systemPrompt section（order 100，落在调度 persona prefix 之后）——
//      框架文本**本身就在系统提示词里**，不需要模型再调任何工具；
//   2. section 的 text 是**每次组装都求值的 provider**：设置页的开关与自定义正文在下一次
//      请求就生效，不需要重启 dsh；系统提示词每次请求原样重发、不参与折叠（compaction 只
//      折叠会话历史），「这份技能读进来的正文不许压缩」由机制天然满足；
//   3. 只注入**Adg 调度者**：监听 `agent/created`（serial，全局层监听者收到所有 agent），
//      按 `shouldInjectFor()` 逐 agent 判定 —— 子代理（origin === 'subagent'）与非 Adg
//      preset 的会话都不注入。preset composition 里的 scoped section 会经 composeFrom
//      一并落到子代理（agent-preset-registry 的 join 把子代理 scope 直接绑到 generation
//      scope），所以"只给调度者"必须靠逐 agent 判定，不能靠 composition 层的行。
//
// 入口形状与 notify/permission/delegate 同款（契约三件套 name / inject / apply）：
//   - `name` 必须与 cordis.patch.yml 里 insert 行的 `id` 一致；
//   - `inject: ['systemPrompt']` —— 只依赖系统提示词注册表，别的什么都不碰。
//
// 契约与红线见 AGENTS.md / design.md；生效口径见根 AGENTS.md 的「生效方式」。

import {
  DEFAULT_SKILL_PATH,
  SECTION_NAME,
  SECTION_ORDER,
  resolveSectionText,
  shouldInjectFor,
  sectionTextFor,
} from './lib/section.mjs';
import { readUserDefaults } from './lib/user-settings.mjs';

export {
  DEFAULT_SKILL_PATH,
  SECTION_NAME,
  SECTION_ORDER,
  resolveSectionText,
  shouldInjectFor,
  sectionTextFor,
};

/** 插件名：必须等于 cordis.patch.yml 里 insert 行的 `id`。 */
export const name = 'adg-skill-inject';

/** 只依赖 systemPrompt 服务。 */
export const inject = ['systemPrompt'];

/**
 * 每次组装系统提示词时的正文：设置页关掉注入就返回空串（空 section 在渲染时被丢弃，
 * 等价于没有这一段），否则按「自定义正文 > SKILL.md」取正文。
 *
 * 这里刻意**不缓存**：设置文件是唯一真相，重读一次的开销远小于"改了设置还要重启"的代价。
 * @returns {string} 本轮的 section 正文（可能是空串）
 */
export function sectionTextNow() {
  const settings = readUserDefaults();
  if (settings.skillInjectEnabled !== true) return '';
  return resolveSectionText({ customText: settings.skillInjectText, skillPath: DEFAULT_SKILL_PATH }).text;
}

/**
 * 插件入口：监听 agent/created，给每个 Adg 调度者在它自己的 agent.ctx 上注册框架 section。
 *
 * 注册挂在 agent.ctx 上 —— agent 注销时随 scope 自动拆除（practices.md 的既定模式），
 * 插件自己的清理只负责"拆监听器"这一件事，不追着 agent 收尸。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件挂载上下文
 */
export function apply(ctx) {
  ctx.effect(() => {
    const off = ctx.on('agent/created', (payload) => {
      try {
        const agent = payload?.agent;
        if (agent === void 0) return;
        const header = agent.session?.header;
        // composedPreset 读 standing mount（scope 链）；判据细节见 lib/section.mjs。
        const composed = ctx.get('agentPresets')?.composedPreset?.(agent.ctx);
        if (!shouldInjectFor(header, composed)) return;
        const agentCtx = agent.ctx;
        if (agentCtx === void 0) return;
        agentCtx.systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: () => sectionTextNow(),
        });
      } catch {
        // 单个 agent 的注册失败不拖垮其它 agent —— 框架缺席的最坏后果是回到"没有框架"。
      }
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, 'adg-skill-inject.section()');
}
