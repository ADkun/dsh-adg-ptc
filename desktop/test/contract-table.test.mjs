// 输出行契约表 ↔ 打印点 的机检（testing-guide.md 的 D99）。
//
// 由来：契约表是"这条命令会打哪些键"的唯一人读清单，而它和代码从来没有机器绑过 ——
// 曾经出现过两种漂移，都不会被任何运行期信号抓到：
//   ① 表里写着一个没人打的键（`verify` 行一度把 `PIXEL_HASH=` / `VERDICT=` / `DETAIL=` 写进键名单元格，
//      而那一行正文恰恰说 `verify` 不打它们）—— 根因是说明性括号被用 `|（…）` 粘进了键名单元格，
//      任何"按单元格切分"的核对都会把括号里的键读成该命令打印的键；
//   ② 代码打了表里没有的键（`WHEEL_CLICKS=`、`invoke` 复核的 `DETAIL=` / `CONTENT_*` 都漏过）。
// 所以这里做四件事：表的键必须真的在打印点；表里不许再出现 `*` 通配；键名单元格里不许混进说明性文字；
// 代码里打的每个键必须在某一行里登记过。改契约表或改打印键都会立刻红。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLI_SOURCE = fs.readFileSync(path.join(ROOT, 'cli.mjs'), 'utf8')
const BRIDGE_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'bridge.ps1'), 'utf8')
const DESIGN_LINES = fs.readFileSync(path.join(ROOT, 'design.md'), 'utf8').split('\n')

// 契约表的一行 ↔ 真正打印这些键的函数（`| 全部 |` 那行是公共行，没有对应函数）
const ROWS = [
  { prefix: '| 全部 |', functions: [] },
  { prefix: '| `profile` |', functions: ['cmdProfile'] },
  { prefix: '| `screen` |', functions: ['cmdScreen'] },
  { prefix: '| `windows` |', functions: ['cmdWindows'] },
  { prefix: '| `uia` |', functions: ['cmdUia'] },
  { prefix: '| `point` |', functions: ['cmdPoint'] },
  { prefix: '| 注入类', functions: ['cmdInject', 'reportVerification', 'injectionGate'] },
  { prefix: '| `invoke` |', functions: ['cmdInvoke', 'reportVerification'] },
  { prefix: '| `verify` |', functions: ['cmdVerify'] },
  { prefix: '| `probe` |', functions: ['cmdProbe'] },
  { prefix: '| `snapshot` |', functions: ['cmdSnapshot'] },
]

