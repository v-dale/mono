import {httpStatusUnauthorized} from './replicache';
import {ReplicacheTest} from './test-util';
import type {MutatorDefs} from './replicache';
import type {ReplicacheOptions} from './replicache-options';
import {PatchOperation, Replicache, TransactionClosedError} from './mod';

import type {ReadTransaction, WriteTransaction} from './mod';
import type {JSONValue, ReadonlyJSONValue} from './json';

import {assert, expect} from '@esm-bundle/chai';
import * as sinon from 'sinon';

// fetch-mock has invalid d.ts file so we removed that on npm install.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
import fetchMock from 'fetch-mock/esm/client';
import type {ScanOptions} from './scan-options';

import {SinonFakeTimers, useFakeTimers} from 'sinon';
import {asyncIterableToArray} from './async-iterable-to-array';
import {closeAllReps, deletaAllDatabases, reps, dbsToDrop} from './test-util';
import {sleep} from './sleep';
import {MemStore} from './kv/mem-store';
import type * as kv from './kv/mod';
import * as db from './db/mod';
import * as dag from './dag/mod';
import {TestMemStore} from './kv/test-mem-store';
import {WriteTransactionImpl} from './transactions';
import {emptyHash, Hash} from './hash';
import {defaultPuller} from './puller';
import {defaultPusher} from './pusher';

let clock: SinonFakeTimers;
setup(() => {
  clock = useFakeTimers(0);
});

teardown(() => {
  clock.restore();
});

async function tickAFewTimes(n = 10, time = 10) {
  for (let i = 0; i < n; i++) {
    await clock.tickAsync(time);
  }
}

async function tickUntil(f: () => boolean, msPerTest = 10) {
  while (!f()) {
    await clock.tickAsync(msPerTest);
  }
}

fetchMock.config.overwriteRoutes = true;

const {fail} = assert;

let overrideUseMemstore = false;

// eslint-disable-next-line @typescript-eslint/ban-types
async function replicacheForTesting<MD extends MutatorDefs = {}>(
  name: string,
  options: ReplicacheOptions<MD> = {},
): Promise<ReplicacheTest<MD>> {
  const pullURL = 'https://pull.com/?name=' + name;
  const pushURL = 'https://push.com/?name=' + name;
  return replicacheForTestingNoDefaultURLs(name, {
    pullURL,
    pushURL,
    ...options,
  });
}

// eslint-disable-next-line @typescript-eslint/ban-types
async function replicacheForTestingNoDefaultURLs<MD extends MutatorDefs = {}>(
  name: string,
  {
    pullURL,
    pushDelay = 60_000, // Large to prevent interfering
    pushURL,
    useMemstore = overrideUseMemstore,

    ...rest
  }: ReplicacheOptions<MD> = {},
): Promise<ReplicacheTest<MD>> {
  dbsToDrop.add(name);
  const rep = new ReplicacheTest<MD>({
    pullURL,
    pushDelay,
    pushURL,
    name,
    useMemstore,
    ...rest,
  });
  reps.add(rep);
  // Wait for open to be done.
  await rep.clientID;
  fetchMock.post(pullURL, {lastMutationID: 0, patch: []});
  fetchMock.post(pushURL, 'ok');
  await tickAFewTimes();
  return rep;
}

async function addData(tx: WriteTransaction, data: {[key: string]: JSONValue}) {
  for (const [key, value] of Object.entries(data)) {
    await tx.put(key, value);
  }
}

teardown(async () => {
  fetchMock.restore();
  sinon.restore();

  await closeAllReps();
  deletaAllDatabases();
});

async function expectPromiseToReject(p: unknown): Promise<Chai.Assertion> {
  let e;
  try {
    await p;
  } catch (ex) {
    e = ex;
  }
  return expect(e);
}

async function expectAsyncFuncToThrow(f: () => unknown, c: unknown) {
  (await expectPromiseToReject(f())).to.be.instanceof(c);
}

function testWithBothStores(name: string, func: () => Promise<void>) {
  for (const useMemstore of [false, true]) {
    test(`${name} {useMemstore: ${useMemstore}}`, async () => {
      try {
        overrideUseMemstore = useMemstore;
        await func();
      } finally {
        overrideUseMemstore = false;
      }
    });
  }
}

testWithBothStores('get, has, scan on empty db', async () => {
  const rep = await replicacheForTesting('test2');
  async function t(tx: ReadTransaction) {
    expect(await tx.get('key')).to.equal(undefined);
    expect(await tx.has('key')).to.be.false;

    const scanItems = await asyncIterableToArray(tx.scan());
    expect(scanItems).to.have.length(0);
  }

  await rep.query(t);
});

testWithBothStores('put, get, has, del inside tx', async () => {
  const rep = await replicacheForTesting('test3', {
    mutators: {
      testMut: async (
        tx: WriteTransaction,
        args: {key: string; value: JSONValue},
      ) => {
        const {key, value} = args;
        await tx.put(key, value);
        expect(await tx.has(key)).to.equal(true);
        const v = await tx.get(key);
        expect(v).to.deep.equal(value);

        expect(await tx.del(key)).to.equal(true);
        expect(await tx.has(key)).to.be.false;
      },
    },
  });

  const {testMut} = rep.mutate;

  for (const [key, value] of Object.entries({
    a: true,
    b: false,
    c: null,
    d: 'string',
    e: 12,
    f: {},
    g: [],
    h: {h1: true},
    i: [0, 1],
  })) {
    await testMut({key, value: value as JSONValue});
  }
});

async function testScanResult<K, V>(
  rep: Replicache,
  options: ScanOptions | undefined,
  entries: [K, V][],
) {
  await rep.query(async tx => {
    expect(
      await asyncIterableToArray(tx.scan(options).entries()),
    ).to.deep.equal(entries);
  });
  await rep.query(async tx => {
    expect(await asyncIterableToArray(tx.scan(options))).to.deep.equal(
      entries.map(([, v]) => v),
    );
  });
  await rep.query(async tx => {
    expect(await asyncIterableToArray(tx.scan(options).values())).to.deep.equal(
      entries.map(([, v]) => v),
    );
  });
  await rep.query(async tx => {
    expect(await asyncIterableToArray(tx.scan(options).keys())).to.deep.equal(
      entries.map(([k]) => k),
    );
  });

  await rep.query(async tx => {
    expect(await tx.scan(options).toArray()).to.deep.equal(
      entries.map(([, v]) => v),
    );
  });
  // scan().xxx().toArray()
  await rep.query(async tx => {
    expect(await tx.scan(options).entries().toArray()).to.deep.equal(entries);
  });
  await rep.query(async tx => {
    expect(await tx.scan(options).values().toArray()).to.deep.equal(
      entries.map(([, v]) => v),
    );
  });
  await rep.query(async tx => {
    expect(await tx.scan(options).keys().toArray()).to.deep.equal(
      entries.map(([k]) => k),
    );
  });
}

testWithBothStores('scan', async () => {
  const rep = await replicacheForTesting('test4', {
    mutators: {
      addData,
    },
  });
  const add = rep.mutate.addData;
  await add({
    'a/0': 0,
    'a/1': 1,
    'a/2': 2,
    'a/3': 3,
    'a/4': 4,
    'b/0': 5,
    'b/1': 6,
    'b/2': 7,
    'c/0': 8,
  });

  await testScanResult(rep, undefined, [
    ['a/0', 0],
    ['a/1', 1],
    ['a/2', 2],
    ['a/3', 3],
    ['a/4', 4],
    ['b/0', 5],
    ['b/1', 6],
    ['b/2', 7],
    ['c/0', 8],
  ]);

  await testScanResult(rep, {prefix: 'a'}, [
    ['a/0', 0],
    ['a/1', 1],
    ['a/2', 2],
    ['a/3', 3],
    ['a/4', 4],
  ]);

  await testScanResult(rep, {prefix: 'b'}, [
    ['b/0', 5],
    ['b/1', 6],
    ['b/2', 7],
  ]);

  await testScanResult(rep, {prefix: 'c/'}, [['c/0', 8]]);

  await testScanResult(
    rep,
    {
      start: {key: 'b/1', exclusive: false},
    },
    [
      ['b/1', 6],
      ['b/2', 7],
      ['c/0', 8],
    ],
  );

  await testScanResult(
    rep,
    {
      start: {key: 'b/1'},
    },
    [
      ['b/1', 6],
      ['b/2', 7],
      ['c/0', 8],
    ],
  );

  await testScanResult(
    rep,
    {
      start: {key: 'b/1', exclusive: true},
    },
    [
      ['b/2', 7],
      ['c/0', 8],
    ],
  );

  await testScanResult(
    rep,
    {
      limit: 3,
    },
    [
      ['a/0', 0],
      ['a/1', 1],
      ['a/2', 2],
    ],
  );

  await testScanResult(
    rep,
    {
      limit: 10,
      prefix: 'a/',
    },
    [
      ['a/0', 0],
      ['a/1', 1],
      ['a/2', 2],
      ['a/3', 3],
      ['a/4', 4],
    ],
  );

  await testScanResult(
    rep,
    {
      limit: 1,
      prefix: 'b/',
    },
    [['b/0', 5]],
  );
});

