# realtime_core · 对外接口契约（v1.1.0 · 正式）

> 本文件是 realtime_core 对外行为的**唯一事实**。自 P5 起为**正式契约**：下列公共 API 面、端口契约与不变量承诺表构成 semver v1.0.0 的冻结基线——破坏任何一项 = major。realtime_core 是**领域无关的实时/状态机内核库**（纯 ESM、零 runtime 依赖、无服务进程），由消费方 `import` 使用。
>
> 治理状态：模块当前孵化于 `dev/realtime_core/`（lightweight）。`v1.0.0` git tag 由 CFO 在合并后的 main squash commit 上打（本仓不自打 tag）；"迁入 `0/` 平台层"（CR、`0/AGENTS.md` 顶层结构、CONTRACTS-INDEX 登记）**待 CFO 治理流程**，不属本契约文件的职权。

## 契约索引声明（provides / consumes）

```yaml
provides:
  - id: realtime-core-kernel@v1.1.0
    summary: 领域无关的实时/状态机内核——long-poll 生命周期 reducer + 命令分发 + 频道广播 + keyed 锁 + 会话内核（事件日志/游标投递/decide-evolve 聚合/事件版本化/崩溃重放）+ 声明式状态机工具；零 runtime 依赖。
consumes: []   # 零依赖是卖点：内核不依赖任何平台契约或第三方包
```

## 版本与 semver 政策

- **当前：v1.1.0（正式，冻结启用）**。**v1.1.0 相对 v1.0.x = minor（纯新增）**：新增 `session/logstore-conformance.js` 的 2 个导出符号（35 → 37 符号，16 → 17 文件）；既有 35 个导出符号的签名与语义、5 个端口的形状与义务、15 条不变量承诺逐字未动，既有 201 个测试零修改全绿（兼容门）。（`v1.0.1` 仅为仓根 `package.json` 打包垫片——加 `exports` map 使本库可作 git 依赖安装，零 API 变化。）
- **v1.0.0 冻结基线**。冻结面 = 本文件"公共 API 面"全部导出符号的签名与语义 + "端口契约"五端口形状与义务 + "不变量承诺表"全部条目。
- **major**（破坏性）：改/删任何导出符号的签名或既有语义；收窄端口义务；削弱任何不变量承诺；改/删信封既有字段。
- **minor**（新增能力）：新增导出符号；给既有函数加**可选**参数（缺省行为不变）；**枚举扩展**（`PollPhase`/`PollEventType`/`PollActionType` 等新增成员算 minor——消费方对枚举做穷尽 switch 时必须留 default 分支，这是消费方义务）；信封**新增**字段。
- **patch**：修 bug（向不变量承诺靠拢的行为修正）、文档、内部重构。
- **信封字段规则（单列）**：事件信封 `{streamId, seq, id, type, v, at, payload}` 七字段**只加不改**——既有字段的名字、类型、语义永不变更（变更 = major）；新增字段 = minor 且必须向后兼容（旧信封缺新字段时库有定义好的缺省行为）。
- **事件版本化与升级链规则（单列）**：`v` 是**每类事件的 payload schema 版本**，由消费方聚合的 `eventVersions` 声明（库缺省 1）。升级链逐级 `v→v+1`（可级联）；**库拥有版本号**（upcaster 只变换形状，库强制盖 `v=from+1`）；缺升级函数遇旧版本 = 响亮 throw；`v >` 当前版本（回滚读新日志）= 响亮 throw。这些 throw 语义是契约承诺（禁静默放行），弱化它们 = major。
- **消费方引用方式**：git tag 固定版本（`v1.0.0` 起启用，见 rules.md 跨仓依赖机制）。

## 公共 API 面（5 scope · 17 文件 · 37 导出符号）

以下每个符号的签名与语义均为冻结承诺。约定：**"响亮 throw" = 编程错误**（TypeError/Error/专用错误类），**结构化返回 = 业务结果**（如 `reject`、`{ok:false}`）——两者不混用是全库统一语义。

### transport/ —— 实时传输内核（4 文件 · 13 符号）

#### `src/transport/core/poll-machine.js`（纯 reducer，零 io/时钟/随机/import）

