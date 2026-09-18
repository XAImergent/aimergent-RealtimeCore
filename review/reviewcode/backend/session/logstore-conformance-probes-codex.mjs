import assert from 'node:assert/strict';

import { ConflictError } from '../../../../code/backend/src/session/errors.js';
import { createDelivery } from '../../../../code/backend/src/session/delivery.js';
import { sealEnvelopes } from '../../../../code/backend/src/session/envelope.js';
import { createMemoryLogStore } from '../../../../code/backend/src/session/memory-log-store.js';
import {
  LOG_STORE_CONFORMANCE_CHECKS,
  runLogStoreConformance,
} from '../../../../code/backend/src/session/logstore-conformance.js';

function fixedCtx () {
  let now = 1000;
  let n = 0;
  return {
    clock: () => { now += 1; return now; },
    rng: () => { n += 1; return (n % 97) / 97; },
  };
}

const mem = () => createMemoryLogStore(fixedCtx());

async function expectNamedFailure (createStore, check) {
  const err = await runLogStoreConformance({ createStore, seeds: [11], steps: 24 })
    .then(() => null, (caught) => caught);
  assert.ok(err, `bad adapter unexpectedly passed; expected ${check}`);
  assert.equal(err.name, 'LogStoreConformanceError');
  assert.equal(err.check, check, err.message);
  process.stdout.write(`PASS named failure: ${check}\n`);
}

// New probe 1: reverse only the stream used by read/window so the suite must
// identify the read check rather than fail incidentally in an earlier check.
await expectNamedFailure(() => {
  const inner = mem();
  return {
    ...inner,
    read (streamId, ...args) {
      const rows = inner.read(streamId, ...args);
      return streamId === 'stream-read' ? [...rows].reverse() : rows;
    },
  };
}, 'read/window');

// New probe 2: a duplicate cursor acknowledgement incorrectly rejects.
await expectNamedFailure(() => {
  const inner = mem();
  const cursors = new Map();
  return {
    ...inner,
    getCursor (streamId, group) {
      return streamId === 'stream-cursor'
        ? (cursors.get(`${streamId}|${group}`) ?? 0)
        : inner.getCursor(streamId, group);
    },
    advanceCursor (streamId, group, seq) {
      if (streamId === 'stream-cursor') {
        const key = `${streamId}|${group}`;
        const current = cursors.get(key) ?? 0;
        cursors.set(key, current === seq ? Math.max(0, seq - 1) : seq);
        return;
      }
      return inner.advanceCursor(streamId, group, seq);
    },
  };
}, 'cursor/advance-and-idempotent');

// Complete the nine-check mutation matrix: stream isolation and fuzz each get
// a tailored adapter that survives all preceding checks.
await expectNamedFailure(() => {
  const inner = mem();
  return {
    ...inner,
    read: (streamId, ...args) => inner.read(streamId === 's-x' ? 's-y' : streamId, ...args),
  };
}, 'stream/isolation');

await expectNamedFailure(() => {
  const inner = mem();
  return {
    ...inner,
    append: async (streamId, ...args) => {
      const result = await inner.append(streamId, ...args);
      return streamId.startsWith('f-') ? { lastSeq: result.lastSeq + 1 } : result;
    },
  };
}, 'fuzz/model-equivalence');

// A Promise-rejection swallowing adapter must not be accepted. It swallows
// the reference store's rejected/throwing append and is caught by CAS.
await expectNamedFailure(() => {
  const inner = mem();
  return {
    ...inner,
    append: async (...args) => {
      try {
        return await Promise.resolve().then(() => inner.append(...args));
      } catch {
        return undefined;
      }
    },
  };
}, 'append/cas-conflict');

// Error normalization is part of the public promise. A violation on a call
// expected to succeed must be named while retaining the adapter's raw cause.
const rawError = await runLogStoreConformance({
  seeds: [1],
  steps: 10,
  createStore: () => {
    const inner = mem();
    return {
      ...inner,
      advanceCursor (streamId, group, seq) {
        if (streamId === 'stream-cursor' && inner.getCursor(streamId, group) === seq) {
          throw new RangeError('duplicate ack rejected');
        }
        return inner.advanceCursor(streamId, group, seq);
      },
    };
  },
}).then(() => null, (err) => err);
assert.equal(rawError?.name, 'LogStoreConformanceError');
assert.equal(rawError?.check, 'cursor/advance-and-idempotent');
assert.equal(rawError?.cause?.name, 'RangeError');
assert.equal(rawError?.cause?.message, 'duplicate ack rejected');
process.stdout.write('PASS adapter violation normalized with check and RangeError cause\n');

