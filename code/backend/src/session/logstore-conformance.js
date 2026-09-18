// realtime_core · session/logstore-conformance.js（v1.1.0）
//
// logStore 端口（contract.md §端口契约①）的**可执行一致性套件**：消费方拿自己
// 的适配器（SQLite / Postgres / …）跑这一支函数，全过即算达标，不必自己重写
// "CAS / seq 连续 / 游标只进"那套断言——写对表面、写错边界的表现是**静默丢
// 事件**，靠肉眼审不出来，所以这套断言必须是库发出去的，不是每个消费方各写一份。
//
// 用法（消费方自己的测试里）：
//   import { runLogStoreConformance } from '@aimergent/realtime-core/session/logstore-conformance';
//   test('my sqlite adapter satisfies the logStore port', async () => {
//     await runLogStoreConformance({ createStore: () => makeSqliteStore(freshDb()) });
//   });
//
// 约定：
//   - `createStore()` 每次调用必须给一个**全新空**存储（可返回 Promise）；套件
//     每项检查各取一个，互不污染。
//   - 适配器可同步可异步：套件对每个端口调用都 `await`（契约"异步实现合法"）。
//   - 失败即 throw（`name = 'LogStoreConformanceError'`、`err.check` = 违约检查名、
//     message 前缀是检查名），成功返回 `{checks, passed}`。适配器自己泄漏的原始
//     异常也会被重包成同一形状（原错误挂在 `err.cause`），**任一违约都可归因**。
//     不依赖任何测试框架——消费方用什么 runner 都行。
//   - 零 import：不引 node:assert、不引第三方，保持全库"零依赖 + 浏览器可跑"一致。
//   - 非确定性走注入：模糊检查用固定种子 PRNG，跑几次都是同一批用例（clock/rng
//     属于 createStore 的注入职责，套件不碰全局时钟）。