| 符号 | 签名与承诺 |
|---|---|
| `PollPhase` | 冻结枚举 `{INIT:'init', ATTEMPTING_INITIAL:'attempting_initial', WAITING:'waiting', RESOLVED:'resolved', TIMED_OUT:'timed_out', CLOSED:'closed', SUPERSEDED:'superseded'}`；后四者为终态 |
| `PollMode` | 冻结枚举 `{WAKEUP:'wakeup', INTERVAL:'interval'}` |
| `PollEventType` | 冻结枚举：`START`/`ATTEMPT_RESULT`/`ATTEMPT_ERROR`/`WAKEUP`/`POLL_TICK`/`SUPERSEDE`/`TIMEOUT`/`CLIENT_CLOSE` |
| `PollActionType` | 冻结枚举：`ATTEMPT`/`SUBSCRIBE`/`ARM_TIMER`/`ARM_INTERVAL`/`DISARM_INTERVAL`/`RESPOND`/`CLEANUP`/`DISCARD` |
| `initPoll(config?)` | → 初始状态对象 `{phase, responded, cleanedUp, subscribed, timerArmed, intervalArmed, inflight, mode, immediateFirstAttempt}`。`config = {mode?: 'wakeup'\|'interval', immediateFirstAttempt?: boolean}`；缺省 `wakeup`+`true`；`interval` 缺省 `immediateFirstAttempt:false`；非法 mode → TypeError |
| `isTerminalPhase(phase)` | → boolean（resolved/timed_out/closed/superseded） |
| `reduce(state, event)` | → `{state, actions[]}`。纯函数、不改入参；未知 `event.type` → TypeError（响亮）；终态后任何事件 → 原地 `DISCARD`；`ATTEMPT_RESULT` 可携带 `outcome`（缺省 `'settled'`）与 `result`（透传给 `RESPOND.payload`）；终态 teardown：interval 形态 `[DISARM_INTERVAL, CLEANUP]`，wakeup 形态 `[CLEANUP]` |

wakeup/interval 两形态状态图与逐相转移语义见源文件头注释（与本表一致；冲突时以本表+不变量表为准）。

#### `src/transport/core/dispatch.js`（纯命令表规整/查找）

| 符号 | 签名与承诺 |
|---|---|
| `normalizeCommandTable(table)` | → 规范化新表（不改入参）。非 plain object → TypeError；键 trim 后为命令名（空键忽略）；值为 null/undefined → TypeError；handler 形状不限（core 只管名字对得上） |
| `lookupCommand(table, cmd)` | → `{ok:true, name, handler}` \| `{ok:false, error:{kind:'unknown_command', cmd, detail}}`。`detail` 文案冻结：`unknown cmd <cmd.cmd>`。纯查找：不调用 handler、不 throw |

#### `src/transport/engine.js`（副作用壳：解释 reducer 动作）

| 符号 | 签名与承诺 |
|---|---|
| `longPoll(opts)` | → `Promise<void>`（进入终态并清理后 resolve，永不 reject）。`opts`：`attempt(phase)→Promise` 必填；`timeoutMs`+`timers{set,clear}` 必填；结算判定二选一——`classify(result)→{terminal, outcome?, payload?}`（多结局）或 `isSettled(result)→boolean`（等价 `outcome:'settled'`）；wakeup 形态需 `wakeup{subscribe}`+`wakeOn`+`pollKey`；interval 形态需 `mode:'interval'`+`pollIntervalMs`+`timers{setInterval,clearInterval}`；`respond`：`error(err)`/`timeout()`/`settled(payload)` 三键语义冻结，**其余 outcome 派发到同名 `respond[outcome](payload)`**（缺该键 = 静默忽略）；`onClientClose(cb)→off` 必填（断连 → 静默 closed 终态，无 respond）；可选 `registry`+`key` 启用同 key 顶替（新实例先向旧实例喂 SUPERSEDE 再登记自己；CLEANUP 按身份摘除，不误删后来者）。**已知微任务窗口（timeout 兜底，语义冻结）**：wakeup 形态下 publish/唤醒若落在 initial attempt（已 pull 空）与 SUBSCRIBE 生效之间的微任务窗口，本生命周期内不会再主动 attempt，事件延迟到 TIMEOUT（长轮询客户端随即重询补课）或下一生命周期 initial attempt 可见——P1 起即有、上限 `timeoutMs`，消费方不得假设"publish 后必即时唤醒" |
| `createDispatcher(commandTable, {onUnknown, onError}?)` | → `dispatch(cmd, ...ctx)`。查表命中调 handler（同步 throw 与异步 rejection 都走 `onError`）；未命中走 `onUnknown(error, cmd, ...ctx)`；两回调缺省 = 静默。ctx 原样透传 |
| `createPollRegistry()` | → `Map<key, superseder>`。跨多次 `longPoll` 共享以实现同 key 顶替；就是普通 Map（承诺仅此形状） |

#### `src/transport/channels.js`（频道广播注册表）

| 符号 | 签名与承诺 |
|---|---|
| `createChannels()` | → `{join(scopeKey, conn), leave(scopeKey, conn), broadcast(scopeKey, payload), count(scopeKey)}`。每次调用独立实例。`broadcast`：payload 只 `JSON.stringify` 一次复用；跳过 `!conn.isOpen()`；单连接 `send` 抛错吞掉继续发（摘除只在显式 `leave`）。conn 形状见端口契约 |

### concurrency/ —— keyed 串行锁（1 文件 · 4 符号）

#### `src/concurrency/locks.js`

| 符号 | 签名与承诺 |
|---|---|
| `withLock(key, fn)` | → `fn` 的 Promise。同 key promise-chain 串行；非重入、无超时；错误不断链（前一环 reject 不影响下一环执行）；返回值/异常原样透传给调用方。key 经 `String(key \|\| 'global')` 归一 |
| `awaitIdle()` | → `Promise<void>`。等**全部** key 的锁链排空（含等待期间新入链的）后 resolve；永不 reject；空闲时立即 resolve。优雅停机原语 |
| `sessionLockKey(sessionId)` | → `'session:<id>'`（空/缺省 → `'session:unknown'`）。〔遗产兼容面〕 |
| `skillLockKey(skillId)` | → `'skill:<id>'`（同上兜底）。〔遗产兼容面〕 |

