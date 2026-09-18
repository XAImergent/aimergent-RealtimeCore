# realtime_core

领域无关的**实时/状态机内核库**：long-poll 生命周期 reducer、命令分发、频道广播、keyed 串行锁、会话内核（事件日志 + 游标投递 + decide/evolve 聚合 + 事件版本化 + 崩溃重放）、声明式状态机工具。

- **纯 ESM、零 runtime 依赖**（无第三方包、无服务进程、无全局时钟/随机——一切非确定性走注入）。
- **对外行为唯一事实**：[`module_docs/contract.md`](module_docs/contract.md)（v1.1.0 正式契约：37 导出符号 · 5 端口 · 15 条不变量承诺，全部与测试互指）。
- **适配器达标方式**：自带 logStore 持久化实现的消费方，用 `session/logstore-conformance.js` 的 `runLogStoreConformance({ createStore })` 跑通 10 项端口一致性检查即算满足端口义务（v1.1.0 起）。
- 版本引用：git tag 固定（`v1.0.0` 起；当前 `v1.1.0`）。

## 三层一图

```
┌─ machine/    defineMachine —— 平表状态机（decide 的可选守卫辅助）        纯逻辑
├─ session/    聚合层  defineAggregate + createAggregateRuntime            命令→事件→状态
│              投递层  createDelivery（publish/pull/ack/subscribe）        日志+游标，at-least-once
│              日志层  logStore 端口（CAS append，seq 连续，游标只进）      持久化在这换真实现
└─ transport/  longPoll / createDispatcher / createChannels               等待·超时·断连·顶替·广播
   （concurrency/ withLock·awaitIdle 与 queue/ 横切其间；wakeup/timers/conn 全部注入）
```

三种传输形态（WS 广播 / long-poll / SSE）共用同一内核零改动——SSE = 顺序复合多个 poll 生命周期（实测见 `code/backend/reference/sse-adapter.ref.mjs`）。

## 最小示例

### 1) defineMachine——非法转移在定义期就响亮报错

```js
import { defineMachine } from './code/backend/src/machine/define-machine.js';

const machine = defineMachine({
  id: 'ticket',
  initial: 'open',
  states: {
    open:   { on: { ASSIGN: { target: 'working' } } },
    working:{ on: { DONE:   { target: 'closed', guard: 'hasResult' } } },
    closed: { type: 'final' },              // 终态无出边，机器不可复活
  },
  guards: { hasResult: (ctx) => Boolean(ctx?.result) },
});

machine.can('open', 'ASSIGN');                        // true
machine.transition('open', 'ASSIGN');                 // { state: 'working', changed: true }
machine.transition('closed', 'ASSIGN');               // throw IllegalTransitionError
```

### 2) defineAggregate + runtime——命令 → 事件 → 状态，崩溃可重放

```js
import { defineAggregate, reject } from './code/backend/src/session/aggregate.js';
import { createAggregateRuntime } from './code/backend/src/session/aggregate-runtime.js';
import { createMemoryLogStore } from './code/backend/src/session/memory-log-store.js';
import * as locks from './code/backend/src/concurrency/locks.js';

const counter = defineAggregate({
  name: 'counter',
  initial: () => ({ n: 0 }),
  decide: {
    add: (state, cmd) => (cmd.by > 0 ? [{ type: 'added', payload: { by: cmd.by } }]
                                     : reject('must-be-positive')),
  },
  evolve: { added: (state, ev) => ({ n: state.n + ev.payload.by }) },
});

const logStore = createMemoryLogStore({ clock: Date.now, rng: Math.random }); // 注入点在库外
const rt = createAggregateRuntime({ aggregate: counter, logStore, locks });

await rt.execute('c-1', { type: 'add', by: 2 });   // { events: [...], state: { n: 2 } }
await rt.execute('c-1', { type: 'add', by: -1 });  // { rejected: { code: 'must-be-positive' } }（无痕）
rt.load('c-1');                                    // { n: 2 } —— 崩溃后仅凭日志重建同一状态
```

### 3) delivery——多消费组独立游标，投递不丢

```js
import { createDelivery } from './code/backend/src/session/delivery.js';
// wakeup: {emit, subscribe} 形状自备（进程内事件总线即可）
const delivery = createDelivery({ logStore, wakeup });

delivery.publish('stream-1', [{ type: 'hello', payload: { msg: 'hi' } }]);
const batch = delivery.pull('stream-1', 'group-a');       // 游标不动（未 ack 必重投）
delivery.ack('stream-1', 'group-a', batch.at(-1).seq);    // 前缀确认，游标前移
```

### 4) longPoll——等待/超时/断连全托管的一次长轮询

```js
import { longPoll } from './code/backend/src/transport/engine.js';

await longPoll({
  wakeup, wakeOn: 'appended', pollKey: 'stream-1',
  timers: { set: setTimeout, clear: clearTimeout },
  timeoutMs: 25_000,
  attempt: async () => delivery.pull('stream-1', 'group-a'),
  classify: (batch) => (batch.length ? { terminal: true, payload: batch } : { terminal: false }),
  respond: {
    settled: (batch) => res.send(batch),   // 至多一次（契约不变量 I1）
    timeout: () => res.status(204).end(),
    error:   (err) => res.status(500).end(),
  },
  onClientClose: (cb) => { req.on('close', cb); return () => req.off('close', cb); },
});
```

> 组合捷径：`delivery.subscribe(streamId, group, {timers, timeoutMs, respond, onClientClose})` 已把 3)+4) 接好线。

## 跑测试 / 自检

```sh
cd code/backend && node --test --test-concurrency=1     # 201 用例，串行
node review/reviewcode/check-kernel-purity.mjs           # 纯度门 66 项（仓根执行）
```

更多：模块规则与技术债 [`module_docs/rules.md`](module_docs/rules.md)；接手便条 [`module_docs/handoff.md`](module_docs/handoff.md)；组装范例 `code/backend/reference/`（不属契约面）。