testWithBothStores('subscribe', async () => {
  const log: [string, ReadonlyJSONValue][] = [];

  const rep = await replicacheForTesting('subscribe', {
    mutators: {
      addData,
    },
  });
  let queryCallCount = 0;
  const cancel = rep.subscribe(
    async (tx: ReadTransaction) => {
      queryCallCount++;
      return await tx.scan({prefix: 'a/'}).entries().toArray();
    },
    {
      onData: (values: Iterable<[string, ReadonlyJSONValue]>) => {
        for (const entry of values) {
          log.push(entry);
        }
      },
    },
  );

  expect(log).to.have.length(0);
  expect(queryCallCount).to.equal(0);

  const add = rep.mutate.addData;
  await add({'a/0': 0});
  expect(log).to.deep.equal([['a/0', 0]]);
  expect(queryCallCount).to.equal(2); // One for initial subscribe and one for the add.

  // Changing a entry to the same value no longer triggers the subscription to
  // fire.
  log.length = 0;
  await add({'a/0': 0});
  expect(log).to.deep.equal([]);
  expect(queryCallCount).to.equal(2);

  log.length = 0;
  await add({'a/1': 1});
  expect(log).to.deep.equal([
    ['a/0', 0],
    ['a/1', 1],
  ]);
  expect(queryCallCount).to.equal(3);

  log.length = 0;
  log.length = 0;
  await add({'a/1': 11});
  expect(log).to.deep.equal([
    ['a/0', 0],
    ['a/1', 11],
  ]);
  expect(queryCallCount).to.equal(4);

  log.length = 0;
  cancel();
  await add({'a/1': 12});
  await Promise.resolve();
  expect(log).to.have.length(0);
  expect(queryCallCount).to.equal(4);
});

// for (const 'prefix' of ['prefix', 'keyPrefix']) {
testWithBothStores(`subscribe with index`, async () => {
  const log: [[string, string], ReadonlyJSONValue][] = [];

  const rep = await replicacheForTesting('subscribe-with-index', {
    mutators: {
      addData,
    },
  });

  await rep.createIndex({
    name: 'i1',
    jsonPointer: '/id',
    prefix: 'a',
  });

  let queryCallCount = 0;
  let onDataCallCount = 0;
  const cancel = rep.subscribe(
    async (tx: ReadTransaction) => {
      queryCallCount++;
      return await tx.scan({indexName: 'i1'}).entries().toArray();
    },
    {
      onData: (values: Iterable<[[string, string], ReadonlyJSONValue]>) => {
        onDataCallCount++;
        for (const entry of values) {
          log.push(entry);
        }
      },
    },
  );

  expect(log).to.have.length(0);
  expect(queryCallCount).to.equal(0);
  expect(onDataCallCount).to.equal(0);

  await rep.mutate.addData({
    a1: {id: 'a-1', x: 1},
    a2: {id: 'a-2', x: 2},
    b: {id: 'bx'},
  });

  expect(log).to.deep.equal([
    [
      ['a-1', 'a1'],
      {
        id: 'a-1',
        x: 1,
      },
    ],
    [
      ['a-2', 'a2'],
      {
        id: 'a-2',
        x: 2,
      },
    ],
  ]);
  expect(queryCallCount).to.equal(2); // One for initial subscribe and one for the add.
  expect(onDataCallCount).to.equal(2);

  log.length = 0;
  await rep.mutate.addData({a3: {id: 'a-3', x: 3}});

  expect(queryCallCount).to.equal(3);
  expect(onDataCallCount).to.equal(3);
  expect(log).to.deep.equal([
    [
      ['a-1', 'a1'],
      {
        id: 'a-1',
        x: 1,
      },
    ],
    [
      ['a-2', 'a2'],
      {
        id: 'a-2',
        x: 2,
      },
    ],
    [
      ['a-3', 'a3'],
      {
        id: 'a-3',
        x: 3,
      },
    ],
  ]);

  await rep.dropIndex('i1');
  expect(queryCallCount).to.equal(4);
  expect(onDataCallCount).to.equal(3); // scan({indexName: 'i1'}) fails since we do not have that index any more.

  log.length = 0;
  await rep.createIndex({
    name: 'i1',
    jsonPointer: '/id',
  });

  expect(queryCallCount).to.equal(5);
  expect(onDataCallCount).to.equal(4);
  expect(log).to.deep.equal([
    [
      ['a-1', 'a1'],
      {
        id: 'a-1',
        x: 1,
      },
    ],
    [
      ['a-2', 'a2'],
      {
        id: 'a-2',
        x: 2,
      },
    ],
    [
      ['a-3', 'a3'],
      {
        id: 'a-3',
        x: 3,
      },
    ],
    [
      ['bx', 'b'],
      {
        id: 'bx',
      },
    ],
  ]);

  cancel();
});

testWithBothStores('subscribe with index and start', async () => {
  const log: [[string, string], ReadonlyJSONValue][] = [];

  const rep = await replicacheForTesting('subscribe-with-index-and-start', {
    mutators: {
      addData,
    },
  });

  await rep.createIndex({
    name: 'i1',
    jsonPointer: '/id',
  });

  let queryCallCount = 0;
  let onDataCallCount = 0;
  const cancel = rep.subscribe(
    async (tx: ReadTransaction) => {
      queryCallCount++;
      return await tx
        .scan({indexName: 'i1', start: {key: 'a-2'}})
        .entries()
        .toArray();
    },
    {
      onData: (values: Iterable<[[string, string], ReadonlyJSONValue]>) => {
        onDataCallCount++;
        for (const entry of values) {
          log.push(entry);
        }
      },
    },
  );

  expect(log).to.have.length(0);
  expect(queryCallCount).to.equal(0);
  expect(onDataCallCount).to.equal(0);

  await rep.mutate.addData({
    a1: {id: 'a-1', x: 1},
    a2: {id: 'a-2', x: 2},
    b: {id: 'bx'},
  });

  expect(log).to.deep.equal([
    [
      ['a-2', 'a2'],
      {
        id: 'a-2',
        x: 2,
      },
    ],
    [
      ['bx', 'b'],
      {
        id: 'bx',
      },
    ],
  ]);
  expect(queryCallCount).to.equal(2); // One for initial subscribe and one for the add.
  expect(onDataCallCount).to.equal(2);

  log.length = 0;
  await rep.mutate.addData({
    b: {id: 'bx2'},
  });
  expect(log).to.deep.equal([
    [
      ['a-2', 'a2'],
      {
        id: 'a-2',
        x: 2,
      },
    ],
    [
      ['bx2', 'b'],
      {
        id: 'bx2',
      },
    ],
  ]);
  expect(queryCallCount).to.equal(3); // One for initial subscribe and one for the add.
  expect(onDataCallCount).to.equal(3);

  // Adding a entry that does not match the index... no id property
  await rep.mutate.addData({
    c: {noid: 'c-3'},
  });
  expect(queryCallCount).to.equal(3); // One for initial subscribe and one for the add.
  expect(onDataCallCount).to.equal(3);

  // Changing a entry before the start key
  await rep.mutate.addData({
    a1: {id: 'a-1', x: 2},
  });
  expect(queryCallCount).to.equal(3); // One for initial subscribe and one for the add.
  expect(onDataCallCount).to.equal(3);

  // Changing a entry to the same value we do not fire the subscription any more.
  await rep.mutate.addData({
    a2: {id: 'a-2', x: 2},
  });
  expect(queryCallCount).to.equal(3); // One for initial subscribe and one for the add.
  expect(onDataCallCount).to.equal(3);

  cancel();
});

testWithBothStores('subscribe with index and prefix', async () => {
  const log: [[string, string], ReadonlyJSONValue][] = [];

  const rep = await replicacheForTesting('subscribe-with-index-and-prefix', {
    mutators: {
      addData,
    },
  });

  await rep.createIndex({
    name: 'i1',
    jsonPointer: '/id',
  });

  let queryCallCount = 0;
  let onDataCallCount = 0;
  const cancel = rep.subscribe(
    async (tx: ReadTransaction) => {
      queryCallCount++;
      return await tx.scan({indexName: 'i1', prefix: 'b'}).entries().toArray();
    },
    {
      onData: (values: Iterable<[[string, string], ReadonlyJSONValue]>) => {
        onDataCallCount++;
        for (const entry of values) {
          log.push(entry);
        }
      },
    },
  );

  expect(log).to.have.length(0);
  expect(queryCallCount).to.equal(0);
  expect(onDataCallCount).to.equal(0);

  await rep.mutate.addData({
    a1: {id: 'a-1', x: 1},
    a2: {id: 'a-2', x: 2},
    b: {id: 'bx'},
  });

  expect(log).to.deep.equal([
    [
      ['bx', 'b'],
      {
        id: 'bx',
      },
    ],
  ]);
  expect(queryCallCount).to.equal(2); // One for initial subscribe and one for the add.
  expect(onDataCallCount).to.equal(2);

  log.length = 0;
  await rep.mutate.addData({
    b: {id: 'bx2'},
  });
  expect(log).to.deep.equal([
    [
      ['bx2', 'b'],
      {
        id: 'bx2',
      },
    ],
  ]);
  expect(queryCallCount).to.equal(3); // One for initial subscribe and one for the add.
  expect(onDataCallCount).to.equal(3);

  // Adding a entry that does not match the index... no id property
  await rep.mutate.addData({
    c: {noid: 'c-3'},
  });
  expect(queryCallCount).to.equal(3); // One for initial subscribe and one for the add.
  expect(onDataCallCount).to.equal(3);

  // Changing a entry but still matching prefix
  await rep.mutate.addData({
    b: {id: 'bx3', x: 3},
  });
  expect(queryCallCount).to.equal(4);
  expect(onDataCallCount).to.equal(4);

  // Changing a entry to the same value will not trigger the subscription.
  await rep.mutate.addData({
    b: {id: 'bx3', x: 3},
  });
  expect(queryCallCount).to.equal(4); // One for initial subscribe and one for the add.
  expect(onDataCallCount).to.equal(4);

  cancel();
});