**模块级锁状态说明（冻结语义）**：锁链注册表是**模块级单例**（同一进程内所有 import 共享同一命名空间）——这是从 copycat 逐字继承的既有行为，v1.0 冻结如现状；需要隔离实例的诉求留 v1.x 评估（新增工厂 = minor）。

### queue/ —— 事件排序与 id 生成（2 文件 · 4 符号）〔遗产兼容面〕

> **遗产兼容面**：本 scope 与 `sessionLockKey`/`skillLockKey` 是 copycat 换装期的兼容 API——命名带领域味（session/skill/turn/rounds），且 `ordering.js` 直接读 copycat 的 `session.rounds` 结构。v1.0 **冻结如现状**（copycat 换装期硬依赖）；中性化重命名属 major，登记为 v2/迁平台层专项（见 rules.md 技术债）。新消费方**不应**依赖本小节符号建模新数据（用 session/ 的日志+游标代替）。

#### `src/queue/ordering.js`

| 符号 | 签名与承诺 |
|---|---|
| `orderedSessionEvents(session, options?)` | → `[{event, slot, round}]`。跨 round 摊平，排序键 `seq → createdAt → round`；跳过 null slot 与无 `type` 事件；`slot.round` 缺省 = index+1；`options.assignMissing` 是老源哑参数（保留参数位、不分支）；`session` null/无 rounds → `[]` |
| `maxEventSeq(session)` | → number（最大 seq，无事件 = 0）。非有限 seq 忽略；**与投影不对称**：无 `type` 事件也计入（既有行为冻结）；`session=null` 直接抛（老源无兜底，冻结） |

#### `src/queue/ids.js`

| 符号 | 签名与承诺 |
|---|---|
| `genEventId(ctx)` | → `'evt-<clock>-<rand36>'`。`ctx={clock:()=>ms, rng:()=>[0,1)}` 注入，零全局读取。**是全库缺省事件 id 格式的唯一事实源**（P5 起 `sealEnvelopes` 复用它） |
| `genTurnId(ctx)` | → `'q-<clock>-<rand36>'`。两段式操作稳定 id（copycat 预备用途）。〔遗产兼容面〕 |

### session/ —— 会话内核：日志+游标投递（P3a）与 decide/evolve 聚合（P3b）（9 文件 · 13 符号）

#### 事件信封（框架字段，库只认这些）

`{streamId, seq, id, type, v, at, payload}`——`seq` 流内严格单调、连续、从 1 起，日志层分配（调用方带 `seq`/`at`/`streamId` = TypeError）；`v` = payload schema 版本（正整数，缺省 1）；`at` = 注入 clock 的毫秒时间戳（库内零 `Date.now`）；`id` 调用方可自带，缺省 `genEventId` 格式（id 的时间戳分量 === 信封 `at`）；`payload` 库完全不解释、不校验、不冻结（领域无关红线；**引用不拷贝**——调用方不得改已发布的 payload）。信封对象 `Object.freeze`。字段演进规则见"semver 政策"。

#### `src/session/errors.js`

| 符号 | 签名与承诺 |
|---|---|
| `ConflictError` | `extends Error`；`{name:'ConflictError', streamId, expected, actual}`。append CAS 冲突专用；调用方以 `err.name === 'ConflictError'` 识别（不强依赖 instanceof，跨 realm 安全）。游标违规（回退/越界/越过高水位）用内建 `RangeError`，**不是** ConflictError（编程错误 vs 可重试并发冲突的区分冻结） |

#### `src/session/envelope.js`

| 符号 | 签名与承诺 |
|---|---|
| `sealEnvelopes({streamId, lastSeq, events, clock, rng})` | → 冻结信封数组（seq 从 `lastSeq+1` 连续）。纯校验+构造（不写存储）；输入事件只许 `{type, v?, id?, payload?}` 四键——带 `streamId`/`seq`/`at` 或未知键 → TypeError；空数组/非对象/非法 v/非法 id → TypeError。主要供持久化适配器复用，一般消费方经 publish/execute 间接使用 |

#### `src/session/memory-log-store.js`

| 符号 | 签名与承诺 |
|---|---|
| `createMemoryLogStore({clock, rng})` | → logStore 端口的内存参考实现（形状与义务见端口契约）。clock/rng 缺失 → TypeError（无弱默认值）。每次调用独立实例；测试与轻量场景用，真实持久化由消费方按端口契约自带适配器 |

#### `src/session/delivery.js`

