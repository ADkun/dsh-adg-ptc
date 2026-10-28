// adg 设置框架的**唯一登记表**。
//
// 「加一项用户可配的东西」在这里只做两件事：往 FIELDS 里加一条，然后在
// settings/client.js 的 DICT 里补两条文案（`field.<键>.label` / `.hint`）。宿主按 kind
// 校验、按界拒绝越界值；客户端按 kind 选控件、按 group 聚卡片 —— 两边的逻辑都不用改。
//
// 三条不变量（破了框架就不成立，见 settings/design.md）：
//   I1 键名的真相只在本文件。读这些键的模块不 import 本包，只按文件契约读自己那几个键
//      （消费方是 notify/lib/user-settings.mjs 与 skill-inject/lib/user-settings.mjs），
//      它们的自测里各有一条漂移检查：核对读的键都还在这张表里、默认值与界也一致。
//   I2 每个字段的 `default` 都必须能通过自己的 `validValue` —— 页面「恢复默认」与宿主的
//      最后一层回退都指它，一个不合法或不合界的 default 会让设置页一开就是红的。
//   I3 kind 只有这四种（`boolean` / `string` / `integer` / `enum`）。新增一种要同时改宿主的
//      `validValue` / `refuseMessage` 与客户端的控件选择，属于「改框架」，不属于「加一项」。
//
// 为什么登记表住宿主侧：页面能写哪些键、什么值算合法，必须由宿主说了算（客户端只是画
// 控件）。一个手改过的设置文件、或一个越界的 POST，都不会把值带进系统。

/** 支持的控件 / 校验类别。 */
export const KINDS = Object.freeze(['boolean', 'string', 'integer', 'enum']);

/**
 * 字段登记表。数组顺序 = 页面顺序；`group` 相同的一组进同一张卡片。
 * `consumer` 记「谁读这个键」，改动时按它去核对消费方（不参与运行时）。
 *
 * 可选的显示 / 校验修饰（都只在这张表里写，宿主与客户端都不另立一份）：
 *   - `allowEmpty: true` —— 字符串允许空值（「留空 = 跟随默认」的语义由消费方定义）。
 *     不加这一条时，空串与全空白一律算非法值（I2 的默认值也必须能过自己的 validValue）。
 *   - `multiline: true` —— 客户端把它画成多行文本框（仍是 `kind: 'string'`，不是新 kind）。
 *   - `allowValues: [...]` —— `kind: 'enum'` 的取值集合（冻结数组）。客户端按它画下拉选项，
 *     宿主按它校验；两端都不另立一份界（R4）。
 */
export const FIELDS = Object.freeze([
  Object.freeze({
    key: 'notifyTitle',
    kind: 'string',
    group: 'notify',
    default: 'DSH 通知',
    maxLength: 80,
    consumer: 'adg-notify',
    labelKey: 'field.notifyTitle.label',
    hintKey: 'field.notifyTitle.hint',
  }),
  Object.freeze({
    key: 'notifySound',
    kind: 'boolean',
    group: 'notify',
    default: true,
    consumer: 'adg-notify',
    labelKey: 'field.notifySound.label',
    hintKey: 'field.notifySound.hint',
  }),
  Object.freeze({
    key: 'notifyPersist',
    kind: 'boolean',
    group: 'notify',
    default: true,
    consumer: 'adg-notify',
    labelKey: 'field.notifyPersist.label',
    hintKey: 'field.notifyPersist.hint',
  }),
  Object.freeze({
    key: 'skillInjectEnabled',
    kind: 'boolean',
    group: 'skillInject',
    default: true,
    consumer: 'adg-skill-inject',
    labelKey: 'field.skillInjectEnabled.label',
    hintKey: 'field.skillInjectEnabled.hint',
  }),
  Object.freeze({
    key: 'skillInjectFramework',
    kind: 'enum',
    group: 'skillInject',
    default: 'elegant',
    allowValues: Object.freeze(['elegant', 'thinking', 'execution']),
    consumer: 'adg-skill-inject',
    labelKey: 'field.skillInjectFramework.label',
    hintKey: 'field.skillInjectFramework.hint',
  }),
  Object.freeze({
    key: 'skillInjectSubagent',
    kind: 'boolean',
    group: 'skillInject',
    default: false,
    consumer: 'adg-skill-inject',
    labelKey: 'field.skillInjectSubagent.label',
    hintKey: 'field.skillInjectSubagent.hint',
  }),
  Object.freeze({
    key: 'skillInjectText',
    kind: 'string',
    group: 'skillInject',
    default: '',
    allowEmpty: true,
    multiline: true,
    maxLength: 20000,
    consumer: 'adg-skill-inject',
    labelKey: 'field.skillInjectText.label',
    hintKey: 'field.skillInjectText.hint',
  }),
]);