testWithBothStores('subscribe with isEmpty and prefix', async () => {
  const log: boolean[] = [];

  const rep = await replicacheForTesting('subscribe-with-is-empty', {
    mutators: {
      addData,
      del: (tx, k: string) => tx.del(k),
    },
  });

  let queryCallCount = 0;
  let onDataCallCount = 0;
  const cancel = rep.subscribe(
    async (tx: ReadTransaction) => {
      queryCallCount++;
      return await tx.isEmpty();
    },
    {
      onData: (empty: boolean) => {
        onDataCallCount++;
        log.push(empty);
      },
    },
  );

  expect(log).to.deep.equal([]);
  expect(queryCallCount).to.equal(0);
  expect(onDataCallCount).to.equal(0);

  await tickAFewTimes();

  expect(log).to.deep.equal([true]);
  expect(queryCallCount).to.equal(1);
  expect(onDataCallCount).to.equal(1);

  await rep.mutate.addData({
    a: 1,
  });

  expect(log).to.deep.equal([true, false]);
  expect(queryCallCount).to.equal(2);
  expect(onDataCallCount).to.equal(2);

  await rep.mutate.addData({
    b: 2,
  });

  expect(log).to.deep.equal([true, false]);
  expect(queryCallCount).to.equal(3);
  expect(onDataCallCount).to.equal(2);

  await rep.mutate.del('a');

  expect(log).to.deep.equal([true, false]);
  expect(queryCallCount).to.equal(4);
  expect(onDataCallCount).to.equal(2);

  await rep.mutate.del('b');

  expect(log).to.deep.equal([true, false, true]);
  expect(queryCallCount).to.equal(5);
  expect(onDataCallCount).to.equal(3);

  cancel();
});

testWithBothStores('subscribe change keys', async () => {
  const log: ReadonlyJSONValue[][] = [];

  const rep = await replicacheForTesting('subscribe-change-keys', {
    mutators: {
      addData,
      del: (tx, k: string) => tx.del(k),
    },
  });

  let queryCallCount = 0;
  let onDataCallCount = 0;
  const cancel = rep.subscribe(
    async (tx: ReadTransaction) => {
      queryCallCount++;
      const a = await tx.get('a');
      const rv = [a ?? 'no-a'];
      if (a === 1) {
        rv.push((await tx.get('b')) ?? 'no b');
      }
      await tx.has('c');
      return rv;
    },
    {
      onData: (values: ReadonlyJSONValue[]) => {
        onDataCallCount++;
        log.push(values);
      },
    },
  );

  expect(log).to.have.length(0);
  expect(queryCallCount).to.equal(0);
  expect(onDataCallCount).to.equal(0);

  await rep.mutate.addData({
    a: 0,
  });

  expect(log).to.deep.equal([['no-a'], [0]]);
  expect(queryCallCount).to.equal(2); // One for initial subscribe and one for the add.
  expect(onDataCallCount).to.equal(2);

  await rep.mutate.addData({
    b: 2,
  });
  expect(queryCallCount).to.equal(2);
  expect(onDataCallCount).to.equal(2);

  log.length = 0;
  await rep.mutate.addData({
    a: 1,
  });
  expect(queryCallCount).to.equal(3);
  expect(onDataCallCount).to.equal(3);
  expect(log).to.deep.equal([[1, 2]]);

  log.length = 0;
  await rep.mutate.addData({
    b: 3,
  });
  expect(queryCallCount).to.equal(4);
  expect(onDataCallCount).to.equal(4);
  expect(log).to.deep.equal([[1, 3]]);

  log.length = 0;
  await rep.mutate.addData({
    a: 4,
  });
  expect(queryCallCount).to.equal(5);
  expect(onDataCallCount).to.equal(5);
  expect(log).to.deep.equal([[4]]);

  await rep.mutate.addData({
    b: 5,
  });
  expect(queryCallCount).to.equal(5);
  expect(onDataCallCount).to.equal(5);

  await rep.mutate.addData({
    c: 6,
  });
  expect(queryCallCount).to.equal(6);
  expect(onDataCallCount).to.equal(5);

  await rep.mutate.del('c');
  expect(queryCallCount).to.equal(7);
  expect(onDataCallCount).to.equal(5);

  cancel();
});

testWithBothStores('subscribe close', async () => {
  const rep = await replicacheForTesting('subscribe-close', {
    mutators: {addData},
  });

  const log: (ReadonlyJSONValue | undefined)[] = [];

  const cancel = rep.subscribe((tx: ReadTransaction) => tx.get('k'), {
    onData: value => log.push(value),
    onDone: () => (done = true),
  });

  expect(log).to.have.length(0);

  const add = rep.mutate.addData;
  await add({k: 0});
  await Promise.resolve();
  expect(log).to.deep.equal([undefined, 0]);

  let done = false;

  await rep.close();
  expect(done).to.equal(true);
  cancel();
});

testWithBothStores('name', async () => {
  const repA = await replicacheForTesting('a', {mutators: {addData}});
  const repB = await replicacheForTesting('b', {mutators: {addData}});

  const addA = repA.mutate.addData;
  const addB = repB.mutate.addData;

  await addA({key: 'A'});
  await addB({key: 'B'});

  expect(await repA.get('key')).to.equal('A');
  expect(await repB.get('key')).to.equal('B');

  await repA.close();
  await repB.close();

  indexedDB.deleteDatabase('a');
  indexedDB.deleteDatabase('b');
});

testWithBothStores('register with error', async () => {
  const rep = await replicacheForTesting('regerr', {
    mutators: {
      err: async (_: WriteTransaction, args: number) => {
        throw args;
      },
    },
  });

  const doErr = rep.mutate.err;

  try {
    await doErr(42);
    fail('Should have thrown');
  } catch (ex) {
    expect(ex).to.equal(42);
  }
});

testWithBothStores('subscribe with error', async () => {
  const rep = await replicacheForTesting('suberr', {mutators: {addData}});

  const add = rep.mutate.addData;

  let gottenValue = 0;
  let error;

  const cancel = rep.subscribe(
    async tx => {
      const v = await tx.get('k');
      if (v !== undefined && v !== null) {
        throw v;
      }
      return null;
    },
    {
      onData: () => {
        gottenValue++;
      },
      onError: e => {
        error = e;
      },
    },
  );
  await Promise.resolve();

  expect(error).to.equal(undefined);
  expect(gottenValue).to.equal(0);

  await add({k: 'throw'});
  expect(gottenValue).to.equal(1);
  await Promise.resolve();
  expect(error).to.equal('throw');

  cancel();
});

testWithBothStores('overlapping writes', async () => {
  async function dbWait(tx: ReadTransaction, dur: number) {
    // Try to take setTimeout away from me???
    const t0 = Date.now();
    while (Date.now() - t0 > dur) {
      await tx.get('foo');
    }
  }

  const pushURL = 'https://push.com';
  // writes wait on writes
  const rep = await replicacheForTesting('conflict', {
    pushURL,
    mutators: {
      'wait-then-return': async <T extends JSONValue>(
        tx: ReadTransaction,
        {duration, ret}: {duration: number; ret: T},
      ) => {
        await dbWait(tx, duration);
        return ret;
      },
    },
  });
  fetchMock.post(pushURL, {});

  const mut = rep.mutate['wait-then-return'];

  let resA = mut({duration: 250, ret: 'a'});
  // create a gap to make sure resA starts first (our rwlock isn't fair).
  await clock.tickAsync(100);
  let resB = mut({duration: 0, ret: 'b'});
  // race them, a should complete first, indicating that b waited
  expect(await Promise.race([resA, resB])).to.equal('a');
  // wait for the other to finish so that we're starting from null state for next one.
  await Promise.all([resA, resB]);

  // reads wait on writes
  resA = mut({duration: 250, ret: 'a'});
  await clock.tickAsync(100);
  resB = rep.query(() => 'b');
  await tickAFewTimes();
  expect(await Promise.race([resA, resB])).to.equal('a');

  await tickAFewTimes();
  await resA;
  await tickAFewTimes();
  await resB;
});

testWithBothStores('push', async () => {
  const pushURL = 'https://push.com';

  const rep = await replicacheForTesting('push', {
    auth: '1',
    pushURL,
    pushDelay: 10,
    mutators: {
      createTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        createCount++;
        await tx.put(`/todo/${args.id}`, args);
      },
      deleteTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        deleteCount++;
        await tx.del(`/todo/${args.id}`);
      },
    },
  });

  let createCount = 0;
  let deleteCount = 0;

  const {createTodo, deleteTodo} = rep.mutate;

  const id1 = 14323534;
  const id2 = 22354345;

  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(2);

  fetchMock.postOnce(pushURL, {
    mutationInfos: [
      {id: 1, error: 'deleteTodo: todo not found'},
      {id: 2, error: 'deleteTodo: todo not found'},
    ],
  });
  await tickAFewTimes();
  expect(deleteCount).to.equal(2);
  const {mutations} = await fetchMock.lastCall().request.json();
  expect(mutations).to.deep.equal([
    {id: 1, name: 'deleteTodo', args: {id: id1}},
    {id: 2, name: 'deleteTodo', args: {id: id2}},
  ]);

  await createTodo({
    id: id1,
    text: 'Test',
  });
  expect(createCount).to.equal(1);
  expect(((await rep?.get(`/todo/${id1}`)) as {text: string}).text).to.equal(
    'Test',
  );

  fetchMock.postOnce(pushURL, {
    mutationInfos: [{id: 3, error: 'mutation has already been processed'}],
  });
  await tickAFewTimes();
  {
    const {mutations} = await fetchMock.lastCall().request.json();
    expect(mutations).to.deep.equal([
      {id: 1, name: 'deleteTodo', args: {id: id1}},
      {id: 2, name: 'deleteTodo', args: {id: id2}},
      {id: 3, name: 'createTodo', args: {id: id1, text: 'Test'}},
    ]);
  }

  await createTodo({
    id: id2,
    text: 'Test 2',
  });
  expect(createCount).to.equal(2);
  expect(((await rep?.get(`/todo/${id2}`)) as {text: string}).text).to.equal(
    'Test 2',
  );

  // Clean up
  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(2);

  fetchMock.postOnce(pushURL, {
    mutationInfos: [],
  });
  await tickAFewTimes();
  {
    const {mutations} = await fetchMock.lastCall().request.json();
    expect(mutations).to.deep.equal([
      {id: 1, name: 'deleteTodo', args: {id: id1}},
      {id: 2, name: 'deleteTodo', args: {id: id2}},
      {id: 3, name: 'createTodo', args: {id: id1, text: 'Test'}},
      {id: 4, name: 'createTodo', args: {id: id2, text: 'Test 2'}},
      {id: 5, name: 'deleteTodo', args: {id: id1}},
      {id: 6, name: 'deleteTodo', args: {id: id2}},
    ]);
  }

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(2);
});

