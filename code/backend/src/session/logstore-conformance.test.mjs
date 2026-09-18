// realtime_core · session/logstore-conformance.test.mjs（v1.1.0）
//
// 套件本身的双向验收：①内存参考实现（同步与异步包装两种形态）必须整套通过；
// ②每种"看起来能跑、实则违约"的坏适配器必须被**指名**抓住——一个只会说 PASS
// 的一致性套件比没有套件更危险，所以每条端口义务都配一个反证。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryLogStore } from './memory-log-store.js';
import { sealEnvelopes } from './envelope.js';
import { ConflictError } from './errors.js';
import { runLogStoreConformance, LOG_STORE_CONFORMANCE_CHECKS } from './logstore-conformance.js';

function fixedCtx () {
  let now = 1000; let n = 0;
  return { clock: () => { now += 1; return now; }, rng: () => { n += 1; return (n % 97) / 97; } };
}

const mem = () => createMemoryLogStore(fixedCtx());

/** 把同步内存实现包成全异步适配器（契约："异步实现合法"）。 */
function asyncStore () {
  const inner = mem();
  const wrap = (fn) => async (...args) => fn(...args);
  return {
    append: wrap(inner.append), read: wrap(inner.read),
    getCursor: wrap(inner.getCursor), advanceCursor: wrap(inner.advanceCursor),
  };
}

/** 跑套件并断言它以指定检查名失败。 */
async function expectCaught (createStore, checkName) {
  const err = await runLogStoreConformance({ createStore, seeds: [1], steps: 20 })
    .then(() => null, (e) => e);
  assert.ok(err, `坏适配器必须被抓住（期望 [${checkName}] 违约）`);
  assert.equal(err.name, 'LogStoreConformanceError', `实际错误：${err && err.message}`);
  assert.equal(err.check, checkName, `实际违约项：[${err.check}] ${err.message}`);
  return err;
}

// ── 正向：参考实现必须整套通过 ─────────────────────────────────────────

test('logstore-conformance · 内存参考实现整套通过（默认 3 种子 × 60 步）', async () => {
  const result = await runLogStoreConformance({ createStore: mem });
  assert.equal(result.passed, LOG_STORE_CONFORMANCE_CHECKS.length);
  assert.deepEqual(result.checks, [...LOG_STORE_CONFORMANCE_CHECKS]);
});

test('logstore-conformance · 全异步包装的适配器同样整套通过（异步实现合法）', async () => {
  const result = await runLogStoreConformance({ createStore: asyncStore, seeds: [7], steps: 30 });
  assert.equal(result.passed, LOG_STORE_CONFORMANCE_CHECKS.length);
});

// ── 反向：每条端口义务各配一个坏适配器，必须被指名抓住 ──────────────────

test('logstore-conformance · 抓住"append 不做 CAS"（照单全收陈旧 expectedLastSeq）', async () => {
  const err = await expectCaught(() => {
    const inner = mem();
    return {
      ...inner,
      append (streamId, _expectedLastSeq, events) {
        return inner.append(streamId, inner.read(streamId, 0).length, events); // 忽略 CAS
      },
    };
  }, 'append/cas-conflict');
  assert.match(err.message, /冲突/);
});

test('logstore-conformance · 抓住"整批不原子"（逐条写入，校验失败留下半批）', async () => {
  await expectCaught(() => {
    const inner = mem();
    return {
      ...inner,
      append (streamId, expectedLastSeq, events) {
        let last = expectedLastSeq;
        for (const event of events) last = inner.append(streamId, last, [event]).lastSeq; // 半批可见
        return { lastSeq: last };
      },
    };
  }, 'append/batch-atomic');
});

test('logstore-conformance · 抓住"游标可回退"', async () => {
  await expectCaught(() => {
    const inner = mem();
    const cursors = new Map();
    return {
      ...inner,
      getCursor: (streamId, group) => cursors.get(`${streamId}|${group}`) ?? 0,
      advanceCursor (streamId, group, seq) { cursors.set(`${streamId}|${group}`, seq); }, // 想设哪就设哪
    };
  }, 'cursor/no-rollback');
});

