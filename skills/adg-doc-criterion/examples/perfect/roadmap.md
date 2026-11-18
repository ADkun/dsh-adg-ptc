---
title: queue 治理域 roadmap
owner: 示例团队
status: current
last_reviewed: 2025-01-01
---

# roadmap（未来意图的唯一受控出口）

## 在办

| 目标 | 验收判据 | 状态 | 关联 |
|---|---|---|---|
| 支持优先级队列 | 高优先级任务先出队，且有对应用例 | in-progress | queue/design.md |

## 已定待做

| 目标 | 验收判据 | 状态 | 关联 |
|---|---|---|---|
| 并发可配置 | concurrency 可经构造参数设置，并有边界用例 | approved | queue/design.md |

## 待决策

| 目标 | 验收判据 | 状态 | 关联 |
|---|---|---|---|
| 任务失败重试 | 先定清重试次数与退避策略，再给用例 | needs-decision | queue/design.md |

## 明确不做

| 目标 | 理由 |
|---|---|
| 任务持久化 | 超出纯内存模块职责，交由上层存储处理 |