/** 固定种子 PRNG（与仓内 property 测试同款 mulberry32，零全局读取）。 */
function mulberry32 (seed) {
  let a = seed >>> 0;
  return function rand () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function violation (check, message) {
  const err = new Error(`[${check}] ${message}`);
  err.name = 'LogStoreConformanceError';
  err.check = check;
  return err;
}

function must (check, condition, message) {
  if (!condition) throw violation(check, message);
}

/** 把适配器在"预期成功"的调用中泄漏的原始异常重包成可归因的违约（保留 cause）。 */
function unexpected (check, err, label) {
  const detail = err && err.name ? `${err.name}: ${err.message}` : String(err);
  const wrapped = violation(check, `${label}：适配器抛出了未预期的 ${detail}`);
  wrapped.cause = err;
  return wrapped;
}

function json (value) { return JSON.stringify(value) ?? 'undefined'; }

function mustEqual (check, actual, expected, label) {
  if (json(actual) !== json(expected)) {
    throw violation(check, `${label}: expected ${json(expected)}, got ${json(actual)}`);
  }
}

/** 断言 fn() 抛出指定 name 的错误；返回该错误供进一步检查。 */
async function mustThrow (check, fn, errName, label) {
  let caught;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  must(check, caught !== undefined, `${label}: expected ${errName}, but the call returned normally`);
  must(check, caught.name === errName, `${label}: expected error name "${errName}", got "${caught.name}" (${caught.message})`);
  return caught;
}

/** 读回整条流的 seq 序列（端口只有 read，没有 length）。 */
async function seqsOf (store, streamId) {
  const all = await store.read(streamId, 0);
  return all.map((e) => e.seq);
}

const ev = (type, payload) => ({ type, payload });

// ── 检查项：每项拿一个全新 store，逐条对应契约里的实现方义务 ──────────────

const CHECKS = [
  {
    name: 'append/envelope-and-seq-from-one',
    async run (store) {
      const check = 'append/envelope-and-seq-from-one';
      const s = 'stream-a';
      mustEqual(check, await store.read(s, 0), [], '空流 read(0) 必须是空数组');
      mustEqual(check, await store.getCursor(s, 'g1'), 0, '无记录的游标必须是 0');

      const res = await store.append(s, 0, [ev('alpha', { n: 1 }), ev('beta', { n: 2 })]);
      mustEqual(check, res && res.lastSeq, 2, 'append 必须返回 {lastSeq}');

      const got = await store.read(s, 0);
      mustEqual(check, got.map((e) => e.seq), [1, 2], 'seq 必须由日志层分配、从 1 起连续升序');
      for (const e of got) {
        must(check, e.streamId === s, `信封 streamId 必须回填为 "${s}"，got ${json(e.streamId)}`);
        must(check, typeof e.id === 'string' && e.id.length > 0, '信封 id 必须是非空字符串');
        must(check, Number.isFinite(e.at), '信封 at 必须是注入 clock 产出的毫秒数');
        must(check, e.v === 1, '未声明 v 的事件必须缺省为 1');
        must(check, Object.isFrozen(e), 'read 返回的信封必须是冻结对象');
      }
      mustEqual(check, got.map((e) => e.type), ['alpha', 'beta'], '事件 type 必须原样保存');
      mustEqual(check, got.map((e) => e.payload), [{ n: 1 }, { n: 2 }], 'payload 必须原样往返（库不解释）');

      await store.append(s, 2, [ev('gamma')]);
      mustEqual(check, await seqsOf(store, s), [1, 2, 3], '续写必须接着 lastSeq 继续连续编号');
    },
  },

  {
    name: 'append/cas-conflict',
    async run (store) {
      const check = 'append/cas-conflict';
      const s = 'stream-cas';
      await store.append(s, 0, [ev('one'), ev('two')]);

      const stale = await mustThrow(check, () => store.append(s, 1, [ev('late')]), 'ConflictError',
        'expectedLastSeq=1 而实际 lastSeq=2 时必须冲突');
      mustEqual(check, stale.streamId, s, 'ConflictError.streamId');
      mustEqual(check, stale.expected, 1, 'ConflictError.expected');
      mustEqual(check, stale.actual, 2, 'ConflictError.actual');

      await mustThrow(check, () => store.append(s, 5, [ev('ahead')]), 'ConflictError',
        'expectedLastSeq 超前于实际 lastSeq 时同样必须冲突');

      mustEqual(check, await seqsOf(store, s), [1, 2], '冲突的 append 不得写入任何事件');
    },
  },

  {
    name: 'append/cas-concurrent',
    async run (store) {
      const check = 'append/cas-concurrent';
      const s = 'stream-race';
      const batches = [[ev('r1')], [ev('r2')], [ev('r3')]];

      // 确定性交错：三路 append **全部先发出**（每路同步执行到自己的第一个
      // await 为止），再统一收割——不依赖真并发时序、不用定时器。
      //   · 同步适配器：第一路当场写完，后两路调用时已看到新 lastSeq → 立刻 CAS 冲突。
      //   · 正确的异步适配器：CAS 判定与提交原子（事务/唯一约束），提交点只有一个能赢。
      //   · TOCTOU 适配器（先读快照 → 让出 → 按陈旧快照提交）：三路都在提交前
      //     读到同一快照，于是三路全部"成功"——已确认的写入被静默覆盖，正是本项要抓的。
      const attempts = batches.map((b) => (async () => store.append(s, 0, b))());
      const settled = await Promise.allSettled(attempts);
      const winners = settled.filter((r) => r.status === 'fulfilled');
      const losers = settled.filter((r) => r.status === 'rejected');

      must(check, winners.length === 1,
        `同一 expectedLastSeq=0 的 ${batches.length} 路并发 append 必须恰好一个胜者，实得 ${winners.length} 个成功 / ${losers.length} 个被拒`
        + '——败者没被 CAS 拦下意味着已确认的写入会被静默覆盖（append 必须是原子 compare-and-swap，不是"先读后写"）');
      for (const l of losers) {
        const reason = l.reason;
        must(check, reason && reason.name === 'ConflictError',
          `落败的并发 append 必须抛 ConflictError，实得 ${reason && reason.name}: ${reason && reason.message}`);
      }

      const after = await store.read(s, 0);
      mustEqual(check, after.map((e) => e.seq), [1], '并发之后日志必须恰好多出胜者那一批（不重不丢、seq 无空洞）');
      must(check, batches.some((b) => b[0].type === after[0].type), '日志里留下的必须是某一路胜者写入的事件');
      mustEqual(check, winners[0].value && winners[0].value.lastSeq, 1, '胜者返回的 lastSeq 必须与日志实际长度一致');

      await store.append(s, 1, [ev('after-race')]);
      mustEqual(check, (await store.read(s, 0)).map((e) => e.seq), [1, 2],
        '竞争之后的续写必须接着真实 lastSeq 连续编号（并发不得弄乱 CAS 状态）');
    },
  },

  {
    name: 'append/batch-atomic',
    async run (store) {
      const check = 'append/batch-atomic';
      const s = 'stream-atomic';
      await store.append(s, 0, [ev('kept')]);

      // 第二条非法（seq 由日志层分配，调用方不得自带）→ 整批必须一个都不落。
      await mustThrow(check, () => store.append(s, 1, [ev('good'), { type: 'bad', seq: 9 }]), 'TypeError',
        '调用方自带 seq 的事件必须被拒（信封构造走 sealEnvelopes 的义务）');
      mustEqual(check, await seqsOf(store, s), [1], '校验失败时日志必须分毫未动（不存在半批可见）');

      await mustThrow(check, () => store.append(s, 1, [ev('good'), { type: '' }]), 'TypeError',
        '空 type 的事件必须被拒');
      mustEqual(check, await seqsOf(store, s), [1], '第二次校验失败同样不得留下半批');

      await store.append(s, 1, [ev('a'), ev('b'), ev('c')]);
      mustEqual(check, await seqsOf(store, s), [1, 2, 3, 4], '合法整批必须一次性全部可见');
    },
  },

  {
    name: 'read/window',
    async run (store) {
      const check = 'read/window';
      const s = 'stream-read';
      await store.append(s, 0, [ev('e1'), ev('e2'), ev('e3'), ev('e4'), ev('e5')]);

      mustEqual(check, (await store.read(s, 0, 2)).map((e) => e.seq), [1, 2], 'limit 必须截断到前 N 条');
      mustEqual(check, (await store.read(s, 2)).map((e) => e.seq), [3, 4, 5], 'read 必须只返回 seq > fromSeqExclusive');
      mustEqual(check, (await store.read(s, 2, 2)).map((e) => e.seq), [3, 4], 'fromSeqExclusive 与 limit 必须同时生效');
      mustEqual(check, await seqsOf(store, s), [1, 2, 3, 4, 5], 'read(0) 必须返回全量且升序');
      mustEqual(check, (await store.read(s, 5)).map((e) => e.seq), [], '读到末尾之后必须是空数组');
      mustEqual(check, (await store.read(s, 99)).map((e) => e.seq), [], '越过末尾的 from 必须是空数组，不得报错');
      mustEqual(check, (await store.read('stream-never-written', 0)).map((e) => e.seq), [],
        '未写过的流 read 必须是空数组，不得报错');
    },
  },

  {
    name: 'cursor/advance-and-idempotent',
    async run (store) {
      const check = 'cursor/advance-and-idempotent';
      const s = 'stream-cursor';
      await store.append(s, 0, [ev('e1'), ev('e2'), ev('e3')]);

      mustEqual(check, await store.getCursor(s, 'g1'), 0, '未确认过的组游标必须是 0');
      await store.advanceCursor(s, 'g1', 2);
      mustEqual(check, await store.getCursor(s, 'g1'), 2, 'advanceCursor 后游标必须前移');
      await store.advanceCursor(s, 'g1', 2);
      mustEqual(check, await store.getCursor(s, 'g1'), 2, '同 seq 重复确认必须幂等 no-op（不得抛）');
      await store.advanceCursor(s, 'g1', 3);
      mustEqual(check, await store.getCursor(s, 'g1'), 3, '游标必须能继续前移到 lastSeq');
      mustEqual(check, await store.getCursor(s, 'g2'), 0, '同一流的不同组游标必须互相独立');
    },
  },

  {
    name: 'cursor/no-rollback',
    async run (store) {
      const check = 'cursor/no-rollback';
      const s = 'stream-rollback';
      await store.append(s, 0, [ev('e1'), ev('e2'), ev('e3')]);
      await store.advanceCursor(s, 'g1', 3);

      await mustThrow(check, () => store.advanceCursor(s, 'g1', 1), 'RangeError', '游标回退必须抛 RangeError');
      mustEqual(check, await store.getCursor(s, 'g1'), 3, '被拒的回退不得产生任何副作用');
    },
  },

  {
    name: 'cursor/not-past-log-end',
    async run (store) {
      const check = 'cursor/not-past-log-end';
      const s = 'stream-highwater';
      await store.append(s, 0, [ev('e1'), ev('e2')]);

      await mustThrow(check, () => store.advanceCursor(s, 'g1', 3), 'RangeError',
        '游标越过日志末尾必须抛 RangeError（不给不存在的事件立书签）');
      mustEqual(check, await store.getCursor(s, 'g1'), 0, '被拒的越界不得移动游标');

      await mustThrow(check, () => store.advanceCursor('stream-empty', 'g1', 1), 'RangeError',
        '空流上的任何 advanceCursor 都必须抛 RangeError');
    },
  },

  {
    name: 'stream/isolation',
    async run (store) {
      const check = 'stream/isolation';
      await store.append('s-x', 0, [ev('x1')]);
      await store.append('s-y', 0, [ev('y1'), ev('y2')]);

      mustEqual(check, await seqsOf(store, 's-x'), [1], '每条流的 seq 必须独立从 1 起');
      mustEqual(check, await seqsOf(store, 's-y'), [1, 2], '另一条流的写入不得影响本流编号');
      mustEqual(check, (await store.read('s-x', 0)).map((e) => e.type), ['x1'], '流之间不得串读');

      await store.advanceCursor('s-x', 'g1', 1);
      mustEqual(check, await store.getCursor('s-y', 'g1'), 0, '同名组在不同流上的游标必须彼此独立');
      await mustThrow(check, () => store.append('s-x', 2, [ev('x2')]), 'ConflictError',
        '每条流各自维护 lastSeq（用别的流的 lastSeq 做 CAS 必须冲突）');
    },
  },

  {
    name: 'fuzz/model-equivalence',
    async run (store, { seed, steps }) {
      const check = 'fuzz/model-equivalence';
      const rand = mulberry32(seed);
      const pick = (n) => Math.floor(rand() * n);
      const streamIds = ['f-1', 'f-2'];
      const groups = ['ga', 'gb'];
      // 影子模型：日志长度 + 每 (stream,group) 游标；每步之后与真实存储比对。
      const model = new Map(streamIds.map((s) => [s, { len: 0, cursors: new Map(groups.map((g) => [g, 0])) }]));

      for (let step = 0; step < steps; step += 1) {
        const s = streamIds[pick(streamIds.length)];
        const m = model.get(s);
        const dice = pick(6);

        if (dice === 0 || dice === 1) {                 // 合法 append
          const n = 1 + pick(3);
          const batch = [];
          for (let i = 0; i < n; i += 1) batch.push(ev(`t${pick(4)}`, { step, i }));
          const res = await store.append(s, m.len, batch);
          m.len += n;
          mustEqual(check, res && res.lastSeq, m.len, `step ${step}: append 返回的 lastSeq`);
        } else if (dice === 2) {                        // 陈旧 CAS
          const stale = pick(m.len + 2);
          if (stale !== m.len) {
            const err = await mustThrow(check, () => store.append(s, stale, [ev('stale')]), 'ConflictError',
              `step ${step}: expectedLastSeq=${stale} vs lastSeq=${m.len}`);
            mustEqual(check, err.actual, m.len, `step ${step}: ConflictError.actual 必须报真实 lastSeq`);
          }
        } else if (dice === 3) {                        // read 窗口
          const from = pick(m.len + 2);
          const limit = 1 + pick(3);
          const got = await store.read(s, from, limit);
          const expected = [];
          for (let q = from + 1; q <= Math.min(m.len, from + limit); q += 1) expected.push(q);
          mustEqual(check, got.map((e) => e.seq), expected, `step ${step}: read(${from}, ${limit}) 窗口`);
        } else if (dice === 4) {                        // 合法游标前移
          const g = groups[pick(groups.length)];
          const cur = m.cursors.get(g);
          if (m.len > cur) {
            const target = cur + 1 + pick(m.len - cur);
            await store.advanceCursor(s, g, target);
            m.cursors.set(g, target);
          }
        } else {                                        // 非法游标（回退 / 越界）
          const g = groups[pick(groups.length)];
          const cur = m.cursors.get(g);
          // 回退目标取 [1, cur-1]（seq 必须是正整数——0 属于入参非法而非游标违规，
          // 不在本检查的语义内）；无处可退时改攻越界。
          const bad = rand() < 0.5 && cur > 1 ? 1 + pick(cur - 1) : m.len + 1 + pick(3);
          await mustThrow(check, () => store.advanceCursor(s, g, bad), 'RangeError',
            `step ${step}: advanceCursor(${bad}) 相对 cursor=${cur}/lastSeq=${m.len}`);
        }

        // 每步全量比对：seq 连续从 1 起 + 各组游标与模型一致。
        const seqs = await seqsOf(store, s);
        mustEqual(check, seqs, Array.from({ length: m.len }, (_, i) => i + 1),
          `step ${step}: ${s} 的 seq 必须连续从 1 起`);
        for (const g of groups) {
          mustEqual(check, await store.getCursor(s, g), m.cursors.get(g), `step ${step}: (${s}, ${g}) 游标`);
        }
      }
    },
  },
];

/** 本套件包含的检查项名（稳定顺序，供消费方报告用）。 */
export const LOG_STORE_CONFORMANCE_CHECKS = Object.freeze(CHECKS.map((c) => c.name));

/**
 * 对一个 logStore 适配器跑完整的端口一致性套件。
 * @param {{
 *   createStore: () => object | Promise<object>,  // 每次返回全新空存储
 *   seeds?: number[],                             // 模糊检查的固定种子（默认 [1,2,3]）
 *   steps?: number,                               // 每个种子的步数（默认 60；慢适配器可调小）
 * }} options
 * @returns {Promise<{checks: string[], passed: number}>} 全过返回；任一违约 throw LogStoreConformanceError
 */
export async function runLogStoreConformance ({ createStore, seeds = [1, 2, 3], steps = 60 } = {}) {
  if (typeof createStore !== 'function') {
    throw new TypeError('runLogStoreConformance requires createStore() returning a fresh empty store');
  }
  if (!Array.isArray(seeds) || seeds.length === 0 || !seeds.every((s) => Number.isInteger(s))) {
    throw new TypeError('seeds must be a non-empty array of integers');
  }
  if (!Number.isInteger(steps) || steps < 1) {
    throw new TypeError('steps must be a positive integer');
  }

  const ran = [];
  for (const spec of CHECKS) {
    const runsWithSeed = spec.name.startsWith('fuzz/') ? seeds : [undefined];
    for (const seed of runsWithSeed) {
      let store;
      try {
        store = await createStore();
      } catch (err) {
        throw unexpected(spec.name, err, 'createStore() 未能给出一个全新空存储');
      }
      for (const method of ['append', 'read', 'getCursor', 'advanceCursor']) {
        must(spec.name, store && typeof store[method] === 'function',
          `createStore() 返回的对象缺少端口方法 ${method}()`);
      }
      // 任一违约都必须可归因：适配器在"预期成功"的调用中泄漏的原始异常
      // （RangeError/TypeError/自定义错误…）在此重包为带 check 与 cause 的违约。
      try {
        await spec.run(store, { seed, steps });
      } catch (err) {
        if (err && err.name === 'LogStoreConformanceError') throw err;
        throw unexpected(spec.name, err, '检查执行中断');
      }
    }
    ran.push(spec.name);
  }
  return { checks: ran, passed: ran.length };
}
