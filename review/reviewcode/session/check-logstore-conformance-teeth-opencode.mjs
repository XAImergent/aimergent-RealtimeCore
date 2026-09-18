#!/usr/bin/env node
// review/reviewcode/session/check-logstore-conformance-teeth-opencode.mjs
// 独立审核探针（reviewagent@realtime_core · v1.1.0 logStore 一致性套件 · 2026-09-18）
//
// 目的：不采信 worker 的反向用例结论，独立验证：
//   A. 10 项检查各自能被一个"看起来能跑、实则违约"的坏适配器**指名**触发；
//      worker 已覆盖 6 项，本探针另补 advance 不幂等 / 跨流共享游标 /
//      append 返回值错误，与任务单点名的新形态（read 顺序错乱、
//      吞掉 Promise 拒绝的异步适配器）。
//   B. 异步适配器：全 async 包装整套通过；吞掉 Promise 拒绝被指名抓住。
//   C. 固定种子模糊检查可复现：同 seed 两次操作序列逐字节相同，异 seed 不同。
//   D. 并发 CAS 的牙齿（第二轮返修新增第 10 项 append/cas-concurrent）：
//      证明"串行全对、CAS 非原子"的 TOCTOU 适配器**被套件按名抓住**，
//      内存参考实现同并发下恰好一个 ConflictError 作反向对照，且同一坏
//      适配器连跑两次违约信息逐字相同（确定性、不依赖墙钟时序）。
//
// 红线：只读 code/；不修改任何被测文件。退出码 = 未按预期抓住/复现失败/发现缺口。

import { createMemoryLogStore } from '../../../code/backend/src/session/memory-log-store.js';
import { sealEnvelopes } from '../../../code/backend/src/session/envelope.js';
import { ConflictError } from '../../../code/backend/src/session/errors.js';
import {
  runLogStoreConformance,
  LOG_STORE_CONFORMANCE_CHECKS,
} from '../../../code/backend/src/session/logstore-conformance.js';

const SMALL = { seeds: [1], steps: 20 };
let failures = 0;
const results = [];

function say (s) { process.stdout.write(`${s}\n`); }
function fail (s) { failures += 1; say(`  FAIL ${s}`); }

function mem () {
  let now = 1000; let n = 0;
  return createMemoryLogStore({ clock: () => { now += 1; return now; }, rng: () => { n += 1; return (n % 97) / 97; } });
}

/** 跑套件，返回 {ok, check, name, message}。 */
async function catchCheck (createStore, opts = SMALL) {
  try {
    await runLogStoreConformance({ createStore, ...opts });
    return { ok: false, check: null, name: null, message: '套件未抛错（坏适配器蒙混过关）' };
  } catch (err) {
    return { ok: true, check: err.check ?? null, name: err.name, message: err.message };
  }
}

async function expectCaught (label, createStore, expectedCheck) {
  const r = await catchCheck(createStore);
  if (!r.ok) { fail(`${label}: 期望被 [${expectedCheck}] 抓住，实际套件未抛错`); results.push([label, 'MISSED', expectedCheck]); return; }
  if (r.name !== 'LogStoreConformanceError') { fail(`${label}: 抛出的不是 LogStoreConformanceError，而是 ${r.name}: ${r.message}`); results.push([label, r.check, expectedCheck]); return; }
  if (expectedCheck && r.check !== expectedCheck) {
    fail(`${label}: 期望 [${expectedCheck}]，实际 [${r.check}]（${r.message}）`);
    results.push([label, r.check, expectedCheck]); return;
  }
  say(`  PASS ${label} → 被 [${r.check}] 指名抓住`);
  results.push([label, r.check, expectedCheck]);
}

// ── A. 10 项检查的牙齿（坏适配器）────────────────────────────────────────
say('\n=== A. 10 项检查各自可被坏适配器指名触发 ===');
say(`检查清单（${LOG_STORE_CONFORMANCE_CHECKS.length} 项）：${LOG_STORE_CONFORMANCE_CHECKS.join(' | ')}`);

// A1 append/cas-conflict（worker 已有，独立复跑）
await expectCaught('A1 append 忽略 CAS', () => {
  const inner = mem();
  return {
    ...inner,
    append: (s, _e, evs) => inner.append(s, inner.read(s, 0).length, evs),
  };
}, 'append/cas-conflict');

