# 2026-09-18 · backend · 「上课服务课堂同步」就绪评估 + 复用架构建议

任务来源：CFO 派单（tier normal，只读 code/、写文档、不改 contract.md、不 push）。
被评估基线：realtime_core **tag `v1.0.1`**（= `v1.0.0` 的 API + 仓根 `package.json` exports map 打包垫片；`git diff v1.0.0..v1.0.1` 只有 1 文件 19 行，**零 API 变化**）。
需求口径：仓主 2026-09-18——老师面板页二「课程模块选择」六边形 → 当堂课管理页（固定区＝在线检测 / 备课资料 / 右上角计时器；其余为该课特有面板），**预计十几门课、十几个当堂课页**，学生侧游戏页与老师页实时同步。
本地核验（先 `unset *_proxy`）：`node review/reviewcode/check-kernel-purity.mjs` = **66 PASS / 0 FAIL**；`cd code/backend && node --test --test-concurrency=1` = **201/201 全绿**；`bash ci/gates/run-gates.sh` = **🟢 全部门禁通过**。仓内**无** `review/reviewcode/run_all.sh`（gate 脚本自己报"跳过"）。

---

## A. v1.0.1 能力 ↔ 需求逐项打勾

行内路径相对仓根；`code/backend/` 下的源码用 `文件:行`。契约条目见 `module_docs/contract.md`。

| # | 需求 | 判定 | 内核落点（符号 / 文件:行 / 端口 / 不变量） |
|---|---|---|---|
| A1 | **教师推任务 / 指令** | ✅ 全覆盖 | 无聚合：`createDelivery().publish(streamId, events, {expectedLastSeq?})`（`src/session/delivery.js:36` 工厂、`:57` publish）；带业务规则：`createAggregateRuntime().execute(streamId, cmd, ctx)`（`src/session/aggregate-runtime.js:38`、`:136`）——`decide` 产事件、严格 CAS append、读回折叠、滚动快照。**全库仅一条写日志路径**（execute 复用 publish，`aggregate-runtime.js:15` 注释与 contract 一致）。「推给全班」= 循环逐 stream `execute`（每 stream 各自锁），旁路通知走 `channels.broadcast` |
| A2 | **学生长轮询** | ✅ 全覆盖 | `delivery.subscribe(streamId, group, {timers,timeoutMs,respond,onClientClose,limit?,registry?,key?})`（`src/session/delivery.js:102`）→ 注入的 `longPoll(opts)`（`src/transport/engine.js:68`）→ 纯 reducer `reduce`（`src/transport/core/poll-machine.js:181`）。有积压立即 `respond.settled(batch)`，否则等 publish 唤醒；多结局用 `classify` + `respond[outcome]`（HTTP 404/423/410/204 表可一一映射，见 copycat 设计 §A.2）。**已知微任务窗口**（延迟≤`timeoutMs`、不丢失）已入契 |
| A3 | **在线检测推送** | ◐ 半覆盖 | 「把在线状态**推**出去」有：`createChannels()` 的 `join/leave/broadcast/count`（`src/transport/channels.js:27`、`:30/:35/:39/:53`），坏连接吞错继续发；或走事件流 publish。「**判定**谁在线」没有——见 B2 |
| A4 | **多老师 / 多学生 / 多标签页** | ◐ 2.5/3 | 多老师：每老师一个 conn `{send,isOpen}`（端口⑤）`join(scopeKey)` + `broadcast`（`channels.js:39`）。多学生：每学生一条 stream（`streamId` 库不解释）或同一课堂 stream 上每学生一个 consumer group，游标彼此独立——`reference/classroom-feed.ref.test.mjs:60` 三组独立进度即此形状。**多标签页不是免费的**——同 group 共享一枚游标，见 B6 |
| A5 | **断线重连不丢状态** | ✅ 全覆盖 | `pull` 不动游标（at-least-once，`delivery.js:78`）、`ack` 前缀确认（`:90`）、重建后高水位归游标（`:22` 注释 + `:97` RangeError）。不变量 I6/I8/I9；特征测 `reference/classroom-feed.ref.test.mjs:83`（丢内存仅凭 logStore 重建、已确认不重放、未确认必重见） |
| A6 | **顶替** | ✅ 全覆盖 | `createPollRegistry()`（`src/transport/engine.js:40`）+ `longPoll` 的 `registry`/`key`；同 key 新实例先喂 SUPERSEDE 再登记自己，旧实例 `respond.superseded(...)`（可直接映射 409）。不变量 I4；实测参照 `reference/parent-options-waiter.ref.mjs:44` |
| A7 | **崩溃重放** | ✅ 全覆盖 | `createAggregateRuntime().load(streamId)`（`src/session/aggregate-runtime.js:89`）= 快照 + 尾部重放，逐条 `upcastEvent`（`src/session/upcaster.js:28`）→ `evolve`；`schemaVersion` 不匹配弃快照全量重建。不变量 I9/I10/I12（`src/session/aggregate.property.test.mjs` property①③） |
| A8 | **defineMachine** | ✅ 全覆盖 | `defineMachine(spec)`（`src/machine/define-machine.js:97`）平表 + 纯谓词 guard + 定义期全面校验，`MachineDefinitionError`（`:29`）/`IllegalTransitionError`（`:45`）；`transition/can/assertState/states/finalStates`。不变量 I14/I15。**加状态＝表里加一行**成立 |
| A9 | **计时器 / 服务端权威时间** | ✗ 不覆盖 | 内核零 `Date.now`，时间只从注入 `ctx.clock` 来；信封 `at` 已是服务端权威毫秒时间戳——但没有任何"计时器"概念，也没有客户端对时。见 B3 |