| 符号 | 签名与承诺 |
|---|---|
| `WAKE_KIND_APPENDED` | 常量 `'appended'`——publish 发出的唤醒 kind（自组装等待层时对齐用） |
| `createDelivery({logStore, wakeup, longPoll?})` | → `{publish, pull, ack, subscribe}`。`logStore`+`wakeup{emit}` 必注入（缺 → TypeError）；`longPoll` 只在用 `subscribe` 时必需（注入 `transport/engine.js` 的同名函数——session/ 生产代码零 transport import，等待机制以能力注入复用）。**`publish(streamId, events, {expectedLastSeq?})`**：append + `wakeup.emit(streamId,'appended')`；缺省"追加到尾"（尾指针缓存 + CAS 兜底重读重试一次，第二次错误原样上抛）；显式 `expectedLastSeq` 走严格 CAS，冲突原样上抛且不发唤醒。**`pull(streamId, group, {limit?})`**：读游标后的事件，**不动游标**（at-least-once：未 ack 必重投，消费侧需幂等）。**`ack(streamId, group, seq)`**：前缀确认，游标前移到 seq（确认 ≤seq 全部）；越过本实例已 pull 高水位 → RangeError（崩溃重建后高水位归游标——先重新 pull 再 ack）；回退 → RangeError；同 seq 幂等。**`subscribe(streamId, group, {timers, timeoutMs, respond, onClientClose, limit?, registry?, key?})`**：经注入 longPoll 长轮询——有积压立即 `respond.settled(batch)`，否则等 publish 唤醒；超时/断连/顶替语义 = 引擎原生（含 longPoll 条目所述微任务窗口）；同 group 多订阅共享一枚游标 |

#### `src/session/aggregate.js`

| 符号 | 签名与承诺 |
|---|---|
| `reject(code, detail?)` | → 冻结拒绝标记。code 非空字符串必填（否则 TypeError）。**结构化业务拒绝（非 throw）**——throw 只留给编程错误，此分界全库冻结 |
| `isReject(value)` | → boolean（内部 Symbol 标记判定，伪造普通对象不算） |
| `defineAggregate(spec)` | → 冻结纯描述对象 `{name, schemaVersion, initial, currentVersion(type), decideCommand(state,cmd,ctx), upcast(event), applyEvent(state,event)}`。`spec = {name, initial, decide, evolve, upcasters?, eventVersions?, onUnknownEvent?, schemaVersion?}`：`decide[cmdType](state,cmd,ctx)→events[]\|reject(code)`；`evolve[evType](state,event)→newState`（纯折叠，禁 throw/副作用）；`ctx` 注入 clock/rng/actor（actor 库不解释透传）；未知命令/decide 返回非数组非 reject/事件缺 type → 响亮 TypeError；`evolve` 缺 handler：`onUnknownEvent:'throw'`（缺省）响亮 throw，`'ignore'` 原样返回 state；`eventVersions{type:n}` 声明当前版本（缺省 1）；`schemaVersion`（缺省 1）随快照落盘，不匹配即弃快照全量重建；spec 校验失败 → TypeError |

#### `src/session/upcaster.js`

| 符号 | 签名与承诺 |
|---|---|
| `upcastEvent(event, {upcasters, currentVersion})` | → `v === 当前版本` 的事件（新对象，未冻结的临时视图）。逐级 `v→v+1` 级联；库强制盖版本号；缺升级函数/来自未来/升级函数返回非对象 → 响亮 throw（语义见"semver 政策·事件版本化"） |

#### `src/session/memory-snapshot-store.js`

| 符号 | 签名与承诺 |
|---|---|
| `createMemorySnapshotStore()` | → snapshotStore 端口的内存参考实现（形状与义务见端口契约）。put 拷贝存入、get 拷贝取出（structuredClone 防御性深拷贝——state 须为可克隆纯数据）；只保留最新一枚 |

#### `src/session/aggregate-runtime.js`

| 符号 | 签名与承诺 |
|---|---|
| `createAggregateRuntime({aggregate, logStore, locks?, wakeup?, snapshotStore?, snapshotEvery?})` | → `{execute, load}`。**`execute(streamId, command, ctx)`** → `Promise<{events, state} \| {rejected:{code, detail}}>`：注入 `locks{withLock}` 时全程在 `withLock('stream:<id>')` 内（信箱串行第一道防线；未注入则裸跑）；流程 = 重放 → decide → **经 `delivery.publish` 严格 CAS append**（append 路径全库唯一，聚合层与投递层写日志语义逐字一致）→ 读回落盘信封用与 load 相同折叠推进状态 → 跨 `snapshotEvery`（缺省 50）边界滚动落快照。reject → 无事件、不动日志、不改状态；decide 产零事件 → `{events:[], state}` 无痕 no-op；CAS 冲突（锁失效/并发漏网）→ `ConflictError` 响亮上抛，**不静默重试**。`wakeup` 可选（缺省 no-op，纯聚合场景无订阅者）。**`load(streamId)`** → state（快照 + 尾部重放，逐条 upcast→evolve）。依赖形状不合法 → TypeError |

#### `src/session/logstore-conformance.js`（logStore 端口一致性套件 · v1.1.0 新增）

