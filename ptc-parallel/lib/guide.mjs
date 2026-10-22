// adg-ptc-parallel 的可测内核：正文常量 + 「这个 scope 是不是 PTC 呈现」的判定
// + 「这个 scope 当前看得见哪些工具、哪些能并发」的现算。
//
// 这个文件刻意不 import 任何 cordis API —— 只用纯函数与字符串常量，
// `node --test test` 能在零依赖下直接测它；index.mjs 只做"把内核接到 cordis 上"。
//
// ── 判定：是不是 PTC 呈现 ───────────────────────────────────────────────
// 判定只用**公开 API**：`ctx.get('tools').get('run_code', agent)`。
// 为什么这等于「这个 scope 是 PTC 呈现」：平台把 `run_code` 这个保留名的呈现
// 传输层按 scope 解析 —— dsh-tools 的 `view(scope)` 在解析完能力层之后，
// 只给"呈现模式不是 native"的 scope 补上 `run_code`（native scope 的调度表里
// 没有它，哪怕同一进程里别的 agent 正在呈现它）。所以"这个 scope 的可见工具
// 集合里有没有 run_code"就是"这个 scope 的呈现模式是不是 ptc"的公开判据。
// 传 scope 时传**agent 对象本身** —— agent 的 scope key 就是这个实例。
//
// ── 清单：哪些工具能并发 ───────────────────────────────────────────────
// 正文里**不写死任何工具名**。工具集合会随 dsh 升级、随每个 agent 的工具面变化；
// 一份写死的清单一过期，模型就会拿过期清单下结论（"这个能并发"其实早变了）。
// 所以清单每次组装提示词时现算：取这个 scope 当前可见的工具定义，按平台调度器
// 同一口径分类（有并发安全声明 ⇒ 可并发，没有 ⇒ 独占），渲染成正文末尾一小节。
// 平台侧的同一个口径见 dsh-tools 的 `executionMode`：没有 `isConcurrencySafe`
// 就没有并发安全声明，一律独占；分类器抛错也一律独占。
// 注意：**不**用"无参调用 isConcurrencySafe({}) 去探测真假" —— 平台那份实现会先
// 校验参数，必填参数的工具会被误判成不安全。只看"有没有这个函数属性"。

/**
 * 平台保留的 PTC 呈现传输层工具名（也是本插件判定 PTC 呈现时用的那个名字）。
 */
export const RUN_CODE_NAME = 'run_code';

/**
 * 注入正文：**唯一真相源**。index.mjs 只 import 它，不另抄一份。
 *
 * 这段话是**操作指引**（怎么把活拆进一次调用里），不随会话变化 —— 所以它是常量。
 * 但它**不含任何工具名**：工具名会过期（见文件头），工具清单现算后追加在后面。
 */
export const GUIDE_TEXT = `## PTC 并行执行（一次 run_code 里多做）

动手前先想清楚：这轮要做的事能拆成哪些工具调用，它们之间有没有依赖。

- **无依赖的，一次全发**：互不影响、也不需要对方结果的调用，在同一次调用里一起发出去（\`Promise.all\`），不要分成几轮。
- **有依赖的，串行接**：后一个要用前一个的输出，就把前一个的返回值在程序里处理后喂给后一个 —— 处理留在程序里做，不要先返回再开下一轮。
- **一次能干完的，别拆成多次调用**：多一轮就多一份上下文、多一次等待。

平台按每个工具**自己的并发安全声明**调度这些调用：声明了并发的真的并行跑；没声明的一律独占 —— 它不返回，排在它后面的调用就都等着。所以你不用背下哪几个工具能并发：无依赖的调用一起发出去就是对的，最坏情况是独占的退化成串行，不报错、也不丢结果。唯一要留神的只有一点：别让一个慢调用挡在快调用前面。

并发的子调用数有平台上限，超出的那批会排队。
`;

/**
 * 动态清单前面的一句过渡：告诉模型这份清单是**现算**的，别把它当常量。
 *
 * 同样**不含任何工具名** —— 它描述的是"清单怎么来的"，不是"清单里有什么"。
 */
export const CLASSIFICATION_NOTE = `下面这份清单是这次组装提示词时**从你当前可见的工具里现算**出来的：新工具出现、你的工具面变化，它都会跟着变。具体到某一次调用，平台仍按实参再判一次（参数不合法也算不安全），以调度结果为准。
`;

/**
 * 判定一个 scope 是不是 PTC 呈现。
 *
 * 判据只有一条：`ctx.get('tools').get('run_code', agent)` 不为 `undefined`。
 * 理由（为什么它等价于「这个 scope 是 PTC 呈现」）：平台的 `run_code` 是保留名的
 * 呈现传输层 —— dsh-tools 解析某个 scope 的可见工具集合时，只给呈现模式不是
 * native 的 scope 补上它（native scope 的调度表里没有它）。于是"这个 scope 能不能
 * 看见 run_code"就是公开的、可判定的呈现口径。
 *
 * 为什么必须 try/catch：`get` 内部要现造 PTC 传输层（取 PTC runtime），
 * runtime 缺失时**会抛错**。异常一律当作"不是 PTC"（不注入）—— 判据拿不到时
 * 宁可不注入，也不要把一段讲 PTC 并行的正文塞进一个根本不是 PTC 的会话。
 *
 * @param {{get?: (name: string) => unknown}} ctx 插件挂载上下文
 * @param {unknown} agent 目标 agent（scope key 就是它自己）
 * @returns {boolean}
 */