testWithBothStores('push delay', async () => {
  const pushURL = 'https://push.com';

  const rep = await replicacheForTesting('push', {
    auth: '1',
    pushURL,
    pushDelay: 1,
    mutators: {
      createTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        await tx.put(`/todo/${args.id}`, args);
      },
    },
  });

  const {createTodo} = rep.mutate;

  const id1 = 14323534;

  await tickAFewTimes();
  fetchMock.reset();

  fetchMock.postOnce(pushURL, {
    mutationInfos: [],
  });

  expect(fetchMock.calls()).to.have.length(0);

  await createTodo({id: id1});

  expect(fetchMock.calls()).to.have.length(0);

  await tickAFewTimes();

  expect(fetchMock.calls()).to.have.length(1);
});

testWithBothStores(
  'push request is only sent when pushURL or non-default pusher are set',
  async () => {
    const rep = await replicacheForTestingNoDefaultURLs('no push requests', {
      auth: '1',
      pullURL: 'https://diff.com/pull',
      pushDelay: 1,
      mutators: {
        createTodo: async <A extends {id: number}>(
          tx: WriteTransaction,
          args: A,
        ) => {
          await tx.put(`/todo/${args.id}`, args);
        },
      },
    });

    const {createTodo} = rep.mutate;

    await tickAFewTimes();
    fetchMock.reset();
    fetchMock.postAny({});

    await createTodo({id: 'id1'});
    await tickAFewTimes();

    expect(fetchMock.calls()).to.have.length(0);

    await tickAFewTimes();
    fetchMock.reset();
    fetchMock.postAny({});

    rep.pushURL = 'https://diff.com/push';

    await createTodo({id: 'id2'});
    await tickAFewTimes();
    expect(fetchMock.calls()).to.have.length(1);

    await tickAFewTimes();
    fetchMock.reset();
    fetchMock.postAny({});

    rep.pushURL = '';

    await createTodo({id: 'id3'});
    await tickAFewTimes();
    expect(fetchMock.calls()).to.have.length(0);

    await tickAFewTimes();
    fetchMock.reset();
    fetchMock.postAny({});
    let pusherCallCount = 0;

    rep.pusher = () => {
      pusherCallCount++;
      return Promise.resolve({
        httpStatusCode: 200,
        errorMessage: '',
      });
    };

    await createTodo({id: 'id4'});
    await tickAFewTimes();

    expect(fetchMock.calls()).to.have.length(0);
    expect(pusherCallCount).to.equal(1);

    await tickAFewTimes();
    fetchMock.reset();
    fetchMock.postAny({});
    pusherCallCount = 0;

    rep.pusher = defaultPusher;

    await createTodo({id: 'id5'});
    await tickAFewTimes();

    expect(fetchMock.calls()).to.have.length(0);
    expect(pusherCallCount).to.equal(0);
  },
);

testWithBothStores('pull', async () => {
  const pullURL = 'https://diff.com/pull';

  const rep = await replicacheForTesting('pull', {
    auth: '1',
    pullURL,
    mutators: {
      createTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        createCount++;
        await tx.put(`/todo/${args.id}`, args);
      },
      deleteTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        deleteCount++;
        await tx.del(`/todo/${args.id}`);
      },
    },
  });

  let createCount = 0;
  let deleteCount = 0;
  let syncHead: Hash;
  let beginPullResult: {
    requestID: string;
    syncHead: Hash;
    ok: boolean;
  };

  const {createTodo, deleteTodo} = rep.mutate;

  const id1 = 14323534;
  const id2 = 22354345;

  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(2);

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 2,
    patch: [
      {op: 'del', key: ''},
      {
        op: 'put',
        key: '/list/1',
        value: {id: 1, ownerUserID: 1},
      },
    ],
  });
  rep.pull();
  await tickAFewTimes();
  expect(deleteCount).to.equal(2);

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 2,
    patch: [],
  });
  beginPullResult = await rep.beginPull();
  ({syncHead} = beginPullResult);
  expect(syncHead).to.equal(emptyHash);
  expect(deleteCount).to.equal(2);

  await createTodo({
    id: id1,
    text: 'Test',
  });
  expect(createCount).to.equal(1);
  expect(((await rep?.get(`/todo/${id1}`)) as {text: string}).text).to.equal(
    'Test',
  );

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 3,
    patch: [
      {
        op: 'put',
        key: '/todo/14323534',
        value: {id: 14323534, text: 'Test'},
      },
    ],
  });
  beginPullResult = await rep.beginPull();
  ({syncHead} = beginPullResult);
  expect(syncHead).equal('qfu3cr72r5lvoceqh88ku809bt1f6tev');

  await createTodo({
    id: id2,
    text: 'Test 2',
  });
  expect(createCount).to.equal(2);
  expect(((await rep?.get(`/todo/${id2}`)) as {text: string}).text).to.equal(
    'Test 2',
  );

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 3,
    patch: [],
  });
  await rep.maybeEndPull(beginPullResult);

  expect(createCount).to.equal(3);

  // Clean up
  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(3);

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 6,
    patch: [{op: 'del', key: '/todo/14323534'}],
  });
  rep.pull();
  await tickAFewTimes();

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(3);
});

testWithBothStores('reauth pull', async () => {
  const pullURL = 'https://diff.com/pull';

  const rep = await replicacheForTesting('reauth', {
    pullURL,
    auth: 'wrong',
  });

  fetchMock.post(pullURL, {body: 'xxx', status: httpStatusUnauthorized});

  const consoleErrorStub = sinon.stub(console, 'error');

  const getAuthFake = sinon.fake.returns(null);
  rep.getAuth = getAuthFake;

  await rep.beginPull();

  expect(getAuthFake.callCount).to.equal(1);
  expect(consoleErrorStub.firstCall.args[0]).to.equal(
    'Got error response from server (https://diff.com/pull) doing pull: 401: xxx',
  );

  {
    const consoleInfoStub = sinon.stub(console, 'info');
    const getAuthFake = sinon.fake(() => 'boo');
    rep.getAuth = getAuthFake;

    expect((await rep.beginPull()).syncHead).to.equal(emptyHash);

    expect(getAuthFake.callCount).to.equal(8);
    expect(consoleInfoStub.firstCall.args[0]).to.equal(
      'Tried to reauthenticate too many times',
    );
  }
});

testWithBothStores(
  'pull request is only sent when pullURL or non-default puller are set',
  async () => {
    const rep = await replicacheForTestingNoDefaultURLs('no push requests', {
      auth: '1',
      pushURL: 'https://diff.com/push',
    });

    await tickAFewTimes();
    fetchMock.reset();
    fetchMock.postAny({});

    rep.pull();
    await tickAFewTimes();

    expect(fetchMock.calls()).to.have.length(0);

    await tickAFewTimes();
    fetchMock.reset();

    rep.pullURL = 'https://diff.com/pull';
    fetchMock.post(rep.pullURL, {lastMutationID: 0, patch: []});

    rep.pull();
    await tickAFewTimes();
    expect(fetchMock.calls()).to.have.length.greaterThan(0);

    await tickAFewTimes();
    fetchMock.reset();
    fetchMock.postAny({});

    rep.pullURL = '';

    rep.pull();
    await tickAFewTimes();
    expect(fetchMock.calls()).to.have.length(0);

    await tickAFewTimes();
    fetchMock.reset();
    fetchMock.postAny({});

    let pullerCallCount = 0;

    rep.puller = () => {
      pullerCallCount++;
      return Promise.resolve({
        httpRequestInfo: {
          httpStatusCode: 500,
          errorMessage: 'Test failure',
        },
      });
    };

    rep.pull();
    await tickAFewTimes();

    expect(fetchMock.calls()).to.have.length(0);
    expect(pullerCallCount).to.be.greaterThan(0);

    await tickAFewTimes();
    fetchMock.reset();
    fetchMock.postAny({});
    pullerCallCount = 0;

    rep.puller = defaultPuller;

    rep.pull();
    await tickAFewTimes();

    expect(fetchMock.calls()).to.have.length(0);
    expect(pullerCallCount).to.equal(0);
  },
);

testWithBothStores('reauth push', async () => {
  const pushURL = 'https://diff.com/push';

  const rep = await replicacheForTesting('reauth', {
    pushURL,
    pushAuth: 'wrong',
    pushDelay: 0,
    mutators: {
      noop() {
        // no op
      },
    },
  });

  const consoleErrorStub = sinon.stub(console, 'error');
  const getPushAuthFake = sinon.fake.returns(null);
  rep.getPushAuth = getPushAuthFake;

  await tickAFewTimes();

  fetchMock.post(pushURL, {body: 'xxx', status: httpStatusUnauthorized});

  await rep.mutate.noop();
  await tickUntil(() => getPushAuthFake.callCount > 0, 1);

  expect(consoleErrorStub.firstCall.args[0]).to.equal(
    'Got error response from server (https://diff.com/push) doing push: 401: xxx',
  );

  {
    await tickAFewTimes();

    const consoleInfoStub = sinon.stub(console, 'info');
    const getPushAuthFake = sinon.fake(() => 'boo');
    rep.getPushAuth = getPushAuthFake;

    await rep.mutate.noop();
    await tickUntil(() => consoleInfoStub.callCount > 0, 1);

    expect(consoleInfoStub.firstCall.args[0]).to.equal(
      'Tried to reauthenticate too many times',
    );
  }
});