| 符号 | 签名与承诺 |
|---|---|
| `runLogStoreConformance({createStore, seeds?, steps?})` | → `Promise<{checks: string[], passed: number}>`。对一个 logStore 适配器跑完整的端口义务套件（10 项检查，覆盖 append CAS / 并发 CAS（同一 `expectedLastSeq` 多路并发恰好一个胜者）/ 整批原子 / seq 连续从 1 / read 窗口 / 游标只进与幂等 / 越界 RangeError / 多流隔离 / 固定种子模糊比对）。**`createStore()` 每次调用必须返回全新空存储**（可返回 Promise），套件每项检查各取一个；对每个端口调用都 `await`，**异步适配器合法**。任一违约 → throw，`err.name = 'LogStoreConformanceError'`、`err.check` = 违约检查名、message 前缀 `[检查名]`；**适配器在预期成功的调用中泄漏的原始异常同样被重包成该形状，原错误挂在 `err.cause`**（不吞、可追）；全过即返回。`seeds`（缺省 `[1,2,3]`）与 `steps`（缺省 `60`）供慢适配器调小；`createStore` 非函数 / `seeds` 非非空整数数组 / `steps` 非正整数 → TypeError。零 import（不依赖测试框架，任意 runner 可用） |
| `LOG_STORE_CONFORMANCE_CHECKS` | 冻结的检查名数组（稳定顺序，当前 10 项）。**枚举扩展**：后续版本新增检查项 = minor，消费方不得假设长度或下标固定 |

**定位**：本套件是端口契约"实现方义务"的**可执行规格**——适配器作者跑通它即算达标，不必自行重写 CAS/游标断言。它**不替代**消费方对自己领域逻辑的测试，也不检验性能与事务隔离级别。

### machine/ —— 声明式状态机工具（1 文件 · 3 符号）

#### `src/machine/define-machine.js`

| 符号 | 签名与承诺 |
|---|---|
| `defineMachine(spec)` | → 冻结不可变机器 `{id, initial, states(冻结数组), finalStates(冻结数组), transition, can, assertState}`，全部方法纯函数。`spec = {id, initial, states:{<name>:{on?:{<EVT>:{target, guard?}}, type?:'final'}}, guards?:{<name>:(ctx,event)=>boolean}}`。**定义期全面校验**（每条非法 = 调用时响亮 `MachineDefinitionError`，携 id+位置）：id/initial/状态名/事件名非空字符串；initial ∈ states；target 指向存在状态；final 不得声明 on（终态无出边）；type 只许 `'final'`；guard 引用必在 guards 表；状态键只许 on/type、转移键只许 target/guard（未知键严格拒绝——JS 字面量静默折叠重复键无法运行时检测，以此为等价响亮收益）。`transition(state, event, ctx?)` → `{state, changed}` \| 响亮 `IllegalTransitionError`；`can(state, event, ctx?)` → boolean 不抛（`can===true ⟺ transition 成功`）；`assertState(value)` → 原值 \| 响亮 throw（裸字符串逃逸断言，可链式）。**guard 契约**：`(ctx, event)→boolean` 纯谓词，`event` 为事件名字符串；guard 抛异常 = 编程错误，`transition` 与 `can` 都**原样上抛不吞** |
| `MachineDefinitionError` | `extends Error`；`{name, machineId, where}`（`where` 如 `states.asking.on.ANSWER.target`） |
| `IllegalTransitionError` | `extends Error`；`{name, machineId, reason ∈ {'unknown-state','event-not-handled','guard-rejected'}, from, event, guard?}` |

**与 decide 的组合边界（定位冻结）**：machine 只回答"允许吗 / 到哪去"，不产出事件、不折叠领域状态——是 decide 内部合法转移判定的**可选辅助**，不是聚合的替代。

## 端口契约（port）——五个注入接口的形状与实现方义务

库对外的可扩展点全部是**注入端口**：库只依赖下列形状，实现方（消费方/适配器作者）承担所列义务。参考实现（`createMemoryLogStore`/`createMemorySnapshotStore`/引擎内建）是义务的可执行规格。

### ① logStore（事件日志 + 游标持久化；`createDelivery`/`createAggregateRuntime` 注入）

```
append(streamId, expectedLastSeq, events[]) → {lastSeq} | throw ConflictError
read(streamId, fromSeqExclusive, limit?)    → 冻结信封[]（seq 升序）
getCursor(streamId, group)                  → seq（无记录 = 0）
advanceCursor(streamId, group, seq)         → void
```

实现方义务：**append 是 CAS**——`expectedLastSeq ≠ 当前 lastSeq` 必须抛 `ConflictError`（携 streamId/expected/actual），且**整批原子**（不存在半批可见）；seq 由日志层分配、流内连续从 1 起；信封构造用 `sealEnvelopes`（校验失败时日志分毫未动）。**read** 返回 `seq > fromSeqExclusive` 的信封、最多 limit 条。**advanceCursor 只进不退**：回退 → RangeError；同 seq 幂等 no-op；越过日志末尾 → RangeError（不给不存在的事件立书签）。异步实现合法（runtime 已 `await` 兼容）。