/** 内置默认值（I2：每一条都必须能通过 `validValue`）。 */
export const DEFAULTS = Object.freeze(
  Object.fromEntries(FIELDS.map((field) => [field.key, field.default])),
);

/** 一个键的登记项，或 `undefined`（``= 宿主不认识的键）。 */
export function fieldFor(key) {
  return FIELDS.find((field) => field.key === key);
}

/** 一个不合法的值该说什么：宿主的 400 正文，客户端的本地校验用同一套界。 */
export function refuseMessage(field) {
  if (field.kind === 'boolean') return `${field.key} must be true or false`;
  if (field.kind === 'enum') return `${field.key} must be one of: ${field.allowValues.join(', ')}`;
  if (field.kind === 'integer') {
    return `${field.key} must be an integer between ${field.min} and ${field.max}`;
  }
  if (field.allowEmpty === true) {
    return `${field.key} must be a string of at most ${field.maxLength} characters (empty means "use the default")`;
  }
  return `${field.key} must be a non-empty string of at most ${field.maxLength} characters`;
}

/**
 * 整数字面量：一个真整数，或一个只由十进制数字组成的字符串。
 * 特意**不**用裸 `Number()`：`Number('')` 与 `Number(null)` 都是 0，那会把一个空值悄悄
 * 变成「0」带进系统；`1.5` 与 `' 1 '` 同样不算。
 */
function integerValue(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : undefined;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Number(raw);
  return undefined;
}

/**
 * 校验一个值：通过就返回规范化后的值，否则 `undefined`。
 * 布尔接受 `true` / `false` 与它们的字符串写法（设置页与手改的 JSON 都走这条路）。
 */
export function validValue(field, raw) {
  if (field.kind === 'boolean') {
    if (raw === true || raw === false) return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }
  if (field.kind === 'enum') {
    // 严格相等：不折叠大小写、不 trim —— 内部值只有 allowValues 里那几个英文串。
    if (typeof raw !== 'string') return undefined;
    return field.allowValues.includes(raw) ? raw : undefined;
  }
  if (field.kind === 'integer') {
    const value = integerValue(raw);
    if (value === undefined) return undefined;
    if (value < field.min || value > field.max) return undefined;
    return value;
  }
  if (typeof raw !== 'string') return undefined;
  if (raw.length > field.maxLength) return undefined;
  if (field.allowEmpty === true) return raw;
  if (raw.trim() === '') return undefined;
  return raw;
}

/**
 * 一份（可能被手改过的）设置：只留认得的键、只留合法的值。
 *
 * 读文件时用它的宽容面（坏值丢掉 + 警告），POST 时用它的严格面（宿主自己按 `validValue`
 * 逐键拒），两种调用共用同一套判据 —— 区别只在调用方怎么处理回报的三个列表。
 *
 * @returns {{settings: object, unknown: string[], dropped: string[]}}
 *   `unknown` = 登记表里没有的键（可能是旧版本留下的）；`dropped` = 认得的键但不合法的值。
 */
export function normalizeSettings(raw, logger, where = 'a settings file') {
  const settings = {};
  const unknown = [];
  const dropped = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings, unknown, dropped };
  }
  for (const [key, value] of Object.entries(raw)) {
    const field = fieldFor(key);
    if (field === undefined) {
      unknown.push(key);
      continue;
    }
    const accepted = validValue(field, value);
    if (accepted === undefined) {
      dropped.push(key);
      logger?.warn?.(
        `adg-settings: dropping ${key}=${JSON.stringify(value)} in ${where} (${refuseMessage(field)})`,
      );
      continue;
    }
    settings[key] = accepted;
  }
  return { settings, unknown, dropped };
}

/**
 * 三层优先级：设置文件 > 本插件行的 Config > 内置默认，并回报每一格来自哪一层
 * （页面上的「当前生效」按 `origin` 标出来源）。
 */
export function buildEffective({ stored = {}, configured = {}, defaults = DEFAULTS } = {}) {
  const value = {};
  const origin = {};
  for (const field of FIELDS) {
    if (stored[field.key] !== undefined) {
      value[field.key] = stored[field.key];
      origin[field.key] = 'stored';
      continue;
    }
    if (configured[field.key] !== undefined) {
      value[field.key] = configured[field.key];
      origin[field.key] = 'configured';
      continue;
    }
    value[field.key] = defaults[field.key];
    origin[field.key] = 'default';
  }
  return { value, origin };
}

/** 交给客户端 half 的登记表：只有数据、没有函数，可以原样 JSON 化。 */
export function describeFields() {
  return FIELDS.map((field) => ({ ...field }));
}