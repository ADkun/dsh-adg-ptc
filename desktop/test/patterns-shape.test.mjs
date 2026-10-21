// patterns 形状契约测试（P0-B 的回归）。
//
// 缺陷形态：桥侧同时用了 `return ,@($names)` 与 `[object[]]@(...)`，两层包装叠成
// `{"patterns":[["InvokePattern"]]}`。`lib/elements.mjs` 的 `patternList()` 会把这种形状
// 归一化成空列表 —— 与"这个元素真的不支持任何 pattern"完全同形，于是 `invoke --id` 对**任何**
// 元素都报"没有任何可用的语义 pattern（可用：-）"，而输出里一处报错都没有。
//
// 所以这一组用两条独立的判据钉住它：
//   A. 原始 JSON 文本里**不许**出现 `"patterns":[[`（双层包装的字面指纹）。
//   B. 同一元素在 `uia --depth`（树枚举）与 `uia --id`（单元素查询）两条路径下必须给出
//      **逐值相同**的 patterns 字符串数组。
//
// 判据 A 与 B 都不依赖 UIA pattern 是否真的可得 —— 受限令牌下 pattern 全部读不到（都是空数组 `[]`），
// 而 `[[]]`（坏）与 `[]`（好）在字面与结构上都不同，所以本组在沙箱里也能红/绿。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runCli } from './helpers.mjs'

/** 跑一条命令并解析 `--json` 输出。 */
function jsonCli(argv, opts = {}) {
  const result = runCli([...argv, '--json'], { timeoutMs: opts.timeoutMs ?? 120000 })
  assert.equal(result.code, 0, `${argv.join(' ')} 应当退出码 0；stderr=${result.stderr}`)
  // 输出契约：`--json` 的那一行是 `JSON=<单行 JSON>`（见 cli.mjs 的 printJson）
  const line = result.stdout.split('\n').find((text) => text.startsWith('JSON='))
  assert.ok(line, `${argv.join(' ')} 的 --json 输出里没有 JSON= 行：\n${result.stdout}`)
  return { raw: result.stdout, json: JSON.parse(line.slice('JSON='.length)) }
}

/** 遍历元素数组，对每个元素的 patterns 做形状断言。 */
function assertAllShapesGood(elements, where) {
  for (const element of elements) {
    assert.ok(
      Array.isArray(element.patterns),
      `${where}: 元素 ${element.id} 的 patterns 不是数组（${JSON.stringify(element.patterns)}）—— 桥侧又把单元素拆包了`,
    )
    for (const item of element.patterns) {
      assert.equal(
        typeof item,
        'string',
        `${where}: 元素 ${element.id} 的 patterns 里有非字符串项（${JSON.stringify(element.patterns)}）—— 桥侧有两层包装叠在一起`,
      )
    }
  }
}

test('uia --depth：raw JSON 不许有双层包装指纹，每个元素的 patterns 都是字符串数组', () => {
  const { raw, json } = jsonCli(['uia', '--depth', '3'])
  // 判据 A：字面指纹。`"patterns":[[]]` / `"patterns":[["` 都是双层包装的形态。
  assert.equal(raw.includes('"patterns":[['), false, `raw JSON 里出现了双层包装：\n${raw.slice(0, 400)}`)
  assert.ok(json.elements.length > 0, 'uia --depth 3 至少要枚举到一个元素')
  assertAllShapesGood(json.elements, 'uia --depth')
})

/** 从树里挑一个"跨两次调用都还在"的样本：优先顶层窗口元素（它们不会在几秒内消失）。 */
function pickStableSample(tree) {
  const usable = tree.elements.filter((element) => typeof element.id === 'string' && element.id.startsWith('el_'))
  const window = usable.find((element) => element.controlType === 'Window')
  return window ?? usable[0]
}