**勾选计数：✅ 6 · ◐ 2 · ✗ 1**（A1/A2/A5/A6/A7/A8 全覆盖；A3/A4 半覆盖；A9 不覆盖）。

补充事实：**copycat 已经是活着的第一个消费方**——`functions/copycat/code/backend/package.json:14` 用 `git+…#v1.0.1` pin，`code/backend/src/services/realtime/library.js`（22 行）纯 re-export 库符号、本地零实现。「薄层能薄到什么程度」已有实证：transport 换装的适配层 = 22 行。

---

## B. 缺口清单（消费方无法只靠薄层完成的点）

判定口径：**内核该加** = 十几门课会重复写同一段、且领域无关、且零依赖能写；**薄层自己做** = 领域相关或一次性；**契约/文档级** = 代码没缺口、话没说清（contract 归 arbiter 执笔，我只读 → 进 escalation）。

### B1 · logStore 端口**一致性套件不可复用** —— 【内核该加，v1.1，最高优先级】
CFO 给消费方的交接纸条写着「端口义务有可执行 property 套件，照它跑自己的实现即算达标」。**当前不成立**：`src/session/log-cursors.property.test.mjs:22` 直接 `import { createMemoryLogStore }` 并在 `newStore()`（`:34`）里硬编码，244 行 harness 没有 store 工厂参数、没有导出，消费方拿不到。
后果按消费方数量放大：copycat（R3 波次要写 SQLite 适配器）+ 上课服务 + 后续每个自带持久化的产品，各自手搓"CAS 整批原子 / seq 连续从 1 / 游标只进 / ack 不越高水位"的验证——而这四条正是**最容易写对表面、写错边界**的地方（错了的表现是静默丢事件，不是报错）。
拟做（零新逻辑、纯参数化）：把 harness 抽成导出函数 `runLogStoreConformance({ createStore, seeds? })`，内存实现作为第一个调用方，既有 property 测试改为一行调用。**既有断言一字不改** ⇒ 兼容门天然通过。估 +1 文件 ~260 行（搬运）/ 净新增逻辑 ≈ 0。

### B2 · 在线检测 = presence + 心跳 TTL 判定 —— 【内核该加，v1.1，但可延后】
`channels.count(scopeKey)`（`src/transport/channels.js:53`）只数**已 join 的 conn 对象**，且长轮询学生根本没有常驻 conn；内核没有 `lastSeen`、没有 TTL、没有过期清扫，也没有"谁在线"的身份集合。十几门课的固定区都要这一格 ⇒ 不加就是抄十几遍。
拟做：`createPresence({clock, ttlMs})` → `touch(scopeKey, memberId, meta?)` / `list(scopeKey)`（自动滤掉过期）/ `drop(scopeKey, memberId)` / `sweep()`。纯逻辑、零依赖、时间走注入 clock（过纯度门）。估 ~60 行 + ~40 行测试。
**诚实限制**：它会和 `locks`/`channels`/`createPollRegistry` 一样是**进程内**原语（contract 已把"跨进程/分布式分片"列为明确非目标）。多实例部署时在线判定需要消费方落 DB——这条必须写进契约，不能让消费方以为拿到了集群级 presence。**如果 CFO 只批一项，批 B1 不批 B2**：B2 可以在第二个当堂课页出现时再做，B1 每多一个消费方就多一份错的适配器。