// A2 append/batch-atomic（worker 已有）
await expectCaught('A2 整批不原子（逐条写，校验失败留半批）', () => {
  const inner = mem();
  return {
    ...inner,
    append (s, expected, evs) {
      let last = expected;
      for (const ev of evs) last = inner.append(s, last, [ev]).lastSeq;
      return { lastSeq: last };
    },
  };
}, 'append/batch-atomic');

// A3 cursor/no-rollback（worker 已有）
await expectCaught('A3 游标可回退', () => {
  const inner = mem();
  const cur = new Map();
  return {
    ...inner,
    getCursor: (s, g) => cur.get(`${s}|${g}`) ?? 0,
    advanceCursor: (s, g, seq) => { cur.set(`${s}|${g}`, seq); },
  };
}, 'cursor/no-rollback');

// A4 cursor/not-past-log-end（worker 已有）
await expectCaught('A4 游标可越过日志末尾', () => {
  const inner = mem();
  const cur = new Map();
  return {
    ...inner,
    getCursor: (s, g) => cur.get(`${s}|${g}`) ?? 0,
    advanceCursor (s, g, seq) {
      const k = `${s}|${g}`; const c = cur.get(k) ?? 0;
      if (seq < c) throw new RangeError('rollback');
      cur.set(k, seq);
    },
  };
}, 'cursor/not-past-log-end');

// A5 read/window（worker 已有）
await expectCaught('A5 read 忽略 limit', () => {
  const inner = mem();
  return { ...inner, read: (s, from) => inner.read(s, from) };
}, 'read/window');

// A6 append/envelope-and-seq-from-one（worker 已有）
await expectCaught('A6 read 返回未冻结信封', () => {
  const inner = mem();
  return { ...inner, read: (...a) => inner.read(...a).map((e) => ({ ...e })) };
}, 'append/envelope-and-seq-from-one');

// A7 cursor/advance-and-idempotent（worker 未覆盖）
await expectCaught('A7 advance 不幂等（同 seq 重确认为抛错）', () => {
  const inner = mem();
  return {
    ...inner,
    advanceCursor (s, g, seq) {
      if (seq <= inner.getCursor(s, g)) throw new RangeError('not idempotent');
      return inner.advanceCursor(s, g, seq);
    },
  };
}, 'cursor/advance-and-idempotent');

// A8 stream/isolation（worker 未覆盖）
// 注意：必须仍然守住"只进不退/不越尾"（否则更早的 cursor 检查先红），只把游标
// 按 group 全局共享——这样恰好只有 stream/isolation 能抓。
await expectCaught('A8 游标跨流共享（只按 group 建键，仍守单调/不越尾）', () => {
  const inner = mem();
  const cur = new Map();
  return {
    ...inner,
    getCursor: (_s, g) => cur.get(g) ?? 0,
    advanceCursor (s, g, seq) {
      const c = cur.get(g) ?? 0;
      if (seq < c) throw new RangeError('rollback');
      if (seq === c) return;
      if (seq > inner.read(s, 0).length) throw new RangeError('past end');
      cur.set(g, seq);
    },
  };
}, 'stream/isolation');

// A9 fuzz/model-equivalence（worker 未覆盖）
await expectCaught('A9 append 对 3 条批返回错误 lastSeq（仅模糊步可达）', () => {
  const inner = mem();
  return {
    ...inner,
    append (s, expected, evs) {
      const res = inner.append(s, expected, evs);
      return evs.length === 3 ? { lastSeq: res.lastSeq - 1 } : res;
    },
  };
}, 'fuzz/model-equivalence');

// A10 read 返回顺序错乱（任务单点名的新坏适配器）
await expectCaught('A10 read 返回倒序（顺序错乱）', () => {
  const inner = mem();
  return { ...inner, read: (...a) => inner.read(...a).slice().reverse() };
}, null); // 任意指名检查均可，探针只要求"被指名"