// Same seed and step count must drive the exact same observable port trace.
async function fuzzTrace () {
  const trace = [];
  await runLogStoreConformance({
    seeds: [20260918],
    steps: 40,
    createStore: () => {
      const inner = mem();
      const record = (name, fn) => async (...args) => {
        if (String(args[0]).startsWith('f-')) trace.push([name, args]);
        return fn(...args);
      };
      return {
        append: record('append', inner.append),
        read: record('read', inner.read),
        getCursor: record('getCursor', inner.getCursor),
        advanceCursor: record('advanceCursor', inner.advanceCursor),
      };
    },
  });
  return trace;
}

assert.deepEqual(await fuzzTrace(), await fuzzTrace());
process.stdout.write('PASS deterministic fuzz trace: seed=20260918 steps=40\n');

// Deliberately unsafe CAS adapter: sequential calls are correct, but validation
// and commit are separated by an await. Two writers can both validate the same
// expectedLastSeq and both commit. A sound conformance suite must reject it.
function createInterleavingCasStore () {
  const { clock, rng } = fixedCtx();
  const streams = new Map();
  const cursors = new Map();

  async function append (streamId, expectedLastSeq, events) {
    const log = streams.get(streamId) ?? [];
    const actual = log.length;
    if (expectedLastSeq !== actual) {
      throw new ConflictError({ streamId, expected: expectedLastSeq, actual });
    }
    const sealed = sealEnvelopes({ streamId, lastSeq: actual, events, clock, rng });
    await Promise.resolve();
    if (!streams.has(streamId)) streams.set(streamId, log);
    log.push(...sealed);
    return { lastSeq: log.length };
  }

  async function read (streamId, fromSeqExclusive, limit) {
    const log = streams.get(streamId) ?? [];
    const end = limit === undefined ? log.length : fromSeqExclusive + limit;
    return log.slice(fromSeqExclusive, end);
  }

  async function getCursor (streamId, group) {
    return cursors.get(streamId)?.get(group) ?? 0;
  }

  async function advanceCursor (streamId, group, seq) {
    const current = await getCursor(streamId, group);
    if (seq < current || seq > (streams.get(streamId) ?? []).length) throw new RangeError('cursor range');
    if (seq === current) return;
    if (!cursors.has(streamId)) cursors.set(streamId, new Map());
    cursors.get(streamId).set(group, seq);
  }

  return { append, read, getCursor, advanceCursor };
}

async function catchUnsafeCas () {
  return runLogStoreConformance({
    createStore: createInterleavingCasStore,
    seeds: [3],
    steps: 30,
  }).then(() => null, (err) => err);
}

assert.equal(LOG_STORE_CONFORMANCE_CHECKS.length, 10);
const unsafeError1 = await catchUnsafeCas();
const unsafeError2 = await catchUnsafeCas();
for (const err of [unsafeError1, unsafeError2]) {
  assert.equal(err?.name, 'LogStoreConformanceError');
  assert.equal(err?.check, 'append/cas-concurrent');
  assert.match(err?.message ?? '', /^\[append\/cas-concurrent\]/);
}
assert.equal(unsafeError1.message, unsafeError2.message,
  'concurrent CAS violation message must be byte-for-byte deterministic');
process.stdout.write('PASS unsafe concurrent CAS named append/cas-concurrent twice with identical message\n');

const unsafe = createInterleavingCasStore();
const racers = await Promise.allSettled([
  unsafe.append('race', 0, [{ type: 'left' }]),
  unsafe.append('race', 0, [{ type: 'right' }]),
]);
const raceRows = await unsafe.read('race', 0);
assert.equal(racers.filter((r) => r.status === 'fulfilled').length, 2);
assert.deepEqual(raceRows.map((row) => row.seq), [1]);
process.stdout.write('PASS control adapter demonstrably accepts two racers and loses one event\n');

// The corrected contract says same-group pulls repeat the unacked batch, while
// one subscriber's acknowledgement advances the shared cursor for the group.
const sharedGroupStore = mem();
const delivery = createDelivery({ logStore: sharedGroupStore, wakeup: { emit () {} } });
delivery.publish('shared-group', [{ type: 'event' }]);
const firstPull = delivery.pull('shared-group', 'g');
const secondPull = delivery.pull('shared-group', 'g');
assert.deepEqual(firstPull.map((row) => row.seq), [1]);
assert.deepEqual(secondPull.map((row) => row.seq), [1]);
delivery.ack('shared-group', 'g', 1);
assert.deepEqual(delivery.pull('shared-group', 'g'), []);
process.stdout.write('PASS same-group duplicate delivery before ack and shared cursor advance after ack\n');
