// realtime_core · session/logstore-conformance.test.mjs（v1.1.0）
//
// 套件本身的双向验收：①内存参考实现（同步与异步包装两种形态）必须整套通过；
// ②每种"看起来能跑、实则违约"的坏适配器必须被**指名**抓住——一个只会说 PASS
// 的一致性套件比没有套件更危险，所以每条端口义务都配一个反证。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryLogStore } from './memory-log-store.js';
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
  assert.equal(LOG_STORE_CONFORMANCE_CHECKS.length, 9);
  for (const prefix of ['append/', 'read/', 'cursor/', 'stream/', 'fuzz/']) {
    assert.ok(LOG_STORE_CONFORMANCE_CHECKS.some((n) => n.startsWith(prefix)), `缺少 ${prefix} 段检查`);
  }
});