**达标方式（v1.1.0 起）**：实现方用 `runLogStoreConformance({createStore})` 对自己的适配器跑通全部检查即视为满足上述义务；`createMemoryLogStore` 是该套件的第一个通过者。**不跑套件的适配器不得声称满足本端口。**

### ② snapshotStore（聚合快照；`createAggregateRuntime` 可选注入）

```
get(streamId)                → {state, lastSeq, aggregateSchemaVersion} | undefined
put(streamId, {state, lastSeq, aggregateSchemaVersion}) → void
```

实现方义务：get/put 之间**隔离**（取出的 state 被调用方改动不得污染存储——序列化或深拷贝）；快照是纯加速，实现可任意丢弃（库总能从日志全量重建）；`aggregateSchemaVersion` 必须原样保存（库靠它判快照失效）。

### ③ timers（定时器；`longPoll`/`subscribe`/`serveSse` 注入）

```
set(fn, ms) → handle     clear(handle) → void                    // 一次性（必须）
setInterval(fn, ms) → handle   clearInterval(handle) → void      // 周期（仅 interval 形态必须）
```

实现方义务：`clear`/`clearInterval` 对已触发/已清除的 handle 幂等安全。测试注入假 timers 即可完全控制时序（引擎内零全局定时器）。

### ④ wakeup（唤醒信号总线；`createDelivery`/`longPoll` 注入）

```
emit(pollKey, kinds)                → void        // kinds: string | string[]
subscribe(kinds, listener) → unsubscribe          // listener(pollKey) 同步回调
```

实现方义务：`subscribe` 返回的注销函数幂等；`emit` 同步派发给当时已订阅的 listener（不缓存、不重放——错过即错过，靠 pull/timeout 兜底，见 longPoll 微任务窗口条目）；delivery 的 publish 固定用 kind `WAKE_KIND_APPENDED`、pollKey = streamId。

### ⑤ conn（连接写出口；`createChannels` 与 SSE 形态适配器用）

```
send(payload: string) → void        isOpen() → boolean
```

实现方义务：`isOpen()` 必须廉价可重复调用；`send` 失败可抛（channels 会吞掉继续发别家；自组装适配器自行决定）。同一形状通用于 WS 广播与 SSE 推流（`reference/sse-adapter.ref.mjs` 为实测证明）。

### 注入约定 ctx（横切）

`ctx.clock: () => number`（毫秒时间戳）与 `ctx.rng: () => number`（[0,1) 浮点）是全库唯一的非确定性来源形状——生产代码零 `Date.now`/`Math.random`（纯度门机械核）。聚合 `ctx` 另可携 `actor`（库不解释透传）。

## 消费方义务（违反即行为未定义，库不兜底）

1. **枚举留 default 分支**：对 `PollPhase`/`PollEventType`/`PollActionType` 等**枚举**做穷尽 switch 必须留 default——枚举扩展是 minor。`LOG_STORE_CONFORMANCE_CHECKS` 是**数组**（不是枚举）：遍历它、不得假设长度或下标固定。
2. **鉴权不得放进 `defineMachine` 的 guard**：guard 契约是 `(ctx, event) => boolean` **纯同步谓词**，返回 Promise 会被当作恒真值，鉴权形同虚设并破坏 I14（`can === true ⟺ transition 成功`）。正确形状：**身份校验在进入 `longPoll`/`delivery.subscribe` 之前一次性完成**（authorizeOnce），校验结果经聚合 `ctx.actor` 透传（库不解释、只透传）；guard 只读**已在 ctx 里的同步事实**。库内零鉴权表面——公网端点的平台鉴权与限流是消费方义务（本项目铁律 18）。
3. **`streamId` / `scopeKey` / `group` 的命名归消费方**：库把它们当**不透明字符串**，不解析、不校验、不赋予层级语义（`org:…/class:…` 之类的分层约定是消费方的事）。多租户隔离靠命名与消费方存储实现，**库不提供租户边界**。
4. **同一 `group` 共享一枚游标——重复投递，不是竞争消费**：`pull` 不动游标，所以同 group 的多个订阅者（同一用户的多个标签页、多个 worker 实例）**各自都会收到同一批未确认事件**（at-least-once 的自然结果，消费逻辑必须幂等）。真正的危险在 **`ack`**：任一订阅者的前缀确认会把**全组共享**的游标前移，其他订阅者从此再也见不到 `≤seq` 的事件——**哪怕它们还没处理**。三条出路按页面性质选：①同 group 但只让一个"权威"实例 `ack`，其余只读（最省）；②每个订阅者一个独立 group，各自游标互不干扰（游标记录随订阅者增长，回收归消费方——端口不提供删除游标的方法）；③用 `createPollRegistry()` + `longPoll` 的 `registry`/`key` 顶替，只保留最后一个连接（旧连接收 `superseded`）。**必须显式选一个**——默认行为是"都收到、但谁 ack 谁就替全组前移游标"。
5. **不得修改已发布的 `payload`**：信封冻结但 `payload` 是引用不是拷贝。
6. **`pull` 不动游标**：at-least-once，未 `ack` 必重投，消费侧逻辑需幂等。