testWithBothStores('HTTP status pull', async () => {
  const pullURL = 'https://diff.com/pull';

  const rep = await replicacheForTesting('http-status-pull', {
    pullURL,
  });

  let okCalled = false;
  let i = 0;
  fetchMock.post(pullURL, () => {
    switch (i++) {
      case 0:
        return {body: 'internal error', status: 500};
      case 1:
        return {body: 'not found', status: 404};
      default:
        okCalled = true;
        return {body: {lastMutationID: 0, patch: []}, status: 200};
    }
  });

  const consoleErrorStub = sinon.stub(console, 'error');

  rep.pull();

  await tickAFewTimes(20, 10);

  expect(consoleErrorStub.getCalls().map(o => o.args[0])).to.deep.equal([
    'Got error response from server (https://diff.com/pull) doing pull: 500: internal error',
    'Got error response from server (https://diff.com/pull) doing pull: 404: not found',
  ]);

  expect(okCalled).to.equal(true);
});

testWithBothStores('HTTP status push', async () => {
  const pushURL = 'https://diff.com/push';

  const rep = await replicacheForTesting('http-status-push', {
    pushURL,
    pushDelay: 1,
    mutators: {addData},
  });
  const add = rep.mutate.addData;

  let okCalled = false;
  let i = 0;
  fetchMock.post(pushURL, () => {
    switch (i++) {
      case 0:
        return {body: 'internal error', status: 500};
      case 1:
        return {body: 'not found', status: 404};
      default:
        okCalled = true;
        return {body: {}, status: 200};
    }
  });

  const consoleErrorStub = sinon.stub(console, 'error');

  await add({
    a: 0,
  });

  await tickAFewTimes(20, 10);

  expect(consoleErrorStub.getCalls().map(o => o.args[0])).to.deep.equal([
    'Got error response from server (https://diff.com/push) doing push: 500: internal error',
    'Got error response from server (https://diff.com/push) doing push: 404: not found',
  ]);

  expect(okCalled).to.equal(true);
});

testWithBothStores('poke', async () => {
  // TODO(MP) test:
  // - when we queue a poke and it matches, we update the snapshot
  // - rebase still works
  // - when the cookie doesn't match, it doesn't apply, but later when the cookie matches it does
  // - per-client timing
  const rep = await replicacheForTesting('poke', {
    auth: '1',
    mutators: {
      setTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        await tx.put(`/todo/${args.id}`, args);
      },
    },
  });

  const {setTodo} = rep.mutate;

  const id = 1;
  const key = `/todo/${id}`;
  const text = 'yo';

  await setTodo({id, text});
  expect(await rep.has(key)).true;

  // cookie *does* apply
  await rep.poke({
    baseCookie: null,
    pullResponse: {
      cookie: 'c1',
      lastMutationID: 1,
      patch: [{op: 'del', key}],
    },
  });
  expect(await rep.has(key)).false;

  // cookie does not apply
  await setTodo({id, text});
  let error = null;
  try {
    await rep.poke({
      baseCookie: null,
      pullResponse: {
        cookie: 'c1',
        lastMutationID: 1,
        patch: [{op: 'del', key}],
      },
    });
  } catch (e) {
    error = String(e);
  }
  expect(error).contains('unexpected base cookie for poke');
  expect(await rep.has(key)).true;

  // cookie applies, but lmid goes backward - should be an error.
  await setTodo({id, text});
  error = null;
  try {
    // blech could not figure out how to use chai-as-promised.
    await rep.poke({
      baseCookie: 'c1',
      pullResponse: {
        cookie: 'c2',
        lastMutationID: 0,
        patch: [{op: 'del', key}],
      },
    });
  } catch (e: unknown) {
    error = String(e);
  }
  expect(error).contains(
    'Received lastMutationID 0 is < than last snapshot lastMutationID 1; ignoring client view',
  );
});

testWithBothStores('closed tx', async () => {
  const rep = await replicacheForTesting('reauth', {
    mutators: {
      mut: async tx => {
        wtx = tx;
      },
    },
  });

  let rtx: ReadTransaction;
  await rep.query(tx => (rtx = tx));

  await expectAsyncFuncToThrow(() => rtx.get('x'), TransactionClosedError);
  await expectAsyncFuncToThrow(() => rtx.has('y'), TransactionClosedError);
  await expectAsyncFuncToThrow(
    () => rtx.scan().values().next(),
    TransactionClosedError,
  );

  let wtx: WriteTransaction | undefined;

  await rep.mutate.mut();
  expect(wtx).to.not.be.undefined;
  await expectAsyncFuncToThrow(() => wtx?.put('z', 1), TransactionClosedError);
  await expectAsyncFuncToThrow(() => wtx?.del('w'), TransactionClosedError);
});

testWithBothStores('pullInterval in constructor', async () => {
  const rep = await replicacheForTesting('pullInterval', {
    pullInterval: 12.34,
  });
  expect(rep.pullInterval).to.equal(12.34);
  await rep.close();
});

testWithBothStores('closeTransaction after rep.scan', async () => {
  const readSpy = sinon.spy(dag.Store.prototype, 'read');
  const scanSpy = sinon.spy(db.Read.prototype, 'scan');
  const closeSpy = sinon.spy(db.Read.prototype, 'close');

  const rep = await replicacheForTesting('test5', {mutators: {addData}});
  const add = rep.mutate.addData;
  await add({
    'a/0': 0,
    'a/1': 1,
  });

  const log: ReadonlyJSONValue[] = [];

  function expectCalls(l: JSONValue[]) {
    expect(l).to.deep.equal(log);

    expect(readSpy.callCount).to.equal(1);
    expect(scanSpy.callCount).to.equal(1);
    expect(closeSpy.callCount).to.equal(1);

    readSpy.resetHistory();
    scanSpy.resetHistory();
    closeSpy.resetHistory();
    log.length = 0;
  }

  const it = rep.scan();

  for await (const v of it) {
    log.push(v);
  }
  expectCalls([0, 1]);

  // One more time with return in loop...
  await (async () => {
    if (!rep) {
      fail();
    }
    const it = rep.scan();
    for await (const v of it) {
      log.push(v);
      return;
    }
  })();
  expectCalls([0]);

  // ... and with a break.
  {
    const it = rep.scan();
    for await (const v of it) {
      log.push(v);
      break;
    }
  }
  expectCalls([0]);

  // ... and with a throw.
  (
    await expectPromiseToReject(
      (async () => {
        if (!rep) {
          fail();
        }
        const it = rep.scan();
        for await (const v of it) {
          log.push(v);
          throw 'hi!';
        }
      })(),
    )
  ).to.equal('hi!');

  expectCalls([0]);

  // ... and with a throw.
  (
    await expectPromiseToReject(
      (async () => {
        if (!rep) {
          fail();
        }
        const it = rep.scan();
        for await (const v of it) {
          log.push(v);
          throw 'hi!';
        }
      })(),
    )
  ).to.equal('hi!');
  expectCalls([0]);
});

testWithBothStores('index', async () => {
  const rep = await replicacheForTesting('test-index', {mutators: {addData}});

  const add = rep.mutate.addData;
  await add({
    'a/0': {a: '0'},
    'a/1': {a: '1'},
    'a/2': {a: '2'},
    'a/3': {a: '3'},
    'a/4': {a: '4'},
    'b/0': {bc: '5'},
    'b/1': {bc: '6'},
    'b/2': {bc: '7'},
    'c/0': {bc: '8'},
    'd/0': {d: {e: {f: '9'}}},
  });
  await rep.createIndex({name: 'aIndex', jsonPointer: '/a'});

  await testScanResult(rep, {indexName: 'aIndex'}, [
    [['0', 'a/0'], {a: '0'}],
    [['1', 'a/1'], {a: '1'}],
    [['2', 'a/2'], {a: '2'}],
    [['3', 'a/3'], {a: '3'}],
    [['4', 'a/4'], {a: '4'}],
  ]);
  await rep.dropIndex('aIndex');
  const x = rep.scan({indexName: 'aIndex'});
  (await expectPromiseToReject(x.values().next())).to.be
    .instanceOf(Error)
    .with.property('message', 'Unknown index name: aIndex');

  await rep.createIndex({name: 'aIndex', jsonPointer: '/a'});
  await testScanResult(rep, {indexName: 'aIndex'}, [
    [['0', 'a/0'], {a: '0'}],
    [['1', 'a/1'], {a: '1'}],
    [['2', 'a/2'], {a: '2'}],
    [['3', 'a/3'], {a: '3'}],
    [['4', 'a/4'], {a: '4'}],
  ]);
  await rep.dropIndex('aIndex');
  (await expectPromiseToReject(rep.scan({indexName: 'aIndex'}).toArray())).to.be
    .instanceOf(Error)
    .with.property('message', 'Unknown index name: aIndex');

  await rep.createIndex({name: 'bc', prefix: 'c/', jsonPointer: '/bc'});
  await testScanResult(rep, {indexName: 'bc'}, [[['8', 'c/0'], {bc: '8'}]]);
  await add({
    'c/1': {bc: '88'},
  });
  await testScanResult(rep, {indexName: 'bc'}, [
    [['8', 'c/0'], {bc: '8'}],
    [['88', 'c/1'], {bc: '88'}],
  ]);
  await rep.dropIndex('bc');

  await rep.createIndex({name: 'dIndex', jsonPointer: '/d/e/f'});
  await testScanResult(rep, {indexName: 'dIndex'}, [
    [['9', 'd/0'], {d: {e: {f: '9'}}}],
  ]);
  await rep.dropIndex('dIndex');

  await add({
    'e/0': {'': ''},
  });
  await rep.createIndex({name: 'emptyKeyIndex', jsonPointer: '/'});
  await testScanResult(rep, {indexName: 'emptyKeyIndex'}, [
    [['', 'e/0'], {'': ''}],
  ]);
  await rep.dropIndex('emptyKeyIndex');
});