### B3 · 计时器 / 时钟同步与服务端权威时间 —— 【薄层自己做】
计时器是**领域状态**，不是传输能力：`timer-started{mode:'up'|'down', durationMs}` / `timer-paused` / `timer-resumed` / `timer-reset` 四个事件 + `evolve` 折叠成 `{startedAt, elapsedMs, running}`，信封 `at` 已是服务端权威时间（注入 clock），重连/崩溃后 `load` 重放即得正确剩余时间——**A5/A7 已经把难的部分做完了**。客户端漂移校正只需消费方在自家 HTTP 响应里带一个 `serverNow`，前端一次 RTT 估 offset（~20 行）。
内核加"时钟同步协议"= 越领域无关红线（内核不起进程、无 HTTP 表面）且复用增量为零。**不加**。

### B4 · 按机构/班级/课的 channel & stream 命名规范 —— 【薄层自己做（进共享壳的 `keys.js`）】
内核的 `scopeKey`/`streamId`/`group` 全是**不透明字符串**（库不解释、不校验）——这是对的，给它们加 `makeStreamKey()` 工厂就是给模板字符串盖工厂，YAGNI。
但规范必须**唯一**（十几门课不能各拼各的），所以它属于上课服务共享壳里的一个 40 行常量模块。建议形状：`streamId = org:<orgId>/class:<classId>/lesson:<lessonId>`、`group = role:<role>` 或 `student:<userId>`、`scopeKey(channels) = org:<orgId>/class:<classId>`。**契约里应补一句"命名归消费方、内核不解释"**——文档级，见 B5 的处置。

### B5 · guards 接 auth_services 的样例 —— 【契约/文档级缺口 + 薄层实现】
**真陷阱**：`defineMachine` 的 guard 契约是 `(ctx, event) => boolean` **纯同步谓词**（`src/machine/define-machine.js:97` + contract machine 节），guard 抛异常 = 编程错误原样上抛。消费方若按字面理解"guards 接 auth_services"，会在 guard 里塞一次异步 `/api/auth/me` 校验——返回 Promise 恒真、鉴权形同虚设，且破坏 `can===true ⟺ transition 成功`（I14）。
正确形状（copycat 设计稿 §A.2 已有，但 realtime_core 自己的契约没写）：**鉴权在进入 `longPoll`/`subscribe` 之前一次性完成**（authorizeOnce），身份经 `ctx.actor` 透传给 `decide`（库不解释）；guard 只读**已在 ctx 里的**同步事实（如 `ctx.actor.role === 'teacher'`）。
处置：契约由 arbiter 执笔 → **写进 escalation**；代码无缺口，不动。顺带提醒消费方：长轮询端点经 nginx 公网暴露且触达平台内网服务 ⇒ **铁律 18 强制鉴权 + 限流**，这在库外。

### B6 · 同一学生/老师**多标签页**语义 —— 【薄层自己做，但需要先决策】
同 group 共享一枚游标（`delivery.js:7` 注释、contract subscribe 条目）⇒ 两个标签页属于同一 group 时，**谁先 pull 谁拿走**，另一个标签页永远见不到那批事件。CFO 纸条里"同一人多标签页——免费拿到"这句**过于乐观**，会直接坑到消费方。两条可选路，消费方按页面性质挑：
- **每标签页一个 ephemeral group**（`student:<uid>:tab:<uuid>`）：两个标签页各自看全量，代价是游标行随标签页增长——端口没有 `dropCursor`，但游标表在消费方自己的 DB 里，自己按 TTL 删即可（不构成内核缺口）。适合**只读看板**（学生游戏页镜像、家长旁观）。
- **`registry` + `key` 顶替**（`engine.js:40`）：后开的标签页顶掉先开的，旧连接收 `superseded`（→ 409 + 前端提示"已在别处打开"）。适合**老师控台**（避免双控台并发下指令）。

### B7 · 真实持久化 logStore 适配器 —— 【薄层自己做】
契约已把它列为明确非目标（"随首个消费方落地"），我**维持该决策**：内核带 better-sqlite3 = 原生依赖，直接毁掉"零 runtime 依赖"这个卖点（rules.md §技术与目录 1）。消费方各写一份（~150 行），**靠 B1 的一致性套件保证不写错**。这正是 B1 优先级最高的原因——B7 不动的前提是 B1 动。

