# Task Queue — 治理域入口

一个演示用的最小治理域（adg-doc-criterion 的满分样张）：一个内存任务队列模块 queue，配一份当前真相（design）与一份未来意图（roadmap）。照着这套结构写，就能同时通过机检与对抗评审。

## 命令

```sh
npm test          # 跑 queue 的单测
node check-docs.mjs .   # 机检本治理域文档（adg-doc-criterion 自带脚本）
```

## 关键红线

1. 任务只能经 queue.enqueue() 入队，禁止直接改内部数组 —— 来源：评审决定（防越权改状态）。
2. 文档引用一律用「文件 + 符号名」作锚，禁止写行号 —— 行号是派生坐标，一改就静默指错。

## Project Map

| 模块 | 一句话职责 | 规则见 |
|---|---|---|
| queue/ | 内存任务队列：入队、出队、并发上限 | queue/design.md |

## 版本区

| 文档 | 一句话 |
|---|---|
| queue/design.md | queue 的当前真相（数据模型、不变量、接口） |
| queue/testing-guide.md | queue 的用例总表与迁移矩阵 |
| roadmap.md | queue 的未来意图（在办 / 已定待做 / 待决策 / 明确不做） |

## Quality Gates

| 检查项 | 载体 | 期望结果 |
|---|---|---|
| 文档机检 | [机检] node check-docs.mjs . | exit 0 |
| 红线与理由抽查 | [评] 对抗评审子智能体 | 无 FAIL 项 |

## 阅读顺序（阅读顺序，非施工步骤）

先读本文件 → queue/design.md → queue/testing-guide.md。