test('logstore-conformance · 抓住"游标可越过日志末尾"（给不存在的事件立书签）', async () => {
  await expectCaught(() => {
    const inner = mem();
    const cursors = new Map();
    return {
      ...inner,
      getCursor: (streamId, group) => cursors.get(`${streamId}|${group}`) ?? 0,
      advanceCursor (streamId, group, seq) {
        const key = `${streamId}|${group}`;
        const current = cursors.get(key) ?? 0;
        if (seq < current) throw new RangeError('rollback');  // 只守住回退
        cursors.set(key, seq);                                 // 越界照收
      },
    };
  }, 'cursor/not-past-log-end');
});

test('logstore-conformance · 抓住"read 忽略 limit"', async () => {
  await expectCaught(() => {
    const inner = mem();
    return { ...inner, read: (streamId, fromSeqExclusive) => inner.read(streamId, fromSeqExclusive) };
  }, 'read/window');
});

test('logstore-conformance · 抓住"read 返回未冻结信封"（调用方可改历史）', async () => {
  await expectCaught(() => {
    const inner = mem();
    return { ...inner, read: (...args) => inner.read(...args).map((e) => ({ ...e })) };
  }, 'append/envelope-and-seq-from-one');
});

// ── 并发 CAS（返修新增：串行全对、并发丢写的适配器必须被抓住）──────────
//
// 两个坏适配器的共同点：**先读快照 → 让出（await）→ 按陈旧快照提交**。串行调用
// 时语义完全正确（前 9 项全过），并发同 expectedLastSeq 时多路同时"成功"，已确认
// 的写入被静默覆盖——正是 contract I7「同一快照 K 路并发恰好一个胜者」要挡的。

/** 变体一：CAS 判定读的是 await 之前的快照，提交时 push 进自己那份陈旧数组。 */
function toctouCommitStore () {
  let clock = 0; let n = 0;
  const rng = () => { n += 1; return (n % 97) / 97; };
  const logs = new Map(); const cursors = new Map();
  const logOf = (s) => logs.get(s) ?? [];
  return {
    async append (streamId, expectedLastSeq, events) {
      const log = logOf(streamId);
      const actual = log.length;                       // 快照
      if (expectedLastSeq !== actual) throw new ConflictError({ streamId, expected: expectedLastSeq, actual });
      const sealed = sealEnvelopes({ streamId, lastSeq: actual, events, clock: () => { clock += 1; return clock; }, rng });
      await Promise.resolve();                         // ← 交错窗口
      if (!logs.has(streamId)) logs.set(streamId, log);
      log.push(...sealed);                             // 基于陈旧快照提交
      return { lastSeq: log.length };
    },
    async read (streamId, from, limit) {
      const log = logOf(streamId);
      return log.slice(from, limit === undefined ? log.length : from + limit);
    },
    async getCursor (streamId, group) { return cursors.get(streamId)?.get(group) ?? 0; },
    async advanceCursor (streamId, group, seq) {
      const cur = cursors.get(streamId)?.get(group) ?? 0;
      if (seq < cur) throw new RangeError('rollback');
      if (seq === cur) return;
      if (seq > logOf(streamId).length) throw new RangeError('past end');
      if (!cursors.has(streamId)) cursors.set(streamId, new Map());
      cursors.get(streamId).set(group, seq);
    },
  };
}

/** 变体二：await 之后才比对陈旧快照，提交用 concat 覆盖整条日志（后到者吞掉先到者）。 */
function toctouOverwriteStore () {
  const inner = toctouCommitStore();
  const logs = new Map();
  let clock = 0; let n = 0;
  const rng = () => { n += 1; return (n % 97) / 97; };
  const logOf = (s) => logs.get(s) ?? [];
  return {
    ...inner,
    async append (streamId, expectedLastSeq, events) {
      const log = logOf(streamId);
      const actual = log.length;
      const sealed = sealEnvelopes({ streamId, lastSeq: actual, events, clock: () => { clock += 1; return clock; }, rng });
      await Promise.resolve(); await Promise.resolve();   // ← 交错窗口
      if (expectedLastSeq !== actual) throw new ConflictError({ streamId, expected: expectedLastSeq, actual });
      logs.set(streamId, log.concat(sealed));             // 覆盖式提交
      return { lastSeq: actual + sealed.length };
    },
    async read (streamId, from, limit) {
      const log = logOf(streamId);
      return log.slice(from, limit === undefined ? log.length : from + limit);
    },
    async advanceCursor (streamId, group, seq) {
      const cur = await inner.getCursor(streamId, group);
      if (seq < cur) throw new RangeError('rollback');
      if (seq === cur) return;
      if (seq > logOf(streamId).length) throw new RangeError('past end');
      return inner.advanceCursor(streamId, group, seq);
    },
  };
}