export function isPtcAgent(ctx, agent) {
  try {
    if (ctx === null || typeof ctx !== 'object') return false;
    if (typeof ctx.get !== 'function') return false;
    if (agent === null || agent === undefined) return false;
    const tools = ctx.get('tools');
    if (tools === null || typeof tools !== 'object') return false;
    if (typeof tools.get !== 'function') return false;
    // scope 传 agent 对象本身：agent 的 scope key 就是这个实例。
    const definition = tools.get(RUN_CODE_NAME, agent);
    return definition !== undefined;
  } catch {
    // 判据本身抛错（PTC runtime 缺失等）—— 一律按"不是 PTC"处理。
    return false;
  }
}

/**
 * 把一个 scope 的可见工具定义分成"可并发"与"独占"两列。
 *
 * 口径与平台调度器同源（dsh-tools 的 `executionMode`）：定义上**有**
 * `isConcurrencySafe` 函数属性 ⇒ 平台会拿实参问它，答 true 就并行 ⇒ 归可并发；
 * **没有**这个属性 ⇒ 平台直接判独占。分类器存在但不是函数（形状不对）也归独占 ——
 * 平台那侧会调用失败并兜底成独占，这里提前一步兜底。
 *
 * 故意**不**去调用 `isConcurrencySafe`：平台那份实现会先校验参数，无参探测会把
 * 必填参数的工具误判成不安全。分类只回答"有没有声明"，具体某一次调用的结论
 * 交给平台（这一点也写进了 CLASSIFICATION_NOTE）。
 *
 * `run_code` 本身不进任何一列：它就是"一次调用里发多个子调用"的那个入口，
 * 把它列进清单里只会让模型去并发调用它自己。
 *
 * @param {Iterable<[string, unknown]>} visible 可见工具定义（Map 或条目数组）
 * @returns {{parallel: string[], exclusive: string[]}} 两列，按名称排序
 */
export function classifyVisibleTools(visible) {
  const parallel = [];
  const exclusive = [];
  try {
    if (visible === null || visible === undefined) return { parallel, exclusive };
    if (typeof visible[Symbol.iterator] !== 'function') return { parallel, exclusive };
    for (const entry of visible) {
      if (!entry) continue;
      const name = entry[0];
      const definition = entry[1];
      if (typeof name !== 'string' || name === '') continue;
      if (name === RUN_CODE_NAME) continue;
      const declared = definition !== null
        && typeof definition === 'object'
        && typeof definition.isConcurrencySafe === 'function';
      if (declared) parallel.push(name);
      else exclusive.push(name);
    }
  } catch {
    // 集合形状不认识（迭代器抛错等）—— 已经收进来的算命，剩下的不猜。
  }
  parallel.sort();
  exclusive.sort();
  return { parallel, exclusive };
}

/**
 * 把两列渲染成正文末尾的那一小节。
 *
 * 空列不渲染（一列都没有时返回空串，由调用方决定要不要渲染整节）。
 * 名字用反引号包起来：这是给模型看的清单，一眼能看出是工具名。
 *
 * @param {{parallel?: string[], exclusive?: string[]}} lists 分类结果
 * @returns {string}
 */
export function renderToolLists({ parallel, exclusive } = {}) {
  const safe = Array.isArray(parallel) ? parallel : [];
  const locked = Array.isArray(exclusive) ? exclusive : [];
  const lines = [];
  if (safe.length > 0) {
    lines.push('本次可并发（平台会并行跑它们）：' + safe.map((name) => '`' + name + '`').join('、'));
  }
  if (locked.length > 0) {
    lines.push('本次独占（它不返回，后面的都等着）：' + locked.map((name) => '`' + name + '`').join('、'));
  }
  return lines.join('\n');
}

/**
 * 组装完整正文：常量指引 + （工具清单现算成功时）一句过渡 + 两列清单。
 *
 * 取工具的路径：`ctx.get('tools')` 拿 dsh-tools 的 ToolRuntime（cordis 的按名取服务，
 * 不需要 inject），再 `tools.view(scope)` 取**这个 scope** 当前看得见的工具集合 ——
 * view 按 scope 链解析（越近的 scope 覆盖越远的，global 层最后），所以传子代理的
 * scope 进去，看到的就是**那个 agent** 的工具面。ToolRuntime 是全局单例，它那几层
 * scoped layer 是共享的，所以不同 agent 各看各的视图。
 *
 * 整个函数体 try/catch：任何一步失败（服务不存在、view 抛错、返回形状不对）都只
 * 返回 GUIDE_TEXT —— 少一段清单不影响指引成立，绝不能让提示词组装炸掉。
 *
 * @param {{ctx?: unknown, scope?: unknown}} input ctx 与目标 scope（agent 实例）
 * @returns {string} 完整正文
 */
export function guideTextFor({ ctx, scope } = {}) {
  try {
    if (ctx === null || typeof ctx !== 'object') return GUIDE_TEXT;
    if (typeof ctx.get !== 'function') return GUIDE_TEXT;
    const tools = ctx.get('tools');
    if (tools === null || typeof tools !== 'object') return GUIDE_TEXT;
    if (typeof tools.view !== 'function') return GUIDE_TEXT;
    const view = tools.view(scope);
    if (view === null || typeof view !== 'object') return GUIDE_TEXT;
    const lists = classifyVisibleTools(view.visible);
    const rendered = renderToolLists(lists);
    if (rendered === '') return GUIDE_TEXT;
    // 两个常量都带结尾换行（照抄原文本块），拼接前先去掉，免得中间空出三行。
    return `${GUIDE_TEXT.trimEnd()}\n\n${CLASSIFICATION_NOTE.trimEnd()}\n\n${rendered}\n`;
  } catch {
    // 现算失败只丢清单，不丢指引。
    return GUIDE_TEXT;
  }
}