### B8 · 前端浏览器侧投递循环 —— 【薄层自己做】
内核纯 ESM、零依赖、浏览器可直接跑；`longPoll({attempt: () => fetch(...), timers: {set:setTimeout, clear:clearTimeout}, ...})` ≈ 30 行接线。`reference/sse-adapter.ref.mjs:55` 已实测同一内核能承载"连接活着持续推"的形态（WS / long-poll / SSE 三形态共用内核零改动）。不需要内核加东西。

**缺口小计：8 条 —— 内核该加 2（B1、B2）· 薄层自己做 5（B3、B4、B6、B7、B8）· 契约文档级 1（B5，另 B4 附带一句）。**

---

## C. 复用架构建议（重点）：一个通用课堂壳 + 每课一份声明式配置

### C.1 我认为对的分层（四层，层间只准向下依赖）

```
L0  realtime_core（平台层 · 领域无关 · pin git tag）
      transport(longPoll/channels/dispatch) · session(日志+游标+聚合+版本化+重放)
      · concurrency(keyed 锁) · machine(defineMachine) · 〔v1.1〕presence + logStore 一致性套件
      ── 红线：契约里永远不出现「课/学生/老师/计时器」。纯度门就是这条红线的机械执行。
L1  上课服务 · 后端课堂壳（一次性写，全课共用）
      logStore 适配器(→SQLite) · 通用 lesson 聚合(decide/evolve 基集) · 通用命令/事件基集
      · 长轮询/广播路由 + authorizeOnce 鉴权前置 + 限流（铁律18） · presence 接线
L2  上课服务 · 前端课堂壳（一次性写，全课共用）
      固定区(在线检测板 / 备课资料 / 右上角计时器) · 浏览器 longPoll 接线
      · 通用部件库(推任务 / 进度板 / 结果列表 / 控制按钮 / 分组) · 声明式部件渲染器
L3  每课一份声明式配置（新增一门课＝只写这一层）
      lessons/<课名>/lesson.config.js：defineMachine 状态表 + 命令/事件清单
      + 部件清单(JSON/JS) + payload DTO；重交互课(学人精档)另加一个专属面板组件
```

**为什么固定区（在线检测/备课资料/计时器）在 L1/L2 而不在 L0**：它们对十几门课是共用的，但对 realtime_core 是**领域词**——一进内核，纯度门立刻红，而那道门正是这个库能被十几门课复用的原因。把"课堂共用"和"领域无关"两件事混为一谈，是这类库退化成框架的标准死法。**唯一例外是 presence（B2）**：它能被写成完全没有课堂味的 `touch/list/sweep`，所以可以进 L0；"在线检测板"的 UI 和"多久算掉线"的策略留在 L1/L2。

### C.2 每门课要写什么（L3 的形状）

```js
// lessons/spy_decrypt/lesson.config.js —— 新增一门课的全部产出
export default {
  id: 'spy_decrypt',
  machine: defineMachine({ id:'spy', initial:'idle',
    states:{ idle:{on:{START:{target:'briefing'}}},
             briefing:{on:{PUSH:{target:'solving', guard:'isTeacher'}}},
             solving:{on:{SUBMIT:{target:'review'}, CLEAR:{target:'briefing'}}},
             review:{on:{NEXT:{target:'briefing'}, END:{target:'done'}}},
             done:{type:'final'} } }),           //  20–40 行
  commands: { PUSH:…, SUBMIT:…, CLEAR:… },       //  decide 增量 40–80 行
  events:   { 'task-pushed':…, 'answer-submitted':… }, // evolve 增量 20–40 行
  widgets: [                                      //  部件清单 30–80 行（纯声明）
    { kind:'pushTask',    slot:'main',  payloadSchema:'cipherTask' },
    { kind:'progressBoard',slot:'side', groupBy:'student' },
    { kind:'resultList',  slot:'side',  columns:['student','answer','correct'] },
    { kind:'controls',    slot:'top',   actions:['CLEAR','NEXT','END'] },
  ],
};
```
后端管道新增 **0 行**（壳按 config 装配）；前端新增 **0 个页面文件**（壳按 widgets 渲染，路由 `/lesson/:lessonId` 一条）。

### C.3 估算（锚点 = copycat 现有真实同型页面）

测得锚点：`functions/copycat/code/frontend/teacher/index.html` **5466 行**、`student-window/index.html` **3477 行** —— 这是"每课各写一页"的现实单价。