## 不变量承诺表（契约级承诺 · 与测试互指）

下表每一行都是 v1.0.0 的**行为承诺**：削弱任何一条 = major。右列测试是承诺的机械锚点（固定种子 property test / 特征测试），**契约与测试互指**——改承诺必改测试，反之亦然。测试路径相对 `code/backend/`。

| # | 不变量承诺 | 测试锚点 |
|---|---|---|
| I1 | **至多回复一次**：任意事件序列下一个 poll 生命周期 RESPOND 至多产生一次 | `src/transport/core/poll-machine.property.test.mjs`（property·RESPOND 至多一次）；含 SUPERSEDE 的序列见 `poll-machine.extended.property.test.mjs`（不变量①） |
| I2 | **清理恰好一次**：到达终态则 CLEANUP 恰好一次（未到终态为 0），从不超过 | `src/transport/core/poll-machine.property.test.mjs`（property·CLEANUP 恰好一次） |
| I3 | **终态吸收（传输）**：终态后任何事件只产生 DISCARD——不再派发 ATTEMPT/POLL_TICK、不二次 RESPOND/CLEANUP | `src/transport/core/poll-machine.property.test.mjs`（property·终态后零派发 + 新竞态两用例）；`poll-machine.extended.property.test.mjs`（不变量②） |
| I4 | **顶替恰好一次**：SUPERSEDE 打进非终态 → 恰好一次 `RESPOND{outcome:'superseded'}` 并进入 superseded 终态 | `src/transport/core/poll-machine.extended.property.test.mjs`（不变量①两用例） |
| I5 | **interval 拆装配对**：interval 形态到终态 CLEANUP==1 且 DISARM_INTERVAL==1；wakeup 形态不产生 DISARM_INTERVAL | `src/transport/core/poll-machine.extended.property.test.mjs`（不变量③两用例） |
| I6 | **确认序列 = 连续前缀**：每 group 已确认序列恒等于日志的连续前缀（游标语义） | `src/session/log-cursors.property.test.mjs`（property①） |
| I7 | **seq 连续**：流内 seq 连续无空洞、从 1 起、多流独立；同一快照 K 路并发 append 恰好一个胜者、其余全 ConflictError、日志恰好多一批 | `src/session/log-cursors.property.test.mjs`（property②③） |
| I8 | **游标单调**：游标只前进——回退/越界攻击恒 RangeError 且零副作用；ack 越过已 pull 高水位恒 RangeError 且游标不动 | `src/session/log-cursors.property.test.mjs`（property④⑤） |
| I9 | **崩溃重建保不变量**：高频崩溃重建（丢全部内存态、仅剩 logStore）下 I6–I8 每步仍成立、日志完好 | `src/session/log-cursors.property.test.mjs`（property⑥，p=0.5 崩溃率）；断线重连特征测 `reference/classroom-feed.ref.test.mjs`、`reference/sse-adapter.ref.test.mjs`（重连续读用例） |
| I10 | **重放确定性**：快照 present/absent/behind 三形态的 load 恒等于影子模型（execute 后内存态 ≡ 崩溃后重建态） | `src/session/aggregate.property.test.mjs`（property①） |
| I11 | **拒绝无痕**：被拒命令不动日志、不改状态、不发唤醒——日志长度/游标/重建态纹丝不动 | `src/session/aggregate.property.test.mjs`（property①②） |
| I12 | **evolve 只见当前版本**：任意旧版本日志经升级链重放，evolve 收到的每个事件 `v` 恒 === 当前版本 | `src/session/aggregate.property.test.mjs`（property③）；v1→v2 全链路特征测 `reference/classroom-aggregate.ref.test.mjs` |
| I13 | **execute 串行等价**：并发 execute 同 stream（带锁）结果等价于串行、seq 连续、零 CAS 冲突；去锁反证——并发触发响亮 ConflictError（冲突不被静默吞） | `src/session/aggregate.property.test.mjs`（property④⑤） |
| I14 | **状态封闭（machine）**：任意事件序列下 transition 结果恒 ∈ states 全集，且 `can===true ⟺ transition 成功` | `src/machine/define-machine.property.test.mjs`（property①） |
| I15 | **终态吸收（machine）**：进入 final 后任何事件恒 throw 且 can=false——机器不可复活 | `src/machine/define-machine.property.test.mjs`（property②） |

**兼容门（持续性承诺）**：上表之外，全部既有单测/特征测（v1.0.0 时点 187 个）构成行为快照——patch/minor 版本必须零修改全绿。

## 明确非目标（v1.0 不提供，需求出现另走版本化扩展）