// ── B. 异步适配器：全 async 包装通过 + 吞掉拒绝被抓住 ───────────────────
say('\n=== B. 异步适配器 ===');
{
  const mkAsync = () => {
    const inner = mem();
    const w = (fn) => async (...a) => fn(...a);
    return { append: w(inner.append), read: w(inner.read), getCursor: w(inner.getCursor), advanceCursor: w(inner.advanceCursor) };
  };
  try {
    const r = await runLogStoreConformance({ createStore: mkAsync, seeds: [7], steps: 30 });
    if (r.passed === LOG_STORE_CONFORMANCE_CHECKS.length) say(`  PASS B1 全 async 包装适配器整套通过（${r.passed}/${LOG_STORE_CONFORMANCE_CHECKS.length}）`);
    else fail(`B1 全 async 包装 passed=${r.passed}`);
  } catch (err) { fail(`B1 全 async 包装被误杀：${err.message}`); }
}
await expectCaught('B2 异步适配器吞掉 Promise 拒绝（RangeError 被 catch 后 resolve）', () => {
  const inner = mem();
  const w = (fn) => async (...a) => fn(...a);
  return {
    ...inner,
    append: w(inner.append), read: w(inner.read), getCursor: w(inner.getCursor),
    advanceCursor: async (s, g, seq) => {
      try { return inner.advanceCursor(s, g, seq); } catch { /* 吞掉拒绝 */ }
    },
  };
}, 'cursor/no-rollback');

// ── C. 固定种子模糊检查可复现 ────────────────────────────────────────────
say('\n=== C. 固定种子模糊检查可复现 ===');
async function opLog (seed) {
  const log = [];
  const createStore = () => {
    const inner = mem();
    const tag = (name, fn) => (...a) => { log.push(`${name}:${JSON.stringify(a)}`); return fn(...a); };
    return { append: tag('append', inner.append), read: tag('read', inner.read), getCursor: tag('getCursor', inner.getCursor), advanceCursor: tag('advanceCursor', inner.advanceCursor) };
  };
  await runLogStoreConformance({ createStore, seeds: [seed], steps: 25 });
  return JSON.stringify(log);
}
const l1 = await opLog(42); const l2 = await opLog(42); const l3 = await opLog(43);
if (l1 === l2) say('  PASS C1 同 seed=42 两次运行操作序列逐字节相同（可复现）');
else fail('C1 同 seed 两次运行序列不同');
if (l1 !== l3) say('  PASS C2 异 seed=43 操作序列不同（seed 真的在驱动模糊）');
else fail('C2 异 seed 序列相同（seed 未被使用）');

// ── D. 并发 CAS 的牙齿：套件必须按名抓住非原子（TOCTOU）适配器 ────────────
// 第二轮返修新增第 10 项检查 append/cas-concurrent 后，本段由"证明套件漏检"
// 改为"证明套件按名抓住被修复的缺陷本身"：坏适配器必须仍然坏（并发下丢写），
// 而套件必须不再放行它。
say('\n=== D. 并发 CAS：套件按名抓住非原子（TOCTOU）适配器 ===');

/**
 * 串行语义**完全正确**、但 CAS 决策与提交之间存在 await 让出点的适配器。
 * 复用库的 sealEnvelopes/ConflictError + 与 memory 实现逐字相同的游标规则，
 * 唯一差别：append 先快照 actual、再 await 让出、最后按陈旧快照提交。
 */
function racyCASStore () {
  const logs = new Map(); const cursors = new Map(); let clock = 0; let n = 0;
  const rng = () => { n += 1; return (n % 97) / 97; };
  return {
    async append (s, expected, evs) {
      const log = logs.get(s) ?? [];
      const actual = log.length;                                  // 快照
      const sealed = sealEnvelopes({ streamId: s, lastSeq: actual, events: evs, clock: () => { clock += 1; return clock; }, rng }); // 先全部封好（校验失败零写入）
      await Promise.resolve(); await Promise.resolve();           // ← 并发交错窗口
      if (expected !== actual) throw new ConflictError({ streamId: s, expected, actual });
      logs.set(s, log.concat(sealed));                            // 基于陈旧快照提交
      return { lastSeq: actual + sealed.length };
    },
    async read (s, from, limit) {
      const l = logs.get(s) ?? [];
      const end = limit === undefined ? l.length : from + limit;
      return l.slice(from, end);
    },
    async getCursor (s, g) { return cursors.get(s)?.get(g) ?? 0; },
    async advanceCursor (s, g, seq) {
      const cur = await this.getCursor(s, g);
      if (seq < cur) throw new RangeError('rollback');
      if (seq === cur) return;
      const last = (logs.get(s) ?? []).length;
      if (seq > last) throw new RangeError('past end');
      if (!cursors.has(s)) cursors.set(s, new Map());
      cursors.get(s).set(g, seq);
    },
  };
}

