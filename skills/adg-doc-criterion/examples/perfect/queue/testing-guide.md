---
title: queue 模块测试指南
owner: 示例团队
status: current
last_reviewed: 2025-01-01
---

# queue 测试指南

## 用例总表

| 用例ID | 对象 | 断言内容 | 对应不变量 | 载体 |
|---|---|---|---|---|
| T1 | Task | 重复 id 入队被拒 | I1 | [机检] |
| T2 | Task | pending→done 的非法跳转被拒 | I2 | [机检] |
| T3 | Queue | 并发不超过 concurrency | I3 | [机检] |
| T4 | Queue | 绕过 _transition() 改 state 报错 | I4 | [机检] |

## 迁移矩阵

| 源\事件 | enqueue | complete | fail |
|---|---|---|---|
| pending | running | 非法 | failed |
| running | 非法 | done | failed |

## 消费方契约测试
调度器对 enqueue/run 的契约理解在 queue 单测内覆盖，契约变更时先跑本表。

## 人工 review 项
无（本表用例均可机检）。