| 项 | 一次性（壳） | 每新增一门标准课 | 每新增一门重交互课 |
|---|---|---|---|
| 前端 L2/L3 | 2500–3500 行（固定区 ~600 / 部件库 ~1200 / 引擎接线+声明渲染 ~700–1700） | 0 页面文件；config 中 widgets+DTO ~60–110 行 | +专属面板 500–900 行 |
| 后端 L1/L3 | 600–900 行（logStore 适配器 ~150 / 通用聚合 ~250 / 路由+鉴权+限流 ~300） | machine 表 + decide/evolve ~80–160 行 | 同左（重的是 UI，不是聚合） |
| **每课合计** | — | **≈150–250 行** | **≈700–1100 行** |
| **通用壳承担比例** | — | **≈85%** | **≈55–65%** |

十二门课总量对照：壳 ~4000 + 10 标准×200 + 2 重交互×800 = **≈7600 行**；对照"每课各写一个 teacher 页" ≈ 12×5466 = **≈65000 行**。**约 8.5 倍差**——这就是这个分层的全部理由，也是仓主"一个个开发压力太大"的直接答案。

### C.4 哪些进 realtime_core / 哪些进新前端共享包（归属建议）

- **进 realtime_core（L0）**：只有 B1、B2 两项。别的一律不进——尤其别把"通用课堂聚合""计时器事件""在线检测板"塞进来，那会把一个 35 符号的冻结内核变成上课服务的专属框架，其它产品线（stock_tycoon、ai_cad…）再也用不了。
- **新前端共享包：现在不要建。** 壳先住在上课服务模块自己的 `code/frontend/shell/` 与 `code/backend/shell/`。理由不是省事，是治理成本：新仓 = 新 AGENTS.md + arbiter + reviewagent + 跨仓 tag pin，**每改一个按钮都要走一次发版**。一个消费方付不起这笔税。
- **晋级触发条件（写死，可核验）**：当**第二个模块**（上课服务之外）要 import 这个壳时，才提 CR 抽成独立仓。**建议名 `lesson_shell`，归属 `0/web_modules/lesson_shell/`**（不用 `classroom_*`，避免与 realtime_core 的 `reference/classroom-*.ref.mjs` 混淆）。
- **不要 vendor 复制 realtime_core**（铁律 8 + 契约跨仓依赖机制）：pin git tag，copycat 的 `package.json:14` 是可照抄的样板。

---

## D. 拟议 v1.1 范围（最小）

| 项 | 内容 | 破坏性 | 估量 |
|---|---|---|---|
| D1 | 导出 `runLogStoreConformance({createStore, seeds?})`——把 `log-cursors.property.test.mjs` 的 harness 参数化抽出并导出，内存实现改为它的第一个调用方 | **minor**（纯新增导出符号；既有断言一字不改） | 搬运 ~260 行，净新增逻辑 ≈0 |
| D2 | 新增 `createPresence({clock, ttlMs})`：`touch/list/drop/sweep`，进程内、纯注入 clock | **minor**（新增导出符号） | ~60 行 + ~40 行测试 |

**整体判定：minor（v1.1.0）**。理由：既有 35 导出符号的签名与语义、5 个端口形状与义务、15 条不变量承诺**全部零改动**；既有 201 测试零修改必须保持全绿（兼容门）。**不是 major**——没有收窄端口义务、没有削弱不变量、没有改信封字段。

### 需要 CFO 签字的点
1. **v1.1 是否现在做、做几项**。我的建议：**只批 D1**。D2 等第二个当堂课页真的落地再说（YAGNI）；而 D1 每多一个自带持久化的消费方，就多一份没被验证过的 CAS 适配器，止血越早越便宜。
2. **若批 D2**：是否接受把"presence 是进程内单机原语（与 locks/channels/registry 同级，多实例部署需消费方落 DB）"**如实写进契约**。不接受这条限制就别批 D2——我不会做一个假装是集群 presence 的东西。
3. **契约补文由谁执笔**（我只读 contract.md）：B5 的"鉴权在 longPoll 之前、guard 是纯同步谓词、身份走 `ctx.actor`"、B4 的"streamId/scopeKey/group 命名归消费方、内核不解释"、B6 的"同 group 共享游标 ⇒ 多标签页需选型"——建议全部由 realtime_core arbiter 落到 contract.md 的消费方义务节。
4. **CFO 交接纸条两处需更正**（`deploy/coordination/handoff-realtime_core-for-lesson-sync.md`）：①"端口义务有可执行 property 套件，照它跑自己的实现即算达标"——**当前不成立**（B1），修好 D1 之前该句应改为"参照 `log-cursors.property.test.mjs` 自行照抄 harness"；②"同一人多标签页"被列在"免费拿到"里——需按 B6 补语义与选型。
5. **两处版本/路径文档漂移**（低危，但铁律 11）：①契约标题仍写 `v1.0.0`、`code/backend/package.json` 仍 `1.0.0`，而对外 tag 与仓根 `package.json` 已是 `1.0.1`（packaging-only）——建议 contract 变更记录补一行 "v1.0.1 · 仅打包垫片、零 API 变化"；②纸条引用的设计稿路径写作 `…-step5-rewrite-design-DRAFT.md`，实际文件名无 `-DRAFT`（`CFO_agent/arbiter/docs/decisions/2026-07-20-copycat-step5-rewrite-design.md`）。