- **层级/并行状态机、entry/exit actions、invoke/actor、延迟转移、字符串 target 简写**：defineMachine 只做平表（YAGNI，评估记录见 rules.md P4/P5）；纳入任何一项 = minor（新增能力）或按需 v2。
- **跨进程/分布式分片**：锁、channels、registry、wakeup 都是进程内原语；跨进程一致性靠 logStore 端口的 CAS（实现方可用 DB 唯一约束落地），但库不提供分片/选主/集群协议。
- **持久化存储实现**：只有端口契约 + 内存参考实现；真实适配器（SQLite/Postgres/…）随首个消费方落地（rules.md 技术债跟踪）。
- **copycat `services/realtime/classroom.js` L2 糖层**：未随抽取（P1 决策 2：无生产消费方，抽了就是死代码）；copycat 换装期若需要再按契约组装。
- **HTTP/WS/SSE 服务器表面**：库不起进程、不带路由；`reference/` 各适配器是组装示例（**不属契约面**），传输接线归消费方。
- **重复键定义检测**：JS 对象字面量静默折叠重复键，运行时不可检测；以"未知键严格拒绝"为等价响亮校验（machine 条目已注明）。

## 入口与路由 / 依赖 / 数据 / 配置

- **入口**：无 HTTP/nginx 表面——库（ESM 模块集），消费方 `import`；无内部服务名/端口。
- **依赖的外部契约**：无（零 runtime 依赖，含零第三方包；不消费任何平台契约）。
- **数据与存储**：库不拥有持久化数据；日志/游标/快照只有内存参考实现，真实数据落消费方名下（铁律 7）。无 data root、无备份/清理需求。
- **配置与密钥**：无 env/密钥表面。

## 跨仓依赖机制

- 消费方引用 realtime_core **用 git tag 固定版本**；`v1.0.0` 起正式启用（tag 由 CFO 合并后在 main squash commit 上打）。

## 变更记录

| 日期 | CR | 变更 |
|---|---|---|
| 2026-07-19 | 无（dev 孵化，无 CR） | v0.1 骨架建立：copycat 实时内核逐字抽取，七文件导出符号登记，正式契约留待 P5 |
| 2026-07-19 | 无（dev 孵化，无 CR） | P2 内核扩展（向后兼容）：`PollMode`、`PollPhase.SUPERSEDED`、`POLL_TICK`/`SUPERSEDE`、`ARM_INTERVAL`/`DISARM_INTERVAL`、`initPoll(config)`、`longPoll` classify/registry/key/interval 注入、`createPollRegistry()`、`awaitIdle()`。既有 48 测试零修改全绿 |
| 2026-07-19 | 无（dev 孵化，无 CR） | P3a 会话内核（上）：`session/` 事件信封、存储端口 + `createMemoryLogStore`、`ConflictError`、`createDelivery`。既有 72 测试零修改全绿，四不变量 property 钉死 |
| 2026-07-19 | 无（dev 孵化，无 CR） | P3b 会话内核（下）：`defineAggregate`/`reject`/`isReject`、`upcastEvent`、`createMemorySnapshotStore`、`createAggregateRuntime`（append 路径唯一：复用 delivery.publish）。既有 110 测试零修改全绿，四不变量 property 钉死 |
| 2026-07-19 | 无（dev 孵化，无 CR） | P4 defineMachine 声明式转移表：平表 + 纯谓词守卫 + 定义期全面校验。既有 153 测试零修改全绿，两不变量 property 钉死，纯度门 56→61 |
| 2026-07-19 | 无（dev 孵化，无 CR） | **P5 契约正式化（本版）**：draft 全部转正 → v1.0.0 冻结基线（35 导出符号 · 5 端口 · 15 条不变量承诺表与测试互指）；semver 政策 + 信封"只加不改" + 升级链规则单列；遗产兼容面（queue/ + session·skill lock keys）标注冻结、中性化移交 v2/迁平台层；SSE 参考适配器实测三形态共用内核（`reference/sse-adapter.ref.mjs`）；收债：信封 id 去重到 `queue/ids.js`（纯度门白名单闭环 61→66）、`ordering.js` 补 8 专属测试；`longPoll` 微任务窗口（timeout 兜底）如实入契。既有 187 测试零修改全绿（201/201 总）。tag `v1.0.0` 待 CFO 于 main 打；迁平台层待 CFO 治理流程 |
| 2026-09-18 | CFO 裁决（就绪评估 PR #6 · D1） | **v1.1.0（minor · 纯新增）**：导出 logStore 端口一致性套件 `runLogStoreConformance` / `LOG_STORE_CONFORMANCE_CHECKS`（10 项检查，含并发 CAS 与固定种子模糊比对；违约与泄漏异常统一为 `LogStoreConformanceError`+`err.cause`），端口"实现方义务"从散文升级为可执行规格，消费方适配器跑通即达标；新增"消费方义务"节（枚举 default / 鉴权不进 guard / 命名归消费方 / 多标签页选型 / payload 引用 / at-least-once）。既有 35 符号 · 5 端口 · 15 不变量逐字未动，既有 201 测试零修改全绿（217/217），纯度门 66→71。同审 Codex sol + opencode 各 rejected 一轮（并发 CAS 漏检、本表第 4 条原表述与实现相反、错误未包装）→ 返修 de755c5。opus（backend@realtime_core）实现，项目 arbiter 执笔 |