const KEY_TOKEN = /`([A-Z][A-Z0-9_]*)=/g

// ── 动态键名：`print(\`OFFSET_${name.toUpperCase()}=\`)` 这类模板，字面正则抓不到，
//    整片键就成了核对盲区（曾经：把那一行注释掉，四条断言全绿）。所以这里把它展开：
//    字段名单一真相源是桥侧 `InputLayout`，展开后再参与"表 ↔ 打印点"两个方向的核对。
const LAYOUT_CONSTS = new Set([...BRIDGE_SOURCE.matchAll(/public const int (\w+) = \d+;/g)].map((m) => m[1]))
const OFFSET_FIELDS = [...BRIDGE_SOURCE.matchAll(/^\s*(\w+) = \[DesktopBridge\.InputLayout\]::(\w+)$/gm)].map((m) => ({
  field: m[1],
  layout: m[2],
}))

/** cli.mjs 里的动态键名模板（前缀 + `${表达式}` + 后缀）。注释掉的打印点不算数。 */
function dynamicTemplates() {
  const found = []
  for (const [index, line] of CLI_SOURCE.split('\n').entries()) {
    const m = /print\(\s*`([A-Z][A-Z0-9_]*)\$\{([^}]*)\}([A-Z0-9_]*)=/.exec(line)
    if (m === null) continue
    if (line.slice(0, m.index).includes('//')) continue // `// print(...)` 不会打任何东西
    found.push({ prefix: m[1], expression: m[2], suffix: m[3], text: m[0], line: index + 1 })
  }
  return found
}

/** 把动态模板展开成具体键名。目前只有 `OFFSET_` 一族（名字来自桥侧 offsets 对象的字段名）。 */
function dynamicKeyExpansion() {
  const keys = new Set()
  const problems = []
  for (const template of dynamicTemplates()) {
    if (template.prefix !== 'OFFSET_') {
      problems.push(`未登记的动态键名模板：${template.text}`)
      continue
    }
    for (const { field, layout } of OFFSET_FIELDS) {
      keys.add(`${template.prefix}${field.toUpperCase()}${template.suffix}`)
      if (!LAYOUT_CONSTS.has(layout)) problems.push(`offsets 里的 ${field} 引用了不存在的 InputLayout 字段：${layout}`)
    }
  }
  return { keys, problems }
}

function functionBody(name) {
  const start = CLI_SOURCE.indexOf(`function ${name}`)
  assert.ok(start >= 0, `cli.mjs 里找不到 function ${name}`)
  const end = CLI_SOURCE.indexOf('\nfunction ', start + 10)
  return CLI_SOURCE.slice(start, end < 0 ? undefined : end)
}

function rowOf(prefix) {
  const row = DESIGN_LINES.find((line) => line.startsWith(prefix))
  assert.ok(row !== undefined, `design.md 的输出行契约表里找不到行：${prefix}`)
  const cells = row.split(' | ')
  const keysCell = cells[1]
  return { row, keysCell, keys: [...new Set([...keysCell.matchAll(KEY_TOKEN)].map((m) => m[1]))] }
}

test('契约表里每个键都真的出现在该命令的打印点', () => {
  const problems = []
  const { keys: dynamicKeys, problems: dynamicProblems } = dynamicKeyExpansion()
  assert.deepEqual(dynamicProblems, [], dynamicProblems.join('\n'))
  for (const { prefix, functions } of ROWS) {
    if (functions.length === 0) continue
    const printed = new Set()
    for (const name of functions) {
      for (const m of functionBody(name).matchAll(/print\(`([A-Z][A-Z0-9_]*)=/g)) printed.add(m[1])
    }
    if (functions.includes('cmdProbe')) for (const key of dynamicKeys) printed.add(key)
    const onlyTable = rowOf(prefix).keys.filter((key) => !printed.has(key))
    if (onlyTable.length > 0) problems.push(`${prefix} 表里有、打印点没有：${onlyTable.join(' ')}`)
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('契约表的键名单元格里不许混进说明性文字或通配写法', () => {
  const problems = []
  for (const { prefix } of ROWS) {
    const { row, keysCell } = rowOf(prefix)
    // 剥掉反引号包住的部分之后，单元格里不该再有 `KEY=` 形状的裸键名（说明性文字就是这么混进去的）
    const leftover = keysCell.replace(/`[^`]*`/g, '').match(/[A-Z][A-Z0-9_]{2,}=/g)
    if (leftover !== null) problems.push(`${prefix} 键名单元格里有没被反引号包住的键名：${leftover.join(' ')}`)
    // `CANONICAL_*_BYTES_HEX=` 这类通配在核对里等于没写（哪几个键要按实现逐个列）
    const wildcard = row.match(/`[A-Z][A-Z0-9_]*\*[A-Z0-9_]*=/g)
    if (wildcard !== null) problems.push(`${prefix} 契约表里不许用通配键名：${wildcard.join(' ')}`)
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('代码里打印的每个键都在契约表里登记过（漏登记也是一种漂移）', () => {
  const documented = new Set()
  for (const { prefix } of ROWS) for (const key of rowOf(prefix).keys) documented.add(key)
  const printed = new Set([...CLI_SOURCE.matchAll(/print\(`([A-Z][A-Z0-9_]*)=/g)].map((m) => m[1]))
  const { keys: dynamicKeys, problems: dynamicProblems } = dynamicKeyExpansion()
  assert.deepEqual(dynamicProblems, [], dynamicProblems.join('\n'))
  for (const key of dynamicKeys) printed.add(key)
  const undocumented = [...printed].filter((key) => !documented.has(key)).sort()
  assert.deepEqual(undocumented, [], `这些键只在代码里打、契约表没登记：${undocumented.join(' ')}`)
})

// 曾经的真盲区：`OFFSET_${name.toUpperCase()}=` 是动态模板，字面正则既不认它算"表里有"
// （表里写的是 `OFFSET_<字段名>=`），也不认它算"代码里打了"，于是把这行注释掉测试仍全绿。
test('动态键名模板必须存在、可展开，且展开结果与桥侧 offsets 字段逐一对应', () => {
  const templates = dynamicTemplates()
  assert.equal(templates.length, 1, `cli.mjs 里应恰好有 1 个动态键名模板（OFFSET_ 一族），实际 ${templates.length}`)
  assert.equal(templates[0].prefix, 'OFFSET_')
  assert.match(templates[0].expression, /toUpperCase\(\)/, '展开必须是"字段名大写"这一种写法')
  const { keys, problems } = dynamicKeyExpansion()
  assert.deepEqual(problems, [], problems.join('\n'))
  assert.equal(OFFSET_FIELDS.length, 12, `桥侧 offsets 应有 12 个字段，实际 ${OFFSET_FIELDS.length}`)
  assert.equal(keys.size, OFFSET_FIELDS.length, '展开出来的键数必须等于 offsets 字段数')
  const expected = OFFSET_FIELDS.map((entry) => `OFFSET_${entry.field.toUpperCase()}`).sort()
  assert.deepEqual([...keys].sort(), expected)
})

test('verify 行自己声明"不打"的键不许出现在它的键名单元格里', () => {
  const { keysCell } = rowOf('| `verify` |')
  for (const key of ['PIXEL_HASH', 'VERDICT', 'DETAIL', 'IGNORED']) {
    assert.ok(
      !keysCell.includes(`\`${key}=\``),
      `verify 行的键名单元格里不该有 \`${key}=\`（它只在别处打，混进来会让按单元格切分的核对读错）`,
    )
  }
})