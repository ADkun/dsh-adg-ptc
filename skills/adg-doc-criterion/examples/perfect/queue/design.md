---
title: queue 模块设计
owner: 示例团队
status: current
last_reviewed: 2025-01-01
---

# queue 模块设计

内存任务队列：接收任务、按并发上限出队执行、跟踪完成状态。

## 职责与边界
负责：任务的入队、出队与并发上限控制。
不负责：任务的持久化（见 roadmap 的「明确不做」）。

## 依赖关系
- 依赖：无（纯内存实现，无需经契约）
- 被依赖：调度器（消费 queue.enqueue() 与 queue.run()）
- 跨模块改动路由：动到任务语义时先读本文件与 queue/testing-guide.md

## 核心数据模型

### Task（不可变值对象）
- 属性：id（唯一）、payload（任务体）、state（pending/running/done/failed）
- 不变量：
  - I1: 一个 Task 的 id 在队列内唯一。
  - I2: state 只能沿 pending→running→done 或 pending→failed 迁移，禁止跳跃。

### Queue（生命周期型）
- 属性：concurrency（并发上限）、tasks（Task 集合，只经方法访问）
- 状态机：mermaid stateDiagram-v2（给人 5 秒看懂；逐格迁移矩阵见 testing-guide）
- 不变量：
  - I3: 同一时刻处于 running 的 Task 数不超过 concurrency。
  - I4: 状态只能经内部 _transition() 变更，禁止绕过对象直接改 state。

## 对外接口
enqueue(task)、run()、stats()；字段完整定义以源码导出为准，此处只给语义。

## 非功能红线
- [机检] concurrency 默认 1、禁止无限并发 —— 来源：评审决定（防内存打爆）。
- [评] 出队不阻塞调用方 —— 来源：压测结论（同步实现会让生产者卡死）。

## For Agents
动手前读 queue/testing-guide.md；绝不能直接改 tasks；state 只能经 _transition() 改；拿不准并发语义就停下升级人类。

## 测试与验证
见 [testing-guide.md](testing-guide.md)。