test('logstore-conformance · 抓住"CAS 非原子"（串行全对，并发同快照多路都成功 → 丢写）', async () => {
  const err = await expectCaught(toctouCommitStore, 'append/cas-concurrent');
  assert.match(err.message, /恰好一个胜者/);
});

test('logstore-conformance · 抓住"CAS 非原子·覆盖式提交"（后到者吞掉先到者的已确认写入）', async () => {
  await expectCaught(toctouOverwriteStore, 'append/cas-concurrent');
});

test('logstore-conformance · 并发检查是确定性的：同一坏适配器连跑两次违约项相同', async () => {
  const a = await expectCaught(toctouCommitStore, 'append/cas-concurrent');
  const b = await expectCaught(toctouCommitStore, 'append/cas-concurrent');
  assert.equal(a.check, b.check);
  assert.equal(a.message, b.message, '不依赖时序：两次跑出的违约信息必须逐字相同');
});

// ── 错误归属：适配器泄漏的原始异常必须被重包成可归因的违约 ────────────────

test('logstore-conformance · 适配器在预期成功的调用中抛错 → 重包为 LogStoreConformanceError 并保留 cause', async () => {
  const err = await runLogStoreConformance({
    createStore: () => {
      const inner = mem();
      return {
        ...inner,
        advanceCursor (streamId, group, seq) {
          if (seq === inner.getCursor(streamId, group)) throw new RangeError('not idempotent'); // 重确认不幂等
          return inner.advanceCursor(streamId, group, seq);
        },
      };
    },
    seeds: [1],
    steps: 20,
  }).then(() => null, (e) => e);

  assert.ok(err, '不幂等的 advanceCursor 必须被抓住');
  assert.equal(err.name, 'LogStoreConformanceError', '原始 RangeError 不得逃逸');
  assert.equal(err.check, 'cursor/advance-and-idempotent', '必须指名违约检查项');
  assert.match(err.message, /^\[cursor\/advance-and-idempotent\]/);
  assert.equal(err.cause && err.cause.name, 'RangeError', '原始异常必须挂在 cause 上');
});

test('logstore-conformance · createStore() 抛错也被指名（不泄漏原始异常）', async () => {
  const err = await runLogStoreConformance({ createStore: () => { throw new Error('db down'); } })
    .then(() => null, (e) => e);
  assert.equal(err.name, 'LogStoreConformanceError');
  assert.equal(err.check, LOG_STORE_CONFORMANCE_CHECKS[0]);
  assert.equal(err.cause && err.cause.message, 'db down');
});

// ── 套件自身的入参守卫 ────────────────────────────────────────────────

test('logstore-conformance · 缺端口方法的对象被指名抓住', async () => {
  const err = await runLogStoreConformance({ createStore: () => ({ append () {}, read () {} }) })
    .then(() => null, (e) => e);
  assert.equal(err.name, 'LogStoreConformanceError');
  assert.match(err.message, /getCursor/);
});

test('logstore-conformance · 非法入参响亮 TypeError（createStore / seeds / steps）', async () => {
  await assert.rejects(() => runLogStoreConformance({}), TypeError);
  await assert.rejects(() => runLogStoreConformance({ createStore: mem, seeds: [] }), TypeError);
  await assert.rejects(() => runLogStoreConformance({ createStore: mem, steps: 0 }), TypeError);
});

test('logstore-conformance · 检查名清单冻结且覆盖四个端口方法', () => {
  assert.ok(Object.isFrozen(LOG_STORE_CONFORMANCE_CHECKS));
  assert.equal(LOG_STORE_CONFORMANCE_CHECKS.length, 10);
  assert.ok(LOG_STORE_CONFORMANCE_CHECKS.includes('append/cas-concurrent'), '并发 CAS 检查必须在清单里');
  for (const prefix of ['append/', 'read/', 'cursor/', 'stream/', 'fuzz/']) {
    assert.ok(LOG_STORE_CONFORMANCE_CHECKS.some((n) => n.startsWith(prefix)), `缺少 ${prefix} 段检查`);
  }
});