{
  // 坏适配器自证：直接并发两路同 expectedLastSeq=0，陈旧快照覆盖 → 只剩 1 条。
  // 这一步只确认"缺陷本身仍然存在"，不再作为套件能力的判据（旧 D1 的缺口即在此）。
  const broken = racyCASStore();
  await Promise.all([
    broken.append('cc', 0, [{ type: 'a', payload: 1 }]),
    broken.append('cc', 0, [{ type: 'b', payload: 2 }]),
  ]);
  const rawRows = await broken.read('cc', 0);
  const rawSeqs = rawRows.map((e) => e.seq);
  const corrupted = rawRows.length < 2 || new Set(rawSeqs).size !== rawSeqs.length;
  if (corrupted) {
    say(`  NOTE racyCAS 确为坏适配器：并发同 expectedLastSeq=0 下日志损坏，残留 ${rawRows.length} 条 seq=${JSON.stringify(rawSeqs)}（应 2 条 [1,2]）`);
  } else {
    fail('D 段前提不成立：racyCAS 在并发下未损坏，无法验证套件是否抓住');
  }

  // 关键断言：套件必须**按名**抓住它——不得只跑串行检查就放行。
  const r1 = await catchCheck(racyCASStore);
  if (!r1.ok) {
    fail('D1 套件放行了非原子 CAS 适配器（append/cas-concurrent 未生效）');
  } else if (r1.name !== 'LogStoreConformanceError') {
    fail(`D1 套件抛出的不是 LogStoreConformanceError，而是 ${r1.name}: ${r1.message}`);
  } else if (r1.check !== 'append/cas-concurrent') {
    fail(`D1 套件未按名抓住非原子 CAS：期望 [append/cas-concurrent]，实际 [${r1.check}]（${r1.message}）`);
  } else {
    say(`  PASS D1 套件按名抓住非原子 CAS 适配器 → [${r1.check}]`);
    results.push(['D1 套件指名抓住 append/cas-concurrent', r1.check, 'append/cas-concurrent']);
  }

  // 确定性：同一坏适配器连跑两次，违约检查名与信息逐字相同（不依赖墙钟时序）。
  const r2 = await catchCheck(racyCASStore);
  if (r1.ok && r2.ok && r1.check === r2.check && r1.message === r2.message) {
    say(`  PASS D2 连跑两次违约信息逐字相同：[${r1.check}] ${r1.message}`);
  } else {
    fail(`D2 连跑两次违约信息不一致：\n      #1 [${r1.check}] ${r1.message}\n      #2 [${r2.check}] ${r2.message}`);
  }

  // 反向对照：内存参考实现并发同 expected 时，恰好一个成功、一个 ConflictError。
  const good = mem();
  const settled = await Promise.allSettled([
    Promise.resolve().then(() => good.append('cc', 0, [{ type: 'a' }])),
    Promise.resolve().then(() => good.append('cc', 0, [{ type: 'b' }])),
  ]);
  const conflicts = settled.filter((x) => x.status === 'rejected' && x.reason?.name === 'ConflictError').length;
  if (conflicts === 1) say('  PASS D3 内存参考实现同并发下恰好一个 ConflictError（对照成立）');
  else fail(`D3 内存参考实现并发对照异常：conflicts=${conflicts}`);
}

// ── 汇总 ────────────────────────────────────────────────────────────────
say('\n=== 牙齿探针汇总 ===');
for (const [label, got, want] of results) say(`  ${got === want || want === null ? 'ok  ' : 'BAD '} ${label}: got=[${got}] want=[${want ?? '任意指名'}]`);
say(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}（检查清单 ${LOG_STORE_CONFORMANCE_CHECKS.length} 项）`);
process.exit(failures === 0 ? 0 : 1);