test('uia --id：同一元素的两条路径给出逐值相同的 patterns（契约断言）', () => {
  const tree = jsonCli(['uia', '--depth', '3']).json
  // 挑一个在树上出现、且两条路径都能查到的元素
  const sample = pickStableSample(tree)
  assert.ok(sample, 'uia --depth 3 的输出里应当有 el_ 开头的元素 id')

  const single = jsonCli(['uia', '--id', sample.id], { timeoutMs: 120000 })
  assert.equal(single.raw.includes('"patterns":[['), false, `uia --id 的 raw JSON 里出现了双层包装：\n${single.raw.slice(0, 400)}`)
  assert.equal(single.json.found, true, `uia --id ${sample.id} 应当 FOUND=true`)

  // 契约：`--id` 走的是**同一份快照**，命中信息在 `found` + 该 id 在 elements 里的那一项。
  // （`--id` 不裁剪 elements —— 下游 `invoke` 就是拿这份快照 + pickElement 定位的。）
  const hits = single.json.elements.filter((element) => element.id === sample.id)
  assert.equal(hits.length, 1, `同一个 el_id 在快照里必须唯一；got=${hits.length}`)
  assertAllShapesGood(hits, `uia --id ${sample.id}`)

  // 判据 B：两条路径的同一条信息必须逐值相同（形状修好前这里是 `[]` vs `[[]]`）
  assert.deepEqual(
    hits[0].patterns,
    sample.patterns,
    `同一元素在两条路径下的 patterns 必须一致：--depth=${JSON.stringify(sample.patterns)}，--id=${JSON.stringify(hits[0].patterns)}`,
  )
})

test('uia --id 的 JSON 形状：patterns 是数组、id/controlType 可复现、文本行与 JSON 同源', () => {
  const tree = jsonCli(['uia', '--depth', '3']).json
  const sample = pickStableSample(tree)
  const single = jsonCli(['uia', '--id', sample.id], { timeoutMs: 120000 }).json

  // 把 --id 路径的形状钉死：下游 invoke 就是按 elements[i].patterns 取值的
  assert.ok(Array.isArray(single.elements), 'uia --id 的 JSON 必须给 elements 数组')
  const element = single.elements.find((item) => item.id === sample.id)
  assert.ok(element, `uia --id 的快照里必须能找到 ${sample.id}`)
  assert.equal(element.controlType, sample.controlType, '同一条信息在两条路径下必须一致')
  assert.ok(Array.isArray(element.patterns), `patterns 必须是数组；got=${JSON.stringify(element.patterns)}`)
})

test('文本渲染：patterns 那一列的 `-` 只代表"真的没有 pattern"，不代表形状坏了', () => {
  // 只跑**一次** uia：桌面上的窗口会在两次调用之间出现/消失，跨调用比对行数必然抖动。
  const { raw, json } = jsonCli(['uia', '--depth', '3'])
  // 逐行核对：EL 行第 4 列必须与该元素 JSON 里的 patterns 严格对应
  const rows = raw.split('\n').filter((line) => line.includes('EL | '))
  assert.ok(rows.length > 0, 'uia --depth 3 应当打出 EL 行')
  for (const row of rows) {
    const cells = row.trim().split(' | ')
    const id = cells[1]
    const patternsCell = cells[3]
    const element = json.elements.find((item) => item.id === id)
    assert.ok(element, `EL 行的 id ${id} 在本次快照的 JSON 元素里找不到：${row}`)
    const expect = element.patterns.length === 0 ? '-' : element.patterns.join(',')
    assert.equal(patternsCell, expect, `元素 ${id} 的 patterns 列与 JSON 不一致（列序：el_id | ControlType | patterns | rect | automationId | name）`)
    assert.notEqual(patternsCell, '', `元素 ${id} 的 patterns 列不许是空串`)
  }
})

test('形状坏掉时 CLI 会自己报 WARN（不再静默伪装成"没有 pattern"）', () => {
  // 这一条钉的是"兜底不许掩盖缺陷"：`uia` / `point` / `invoke` 三条路径在渲染 patterns 之后
  // 都要跑一次 patternShapeProblem()，坏形状必须落成一行 WARN=。当前桥侧已修好，
  // 所以正常输出里**不该**出现这行 —— 出现了就说明形状缺陷回来了。
  const uia = runCli(['uia', '--depth', '2'], { timeoutMs: 120000 })
  assert.equal(uia.code, 0)
  assert.equal(
    /^WARN=.*patterns 形状异常/m.test(uia.stdout),
    false,
    `uia 报了 patterns 形状异常 —— 桥侧的包装又叠了一层：\n${uia.stdout.split('\n').filter((l) => l.startsWith('WARN')).join('\n')}`,
  )

  const point = runCli(['point', '--x', '100', '--y', '100'], { timeoutMs: 120000 })
  assert.equal(point.code, 0)
  assert.equal(
    /^WARN=.*patterns 形状异常/m.test(point.stdout),
    false,
    `point 报了 patterns 形状异常：\n${point.stdout}`,
  )
})