testWithBothStores('index array', async () => {
  const rep = await replicacheForTesting('test-index', {mutators: {addData}});

  const add = rep.mutate.addData;
  await add({
    'a/0': {a: []},
    'a/1': {a: ['0']},
    'a/2': {a: ['1', '2']},
    'a/3': {a: '3'},
    'a/4': {a: ['4']},
    'b/0': {bc: '5'},
    'b/1': {bc: '6'},
    'b/2': {bc: '7'},
    'c/0': {bc: '8'},
  });

  await rep.createIndex({name: 'aIndex', jsonPointer: '/a'});
  await testScanResult(rep, {indexName: 'aIndex'}, [
    [['0', 'a/1'], {a: ['0']}],
    [['1', 'a/2'], {a: ['1', '2']}],
    [['2', 'a/2'], {a: ['1', '2']}],
    [['3', 'a/3'], {a: '3'}],
    [['4', 'a/4'], {a: ['4']}],
  ]);
  await rep.dropIndex('aIndex');
});

testWithBothStores('index scan start', async () => {
  const rep = await replicacheForTesting('test-index-scan', {
    mutators: {addData},
  });

  const add = rep.mutate.addData;
  await add({
    'a/1': {a: '0'},
    'b/0': {b: 'a5'},
    'b/1': {b: 'a6'},
    'b/2': {b: 'b7'},
    'b/3': {b: 'b8'},
  });

  await rep.createIndex({
    name: 'bIndex',
    jsonPointer: '/b',
  });

  for (const key of ['a6', ['a6'], ['a6', undefined], ['a6', '']] as (
    | string
    | [string, string?]
  )[]) {
    await testScanResult(rep, {indexName: 'bIndex', start: {key}}, [
      [['a6', 'b/1'], {b: 'a6'}],
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ]);
    await testScanResult(
      rep,
      {indexName: 'bIndex', start: {key, exclusive: false}},
      [
        [['a6', 'b/1'], {b: 'a6'}],
        [['b7', 'b/2'], {b: 'b7'}],
        [['b8', 'b/3'], {b: 'b8'}],
      ],
    );
  }

  for (const key of ['a6', ['a6'], ['a6', undefined]] as (
    | string
    | [string, string?]
  )[]) {
    await testScanResult(
      rep,
      {indexName: 'bIndex', start: {key, exclusive: false}},
      [
        [['a6', 'b/1'], {b: 'a6'}],
        [['b7', 'b/2'], {b: 'b7'}],
        [['b8', 'b/3'], {b: 'b8'}],
      ],
    );
    await testScanResult(
      rep,
      {indexName: 'bIndex', start: {key: ['a6', ''], exclusive: true}},
      [
        [['a6', 'b/1'], {b: 'a6'}],
        [['b7', 'b/2'], {b: 'b7'}],
        [['b8', 'b/3'], {b: 'b8'}],
      ],
    );
  }

  for (const key of ['a6', ['a6'], ['a6', undefined]] as (
    | string
    | [string, string?]
  )[]) {
    await testScanResult(
      rep,
      {indexName: 'bIndex', start: {key, exclusive: true}},
      [
        [['b7', 'b/2'], {b: 'b7'}],
        [['b8', 'b/3'], {b: 'b8'}],
      ],
    );
  }

  await testScanResult(
    rep,
    {indexName: 'bIndex', start: {key: ['b7', 'b/2']}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );
  await testScanResult(
    rep,
    {indexName: 'bIndex', start: {key: ['b7', 'b/2'], exclusive: false}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );
  await testScanResult(
    rep,
    {indexName: 'bIndex', start: {key: ['b7', 'b/2'], exclusive: true}},
    [[['b8', 'b/3'], {b: 'b8'}]],
  );

  await testScanResult(
    rep,
    {indexName: 'bIndex', start: {key: ['a6', 'b/2']}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );
  await testScanResult(
    rep,
    {indexName: 'bIndex', start: {key: ['a6', 'b/2'], exclusive: false}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );
  await testScanResult(
    rep,
    {indexName: 'bIndex', start: {key: ['a6', 'b/2'], exclusive: true}},
    [
      [['b7', 'b/2'], {b: 'b7'}],
      [['b8', 'b/3'], {b: 'b8'}],
    ],
  );

  await rep.dropIndex('bIndex');
});

testWithBothStores('logLevel', async () => {
  const info = sinon.stub(console, 'info');
  const debug = sinon.stub(console, 'debug');

  // Just testing that we get some output
  let rep = await replicacheForTesting('log-level', {logLevel: 'error'});
  await rep.query(() => 42);
  expect(info.callCount).to.equal(0);
  await rep.close();

  info.reset();
  debug.reset();
  await tickAFewTimes(10, 100);

  rep = await replicacheForTesting('log-level', {logLevel: 'info'});
  await rep.query(() => 42);
  expect(info.callCount).to.equal(0);
  expect(debug.callCount).to.equal(0);
  await rep.close();

  info.reset();
  debug.reset();
  await tickAFewTimes(10, 100);

  rep = await replicacheForTesting('log-level', {logLevel: 'debug'});
  await rep.query(() => 42);
  expect(info.callCount).to.equal(0);
  expect(debug.callCount).to.be.greaterThan(0);

  expect(
    debug.getCalls().some(call => call.firstArg === 'db=log-level'),
  ).to.equal(true);
  expect(
    debug.getCalls().some(call => call.firstArg.includes('PULL')),
  ).to.equal(true);
  expect(
    debug.getCalls().some(call => call.firstArg.includes('PUSH')),
  ).to.equal(true);

  await rep.close();
});

test('mem store', async () => {
  let rep = await replicacheForTesting('mem', {
    mutators: {addData},
    useMemstore: true,
  });
  const add = rep.mutate.addData;
  await add({a: 42});
  expect(await rep.query(tx => tx.get('a'))).to.equal(42);
  await rep.close();

  // Open again and test that we lost the data
  rep = await replicacheForTesting('mem', {useMemstore: true});
  expect(await rep.query(tx => tx.get('a'))).to.equal(undefined);
});

testWithBothStores('isEmpty', async () => {
  const rep = await replicacheForTesting('test-is-empty', {
    mutators: {
      addData,
      del: (tx: WriteTransaction, key: string) => tx.del(key),
      mut: async tx => {
        expect(await tx.isEmpty()).to.equal(false);

        await tx.del('c');
        expect(await tx.isEmpty()).to.equal(false);

        await tx.del('a');
        expect(await tx.isEmpty()).to.equal(true);

        await tx.put('d', 4);
        expect(await tx.isEmpty()).to.equal(false);
      },
    },
  });
  const {addData: add, del, mut} = rep.mutate;

  async function t(expected: boolean) {
    expect(await rep?.query(tx => tx.isEmpty())).to.equal(expected);
    expect(await rep?.isEmpty()).to.equal(expected);
  }

  await t(true);

  await add({a: 1});
  await t(false);

  await add({b: 2, c: 3});
  await t(false);

  await del('b');
  await t(false);

  await mut();

  await t(false);
});

testWithBothStores('onSync', async () => {
  const pullURL = 'https://pull.com/pull';
  const pushURL = 'https://push.com/push';

  const rep = await replicacheForTesting('onSync', {
    pullURL,
    pushURL,
    pushDelay: 5,
    mutators: {addData},
  });
  const add = rep.mutate.addData;

  const onSync = sinon.fake();
  rep.onSync = onSync;

  expect(onSync.callCount).to.equal(0);

  fetchMock.postOnce(pullURL, {
    cookie: '',
    lastMutationID: 2,
    patch: [],
  });
  rep.pull();
  await tickAFewTimes(15);

  expect(onSync.callCount).to.equal(2);
  expect(onSync.getCall(0).args[0]).to.be.true;
  expect(onSync.getCall(1).args[0]).to.be.false;

  onSync.resetHistory();
  fetchMock.postOnce(pushURL, {});
  await add({a: 'a'});
  await tickAFewTimes();

  expect(onSync.callCount).to.equal(2);
  expect(onSync.getCall(0).args[0]).to.be.true;
  expect(onSync.getCall(1).args[0]).to.be.false;

  fetchMock.postOnce(pushURL, {});
  onSync.resetHistory();
  await add({b: 'b'});
  await tickAFewTimes();
  expect(onSync.callCount).to.equal(2);
  expect(onSync.getCall(0).args[0]).to.be.true;
  expect(onSync.getCall(1).args[0]).to.be.false;

  {
    // Try with reauth
    const consoleErrorStub = sinon.stub(console, 'error');
    fetchMock.postOnce(pushURL, {body: 'xxx', status: httpStatusUnauthorized});
    onSync.resetHistory();
    rep.getAuth = () => {
      // Next time it is going to be fine
      fetchMock.postOnce({url: pushURL, headers: {authorization: 'ok'}}, {});
      return 'ok';
    };

    await add({c: 'c'});

    await tickUntil(() => onSync.callCount >= 4);

    expect(consoleErrorStub.firstCall.args[0]).to.equal(
      'Got error response from server (https://push.com/push) doing push: 401: xxx',
    );

    expect(onSync.callCount).to.equal(4);
    expect(onSync.getCall(0).args[0]).to.be.true;
    expect(onSync.getCall(1).args[0]).to.be.false;
    expect(onSync.getCall(2).args[0]).to.be.true;
    expect(onSync.getCall(3).args[0]).to.be.false;
  }

  rep.onSync = null;
  onSync.resetHistory();
  fetchMock.postOnce(pushURL, {});
  expect(onSync.callCount).to.equal(0);
});

testWithBothStores('push timing', async () => {
  const pushURL = 'https://push.com/push';
  const pushDelay = 5;

  const rep = await replicacheForTesting('push-timing', {
    pushURL,
    pushDelay,
    useMemstore: true,
    mutators: {addData},
  });

  const invokePushSpy = sinon.spy(rep, 'invokePush');

  const add = rep.mutate.addData;

  fetchMock.post(pushURL, {});
  await add({a: 0});
  await tickAFewTimes();

  const pushCallCount = () => {
    const rv = invokePushSpy.callCount;
    invokePushSpy.resetHistory();
    return rv;
  };

  expect(pushCallCount()).to.equal(1);

  // This will schedule push in pushDelay ms
  await add({a: 1});
  await add({b: 2});
  await add({c: 3});
  await add({d: 4});

  expect(pushCallCount()).to.equal(0);

  await clock.tickAsync(pushDelay + 10);

  expect(pushCallCount()).to.equal(1);

  const p1 = add({e: 5});
  const p2 = add({f: 6});
  const p3 = add({g: 7});

  expect(pushCallCount()).to.equal(0);

  await tickAFewTimes();
  await p1;
  expect(pushCallCount()).to.equal(1);
  await tickAFewTimes();
  await p2;
  expect(pushCallCount()).to.equal(0);
  await tickAFewTimes();
  await p3;
  expect(pushCallCount()).to.equal(0);
});

testWithBothStores('push and pull concurrently', async () => {
  const pushURL = 'https://push.com/push';
  const pullURL = 'https://pull.com/pull';

  const rep = await replicacheForTesting('concurrently', {
    pullURL,
    pushURL,
    useMemstore: true,
    pushDelay: 10,
    mutators: {addData},
  });

  const beginPullSpy = sinon.spy(rep, 'beginPull');
  const commitSpy = sinon.spy(db.Write.prototype, 'commitWithChangedKeys');
  const invokePushSpy = sinon.spy(rep, 'invokePush');
  const putSpy = sinon.spy(WriteTransactionImpl.prototype, 'put');
  const withWriteSpy = sinon.spy(dag.Store.prototype, 'withWrite');
  const writeSpy = sinon.spy(dag.Store.prototype, 'write');

  function resetSpys() {
    beginPullSpy.resetHistory();
    commitSpy.resetHistory();
    invokePushSpy.resetHistory();
    putSpy.resetHistory();
    withWriteSpy.resetHistory();
    writeSpy.resetHistory();
  }

  const callCounts = () => {
    const rv = {
      beginPull: beginPullSpy.callCount,
      commit: commitSpy.callCount,
      invokePush: invokePushSpy.callCount,
      put: putSpy.callCount,
      withWrite: withWriteSpy.callCount,
      write: writeSpy.callCount,
    };
    resetSpys();
    return rv;
  };

  const add = rep.mutate.addData;

  const reqs: string[] = [];

  fetchMock.post(pushURL, async () => {
    reqs.push(pushURL);
    return {};
  });
  fetchMock.post(pullURL, () => {
    reqs.push(pullURL);
    return {lastMutationID: 0, patch: []};
  });

  await add({a: 0});
  resetSpys();

  await add({b: 1});
  rep.pull();

  await clock.tickAsync(10);

  // Only one push at a time but we want push and pull to be concurrent.
  expect(callCounts()).to.deep.equal({
    beginPull: 1,
    commit: 1,
    invokePush: 1,
    put: 1,
    withWrite: 2,
    write: 0,
  });

  await tickAFewTimes();

  expect(reqs).to.deep.equal([pullURL, pushURL]);

  await tickAFewTimes();

  expect(reqs).to.deep.equal([pullURL, pushURL]);

  expect(callCounts()).to.deep.equal({
    beginPull: 0,
    commit: 0,
    invokePush: 0,
    put: 0,
    withWrite: 0,
    write: 0,
  });
});

test('schemaVersion pull', async () => {
  const schemaVersion = 'testing-pull';

  const rep = await replicacheForTesting('schema-version-pull', {
    schemaVersion,
  });

  rep.pull();
  await tickAFewTimes();

  const req = await fetchMock.lastCall().request.json();
  expect(req.schemaVersion).to.deep.equal(schemaVersion);
});

test('schemaVersion push', async () => {
  const pushURL = 'https://push.com/push';
  const schemaVersion = 'testing-push';

  const rep = await replicacheForTesting('schema-version-push', {
    pushURL,
    schemaVersion,
    pushDelay: 1,
    mutators: {addData},
  });

  const add = rep.mutate.addData;
  await add({a: 1});

  fetchMock.post(pushURL, {});
  await tickAFewTimes();

  const req = await fetchMock.lastCall().request.json();
  expect(req.schemaVersion).to.deep.equal(schemaVersion);
});

test('clientID', async () => {
  const re =
    /^[0-9:A-z]{8}-[0-9:A-z]{4}-4[0-9:A-z]{3}-[0-9:A-z]{4}-[0-9:A-z]{12}$/;

  let rep = await replicacheForTesting('clientID');
  const clientID = await rep.clientID;
  expect(clientID).to.match(re);
  await rep.close();

  const rep2 = await replicacheForTesting('clientID2');
  const clientID2 = await rep2.clientID;
  expect(clientID2).to.match(re);
  expect(clientID2).to.not.equal(clientID);

  rep = await replicacheForTesting('clientID');
  const clientID3 = await rep.clientID;
  expect(clientID3).to.match(re);
  expect(clientID3).to.equal(clientID);

  const rep4 = new Replicache({name: 'clientID4', pullInterval: null});
  const clientID4 = await rep4.clientID;
  expect(clientID4).to.match(re);
  await rep4.close();
});

testWithBothStores('pull and index update', async () => {
  const pullURL = 'https://pull.com/rep';
  const rep = await replicacheForTesting('pull-and-index-update', {
    pullURL,
  });

  const indexName = 'idx1';
  let lastMutationID = 0;

  async function testPull(opt: {
    patch: PatchOperation[];
    expectedResult: JSONValue;
  }) {
    let pullDone = false;
    fetchMock.post(pullURL, () => {
      pullDone = true;
      return {
        lastMutationID: lastMutationID++,
        patch: opt.patch,
      };
    });

    rep.pull();

    await tickUntil(() => pullDone);
    await tickAFewTimes();

    const actualResult = await rep.scan({indexName}).entries().toArray();
    expect(actualResult).to.deep.equal(opt.expectedResult);
  }

  await rep.createIndex({name: indexName, jsonPointer: '/id'});

  await testPull({patch: [], expectedResult: []});

  await testPull({
    patch: [
      {
        op: 'put',
        key: 'a1',
        value: {id: 'a-1', x: 1},
      },
    ],
    expectedResult: [
      [
        ['a-1', 'a1'],
        {
          id: 'a-1',
          x: 1,
        },
      ],
    ],
  });

  // Change value for existing key
  await testPull({
    patch: [
      {
        op: 'put',
        key: 'a1',
        value: {id: 'a-1', x: 2},
      },
    ],
    expectedResult: [
      [
        ['a-1', 'a1'],
        {
          id: 'a-1',
          x: 2,
        },
      ],
    ],
  });

  // Del
  await testPull({
    patch: [
      {
        op: 'del',
        key: 'a1',
      },
    ],
    expectedResult: [],
  });
});

testWithBothStores('subscribe pull and index update', async () => {
  const pullURL = 'https://pull.com/rep';
  const rep = await replicacheForTesting('subscribe-pull-and-index-update', {
    pullURL,
    mutators: {addData},
  });

  const indexName = 'idx1';
  await rep.createIndex({name: indexName, jsonPointer: '/id'});

  const log: ReadonlyJSONValue[] = [];
  let queryCallCount = 0;

  const cancel = rep.subscribe(
    tx => {
      queryCallCount++;
      return tx.scan({indexName}).entries().toArray();
    },
    {
      onData(res) {
        log.push(res);
      },
    },
  );

  let lastMutationID = 0;

  let expectedQueryCallCount = 1;

  async function testPull(opt: {
    patch: PatchOperation[];
    expectedLog: JSONValue[];
    expectChange: boolean;
  }) {
    if (opt.expectChange) {
      expectedQueryCallCount++;
    }
    log.length = 0;
    fetchMock.post(pullURL, {
      lastMutationID: lastMutationID++,
      patch: opt.patch,
    });

    rep.pull();
    await tickUntil(() => log.length >= opt.expectedLog.length);
    expect(queryCallCount).to.equal(expectedQueryCallCount);
    expect(log).to.deep.equal(opt.expectedLog);
  }

  await testPull({patch: [], expectedLog: [[]], expectChange: false});

  await testPull({
    patch: [
      {
        op: 'put',
        key: 'a1',
        value: {id: 'a-1', x: 1},
      },
    ],
    expectedLog: [
      [
        [
          ['a-1', 'a1'],
          {
            id: 'a-1',
            x: 1,
          },
        ],
      ],
    ],
    expectChange: true,
  });

  // Same value
  await testPull({
    patch: [
      {
        op: 'put',
        key: 'a1',
        value: {id: 'a-1', x: 1},
      },
    ],
    expectedLog: [],
    expectChange: false,
  });

  // Change value
  await testPull({
    patch: [
      {
        op: 'put',
        key: 'a1',
        value: {id: 'a-1', x: 2},
      },
    ],
    expectedLog: [
      [
        [
          ['a-1', 'a1'],
          {
            id: 'a-1',
            x: 2,
          },
        ],
      ],
    ],
    expectChange: true,
  });

  // Not matching index json patch
  await testPull({
    patch: [
      {
        op: 'put',
        key: 'b1',
        value: {notAnId: 'b-1', x: 1},
      },
    ],
    expectedLog: [],
    expectChange: false,
  });

  // Clear
  await testPull({
    patch: [
      {
        op: 'clear',
      },
    ],
    expectedLog: [[]],
    expectChange: true,
  });

  // Add again so we can test del...
  await testPull({
    patch: [
      {
        op: 'put',
        key: 'a2',
        value: {id: 'a-2', x: 2},
      },
    ],
    expectedLog: [
      [
        [
          ['a-2', 'a2'],
          {
            id: 'a-2',
            x: 2,
          },
        ],
      ],
    ],
    expectChange: true,
  });
  // .. and del
  await testPull({
    patch: [
      {
        op: 'del',
        key: 'a2',
      },
    ],
    expectedLog: [[]],
    expectChange: true,
  });

  cancel();
});

async function tickUntilTimeIs(time: number, tick = 10) {
  while (Date.now() < time) {
    await clock.tickAsync(tick);
  }
}

test('pull mutate options', async () => {
  const pullURL = 'https://diff.com/pull';
  const rep = await replicacheForTesting('pull-mutate-options', {
    pullURL,
    useMemstore: true,
  });

  const log: number[] = [];

  fetchMock.post(pullURL, () => {
    log.push(Date.now());
    return {
      cookie: '',
      lastMutationID: 2,
      patch: [],
    };
  });

  await tickUntilTimeIs(1000);

  while (Date.now() < 1150) {
    rep.pull();
    await clock.tickAsync(10);
  }

  rep.requestOptions.minDelayMs = 500;

  while (Date.now() < 2000) {
    rep.pull();
    await clock.tickAsync(100);
  }

  rep.requestOptions.minDelayMs = 25;

  while (Date.now() < 2500) {
    rep.pull();
    await clock.tickAsync(5);
  }

  expect(log).to.deep.equal([
    1000, 1030, 1060, 1090, 1120, 1150, 1180, 1680, 2180, 2205, 2230, 2255,
    2280, 2305, 2330, 2355, 2380, 2405, 2430, 2455, 2480,
  ]);
});

test('online', async () => {
  const pushURL = 'https://diff.com/push';
  const rep = await replicacheForTesting('online', {
    useMemstore: true,
    pushURL,
    pushDelay: 0,
    mutators: {addData},
  });

  const log: boolean[] = [];
  rep.onOnlineChange = b => {
    log.push(b);
  };

  const consoleError = sinon.stub(console, 'error');

  fetchMock.post(pushURL, async () => {
    await sleep(10);
    return {throws: new Error('Simulate fetch error in push')};
  });

  expect(rep.online).to.equal(true);
  expect(log).to.deep.equal([]);

  await rep.mutate.addData({a: 0});

  await tickAFewTimes();

  expect(rep.online).to.equal(false);
  expect(consoleError.callCount).to.be.greaterThan(0);
  expect(log).to.deep.equal([false]);

  consoleError.resetHistory();

  fetchMock.post(pushURL, {});
  await rep.mutate.addData({a: 1});

  await tickAFewTimes(20);

  expect(consoleError.callCount).to.equal(0);
  expect(rep.online).to.equal(true);
  expect(log).to.deep.equal([false, true]);
});

test('overlapping open/close', async () => {
  const pullInterval = 60_000;
  const name = 'overlapping-open-close';

  const rep = new Replicache({name, pullInterval});
  const p = rep.close();

  const rep2 = new Replicache({name, pullInterval});
  const p2 = rep2.close();

  const rep3 = new Replicache({name, pullInterval});
  const p3 = rep3.close();

  await p;
  await p2;
  await p3;

  {
    const rep = new Replicache({name, pullInterval});
    await rep.clientID;
    const p = rep.close();
    const rep2 = new Replicache({name, pullInterval});
    await rep2.clientID;
    const p2 = rep2.close();
    await p;
    await p2;
  }
});

class MemStoreWithCounters implements kv.Store {
  readonly store = new MemStore();
  readCount = 0;
  writeCount = 0;
  closeCount = 0;

  resetCounters() {
    this.readCount = 0;
    this.writeCount = 0;
    this.closeCount = 0;
  }

  read() {
    this.readCount++;
    return this.store.read();
  }

  withRead<R>(fn: (read: kv.Read) => R | Promise<R>): Promise<R> {
    this.readCount++;
    return this.store.withRead(fn);
  }

  write() {
    this.writeCount++;
    return this.store.write();
  }

  withWrite<R>(fn: (write: kv.Write) => R | Promise<R>): Promise<R> {
    this.writeCount++;
    return this.store.withWrite(fn);
  }

  async close() {
    this.closeCount++;
    await this.store.close();
  }

  get closed(): boolean {
    return this.store.closed;
  }
}

test('experiment KV Store', async () => {
  const store = new MemStoreWithCounters();
  const rep = await replicacheForTesting('experiment-kv-store', {
    experimentalKVStore: store,
    mutators: {addData},
  });

  expect(store.readCount).to.equal(4);
  expect(store.writeCount).to.equal(5);
  expect(store.closeCount).to.equal(0);
  store.resetCounters();

  const b = await rep.query(tx => tx.has('foo'));
  expect(b).to.be.false;

  expect(store.readCount).to.equal(1);
  expect(store.writeCount).to.equal(0);
  expect(store.closeCount).to.equal(0);
  store.resetCounters();

  await rep.mutate.addData({foo: 'bar'});
  expect(store.readCount).to.equal(0);
  expect(store.writeCount).to.equal(1);
  expect(store.closeCount).to.equal(0);
  store.resetCounters();

  await rep.close();
  expect(store.readCount).to.equal(0);
  expect(store.writeCount).to.equal(0);
  expect(store.closeCount).to.equal(1);
});

test('subscription coalescing', async () => {
  const store = new MemStoreWithCounters();
  const rep = await replicacheForTesting('experiment-kv-store', {
    experimentalKVStore: store,
    mutators: {addData},
  });

  expect(store.readCount).to.equal(4);
  expect(store.writeCount).to.equal(5);
  expect(store.closeCount).to.equal(0);
  store.resetCounters();

  const log: string[] = [];
  const ca = rep.subscribe(tx => tx.has('a'), {
    onData() {
      log.push('a');
    },
  });
  const cb = rep.subscribe(tx => tx.has('b'), {
    onData() {
      log.push('b');
    },
  });
  const cc = rep.subscribe(tx => tx.has('c'), {
    onData() {
      log.push('c');
    },
  });

  await tickUntil(() => log.length === 3);
  expect(log).to.deep.equal(['a', 'b', 'c']);

  expect(store.readCount).to.equal(1);
  expect(store.writeCount).to.equal(0);
  expect(store.closeCount).to.equal(0);
  store.resetCounters();

  ca();
  cb();
  cc();
  log.length = 0;
  rep.subscribe(tx => tx.has('d'), {
    onData() {
      log.push('d');
    },
  });
  rep.subscribe(tx => tx.has('e'), {
    onData() {
      log.push('e');
    },
  });

  expect(store.readCount).to.equal(0);
  expect(store.writeCount).to.equal(0);
  expect(store.closeCount).to.equal(0);
  store.resetCounters();

  await rep.mutate.addData({a: 1});

  expect(store.readCount).to.equal(1);
  expect(store.writeCount).to.equal(1);
  expect(store.closeCount).to.equal(0);

  expect(log).to.deep.equal(['d', 'e']);
});

function findPropertyValue(
  obj: unknown,
  propertyName: string,
  propertyValue: unknown,
): unknown | undefined {
  if (typeof obj === 'object' && obj !== null) {
    const rec = obj as Record<string, unknown>;
    if (rec[propertyName] === propertyValue) {
      return rec;
    }

    let values: Iterable<unknown>;
    if (obj instanceof Set || obj instanceof Map || obj instanceof Array) {
      values = obj.values();
    } else {
      values = Object.values(rec);
    }
    for (const v of values) {
      const r = findPropertyValue(v, propertyName, propertyValue);
      if (r) {
        return r;
      }
    }
  }
  return undefined;
}

test('mutate args in mutation', async () => {
  // This tests that mutating the args in a mutation does not mutate the args we
  // store in the kv.Store.
  const store = new TestMemStore();
  const rep = await replicacheForTesting('mutate-args-in-mutation', {
    experimentalKVStore: store,
    mutators: {
      async mutArgs(tx, args: {v: number}) {
        args.v = 42;
        await tx.put('v', args.v);
      },
    },
  });

  await rep.mutate.mutArgs({v: 1});

  const o = findPropertyValue(store.map(), 'mutatorName', 'mutArgs');
  expect((o as {mutatorArgsJSON?: unknown}).mutatorArgsJSON).to.deep.equal({
    v: 1,
  });
});

testWithBothStores('subscribe perf test regression', async () => {
  clock.restore();
  const count = 100;
  const maxCount = 1000;
  const minCount = 10;
  const key = (k: number) => `key${k}`;
  const rep = await replicacheForTesting('subscribe-perf-test-regression', {
    mutators: {
      async init(tx: WriteTransaction) {
        await Promise.all(
          Array.from({length: maxCount}, (_, i) => tx.put(key(i), i)),
        );
      },
      async put(tx: WriteTransaction, options: {key: string; val: JSONValue}) {
        // console.log('put', options.key, options.val);
        await tx.put(options.key, options.val);
      },
    },
  });

  await rep.mutate.init();
  const data = Array.from({length: count}).fill(0);
  let onDataCallCount = 0;
  const subs = Array.from({length: count}, (_, i) =>
    rep.subscribe(tx => tx.get(key(i)), {
      onData(v) {
        onDataCallCount++;
        data[i] = v;
      },
    }),
  );

  // We need to wait until all the initial async onData have been called.
  while (onDataCallCount !== count) {
    await sleep(10);
  }

  // The number of mutations to do. These should each trigger one
  // subscription. The goal of this test is to ensure that we are only
  // paying the runtime cost of subscriptions that are affected by the
  // changes.
  const mut = 10;
  if (mut < minCount) {
    throw new Error('Please decrease minCount');
  }
  const rand = Math.random();

  for (let i = 0; i < mut; i++) {
    await rep.mutate.put({key: key(i), val: i ** 2 + rand});
  }

  subs.forEach(c => c());

  await sleep(100);

  expect(onDataCallCount).to.equal(count + mut);
  for (let i = 0; i < count; i++) {
    expect(data[i]).to.equal(i < mut ? i ** 2 + rand : i);
  }
});

testWithBothStores('client ID is set correctly on transactions', async () => {
  const rep = await replicacheForTesting(
    'client-id-is-set-correctly-on-transactions',
    {
      mutators: {
        async expectClientID(tx, expectedClientID: string) {
          expect(tx.clientID).to.equal(expectedClientID);
        },
      },
    },
  );

  const repClientID = await rep.clientID;

  await rep.query(tx => {
    expect(tx.clientID).to.equal(repClientID);
  });

  await rep.mutate.expectClientID(repClientID);
});