---

## E. 消费方起步最小示例：**指向仓内已有的，不重写**

要的三件事（老师推一条 → 两个消费者各自收到 → 一个断线重连补投）**已经被现成参考实现 + 特征测试覆盖**：

- 文件：`code/backend/reference/classroom-feed.ref.mjs`（54 行薄壳，是消费方接线的最小样板：`post/fetchFor/confirmFor/waitFor/progressOf`）
- 测试：`code/backend/reference/classroom-feed.ref.test.mjs`
  - `:60` —— 老师 post 三条事件，**两个以上消费者（teacher/student/parent）各自独立进度互不干扰**（把 `student`/`parent` 读成"学生甲/学生乙"即是本需求）
  - `:83` —— **断线重连**：丢掉全部内存、只剩 logStore 重建 ⇒ 已确认的不重放、未确认的必重见、重建后继续发布无缝衔接
  - `:98` —— **真实 `longPoll` 等待 + publish 即唤醒**收到自己游标之后的批次
- 跑法：`cd code/backend && node --test reference/classroom-feed.ref.test.mjs` → 本次实跑 **3/3 pass（86ms）**

要带业务规则 / 锁 / 崩溃重放的完整版，看 `reference/classroom-aggregate.ref.mjs:133`（`createClassroom`：聚合 + 投递 + 传输三层串跑，含 v1→v2 事件演进、`CLASSROOM_MACHINE.can()` 表驱动守卫），测试同目录 `classroom-aggregate.ref.test.mjs`。
顶替形态看 `reference/parent-options-waiter.ref.mjs:44`；SSE/持续推流形态看 `reference/sse-adapter.ref.mjs:55`。
**结论：不新增示例代码**——再写一个"老师推两学生收"的脚本就是 `classroom-feed.ref.test.mjs:60/:83` 的复制品，属于纯增量维护负担。

---

## 决策与取舍记录（为什么这么判）

1. **只批一项就批 B1**：缺口的成本随消费方数量线性放大，而 B1 的修法是纯搬运（零新逻辑、零新风险）。B2 虽然也真实，但第一个当堂课页还没落地，先做就是猜。
2. **拒绝把课堂壳放进 realtime_core**：纯度门（66 项）不是形式主义，它是这个库能同时服务学人精 / 上课服务 / 未来产品线的**唯一机械保证**。一旦"课堂"进内核，下一个进来的就是"股票行情"和"CAD"。
3. **拒绝现在新建前端共享包**：一个消费方 + 一个新仓的治理开销 = 每次改按钮走一遍跨仓发版。给了可核验的晋级触发条件（第二个模块 import 时），不是"以后再说"。
4. **不写新的 E 示例**：仓内已有的三条测试逐条对上需求，重写只增加两份必须同步维护的等价代码。
5. **对 CFO 纸条提出两处更正**：纸条对消费方承诺了当前不存在的能力（可复用一致性套件）和一个会坑人的乐观说法（多标签页免费）。早说比消费方踩坑后再说便宜。

## 自检

- `node review/reviewcode/check-kernel-purity.mjs` → **66 PASS / 0 FAIL**
- `cd code/backend && node --test --test-concurrency=1` → **201 pass / 0 fail**
- `bash ci/gates/run-gates.sh` → **🟢 全部门禁通过**（仓内无 `review/reviewcode/run_all.sh`，gate 自报跳过）
- 本任务**零 `code/` 改动、零 `contract.md` 改动**（只读评估）；分支 `feat/lesson-sync-readiness` 自 `origin/main` 076d5e1 建立；按任务单**不 push**。
