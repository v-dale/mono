import {test, expect} from '@jest/globals';
import {
  newInvalidateAllAuthRequest,
  newInvalidateForRoomAuthRequest,
  newInvalidateForUserAuthRequest,
} from '../client/auth.js';
import {newCreateRoomRequest, newDeleteRoomRequest} from '../client/room.js';
import {newAuthConnectionsRequest} from '../util/auth-test-util.js';
import {createSilentLogContext, TestLogSink} from '../util/test-utils.js';
import {version} from '../util/version.js';
import {createTestDurableObjectState} from './do-test-utils.js';
import {BaseRoomDO} from './room-do.js';
import {getVersion, putVersion} from '../types/version.js';
import {DurableStorage} from '../storage/durable-storage.js';
import {getUserValue, putUserValue} from '../types/user-value.js';
import type {WriteTransaction} from 'replicache';

test('sets roomID in createRoom', async () => {
  const testLogSink = new TestLogSink();
  const roomDO = new BaseRoomDO({
    mutators: {},
    roomStartHandler: () => Promise.resolve(),
    disconnectHandler: () => Promise.resolve(),
    state: await createTestDurableObjectState('test-do-id'),
    authApiKey: 'API KEY',
    logSink: testLogSink,
    logLevel: 'info',
    allowUnconfirmedWrites: true,
  });
  const createRoomRequest = newCreateRoomRequest(
    'http://example.com/',
    'API KEY',
    'testRoomID',
  );
  const response = await roomDO.fetch(createRoomRequest);
  expect(response.status).toBe(200);
  const lc = createSilentLogContext();
  const roomID = await roomDO.roomID(lc);
  expect(roomID).toBe('testRoomID');
});

test('inits storage schema', async () => {
  const testLogSink = new TestLogSink();
  const state = await createTestDurableObjectState('test-do-id');

  expect(await state.storage.get('storage_schema_meta')).toBeUndefined();

  new BaseRoomDO({
    mutators: {},
    roomStartHandler: () => Promise.resolve(),
    disconnectHandler: () => Promise.resolve(),
    state,
    authApiKey: 'API KEY',
    logSink: testLogSink,
    logLevel: 'info',
    allowUnconfirmedWrites: true,
  });

  await state.concurrencyBlockingCallbacks();

  // This just asserts that the storage schema was initialized by the room constructor.
  // The actual storage schema update logic is tested in the room-schema.test
  expect(await state.storage.get('storage_schema_meta')).not.toBeUndefined();
});

test('runs roomHandler exactly once', async () => {
  const testLogSink = new TestLogSink();
  const state = await createTestDurableObjectState('test-do-id');

  const storage = new DurableStorage(state.storage);
  const startingVersion = 23;
  await putVersion(startingVersion, storage);
  await putUserValue(
    'foo',
    {version: 1, deleted: false, value: 'bar'},
    storage,
  );

  const roomDO = new BaseRoomDO({
    mutators: {},
    roomStartHandler: async (tx: WriteTransaction) => {
      const value = await tx.get('foo');
      await tx.put('foo', `${value}+`);
    },
    disconnectHandler: () => Promise.resolve(),
    state,
    authApiKey: 'API KEY',
    logSink: testLogSink,
    logLevel: 'info',
    allowUnconfirmedWrites: true,
  });

  const createRoomRequest = newCreateRoomRequest(
    'http://example.com/',
    'API KEY',
    'testRoomID',
  );

  // Send 10 requests in parallel.
  const requests = Array(10)
    .fill(0)
    .map(() => roomDO.fetch(createRoomRequest));
  const responses = await Promise.all(requests);
  for (const response of responses) {
    expect(response.status).toBe(200);
  }

  // The roomHandler should have been run exactly once.
  expect(await getVersion(storage)).toBe(startingVersion + 1);
  expect(await getUserValue('foo', storage)).toEqual({
    version: startingVersion,
    deleted: false,
    value: 'bar+',
  });
});

test('failing roomHandler results in request error', async () => {
  const testLogSink = new TestLogSink();
  const roomDO = new BaseRoomDO({
    mutators: {},
    roomStartHandler: () => Promise.reject('room start failed'),
    disconnectHandler: () => Promise.resolve(),
    state: await createTestDurableObjectState('test-do-id'),
    authApiKey: 'API KEY',
    logSink: testLogSink,
    logLevel: 'info',
    allowUnconfirmedWrites: true,
  });

  const createRoomRequest = newCreateRoomRequest(
    'http://example.com/',
    'API KEY',
    'testRoomID',
  );

  const response = await roomDO.fetch(createRoomRequest);
  expect(response.status).toBe(500);
});

test('deleteAllData deletes all data', async () => {
  const testLogSink = new TestLogSink();
  const state = await createTestDurableObjectState('test-do-id');
  const someKey = 'foo';
  await state.storage.put(someKey, 'bar');
  expect(await (await state.storage.list()).size).toBeGreaterThan(0);

  const roomDO = new BaseRoomDO({
    mutators: {},
    roomStartHandler: () => Promise.resolve(),
    disconnectHandler: () => Promise.resolve(),
    state,
    authApiKey: 'API KEY',
    logSink: testLogSink,
    logLevel: 'info',
    allowUnconfirmedWrites: true,
  });
  const createRoomRequest = newCreateRoomRequest(
    'http://example.com/',
    'API KEY',
    'testRoomID',
  );
  const createResponse = await roomDO.fetch(createRoomRequest);
  expect(createResponse.status).toBe(200);

  const deleteRequest = newDeleteRoomRequest(
    'http://example.com/',
    'API KEY',
    'testRoomID',
  );
  const response = await roomDO.fetch(deleteRequest);
  expect(response.status).toBe(200);
  const gotValue = await state.storage.get(someKey);
  expect(gotValue).toBeUndefined();
  expect(await (await state.storage.list()).size).toEqual(
    1 /* deleted record */,
  );
});

test('after deleteAllData the roomDO just 410s', async () => {
  const testLogSink = new TestLogSink();

  const roomDO = new BaseRoomDO({
    mutators: {},
    roomStartHandler: () => Promise.resolve(),
    disconnectHandler: () => Promise.resolve(),
    state: await createTestDurableObjectState('test-do-id'),
    authApiKey: 'API KEY',
    logSink: testLogSink,
    logLevel: 'info',
    allowUnconfirmedWrites: true,
  });
  const createRoomRequest = newCreateRoomRequest(
    'http://example.com/',
    'API KEY',
    'testRoomID',
  );
  const createResponse = await roomDO.fetch(createRoomRequest);
  expect(createResponse.status).toBe(200);

  const deleteRequest = newDeleteRoomRequest(
    'http://example.com/',
    'API KEY',
    'testRoomID',
  );
  const response = await roomDO.fetch(deleteRequest);
  expect(response.status).toBe(200);

  const response2 = await roomDO.fetch(createRoomRequest);
  expect(response2.status).toBe(410);
  const response3 = await roomDO.fetch(deleteRequest);
  expect(response3.status).toBe(410);
  const response4 = await roomDO.fetch(new Request('http://example.com/'));
  expect(response4.status).toBe(410);
});

test('401s if wrong auth api key', async () => {
  const wrongApiKey = 'WRONG KEY';
  const deleteRequest = newDeleteRoomRequest(
    'http://example.com/',
    wrongApiKey,
    'testRoomID',
  );

  const invalidateAllRequest = newInvalidateAllAuthRequest(
    'http://example.com/',
    wrongApiKey,
  );

  const authConnectionsRequest = newAuthConnectionsRequest(
    'http://example.com/',
    wrongApiKey,
  );

  const invalidateForUserRequest = newInvalidateForUserAuthRequest(
    'http://example.com/',
    wrongApiKey,
    'testUserID',
  );

  const invalidateForRoomRequest = newInvalidateForRoomAuthRequest(
    'http://example.com/',
    wrongApiKey,
    'testRoomID',
  );

  const createRoomRequest = newCreateRoomRequest(
    'http://example.com/',
    wrongApiKey,
    'testRoomID',
  );

  const testRequests = [
    deleteRequest,
    invalidateAllRequest,
    invalidateForUserRequest,
    invalidateForRoomRequest,
    authConnectionsRequest,
    createRoomRequest,
  ];

  for (const testRequest of testRequests) {
    const testLogSink = new TestLogSink();

    const roomDO = new BaseRoomDO({
      mutators: {},
      roomStartHandler: () => Promise.resolve(),
      disconnectHandler: () => Promise.resolve(),
      state: await createTestDurableObjectState('test-do-id'),
      authApiKey: 'API KEY',
      logSink: testLogSink,
      logLevel: 'info',
      allowUnconfirmedWrites: true,
    });

    const response = await roomDO.fetch(testRequest);
    expect(response.status).toBe(401);
  }
});

test('Logs version during construction', async () => {
  const testLogSink = new TestLogSink();
  new BaseRoomDO({
    mutators: {},
    roomStartHandler: () => Promise.resolve(),
    disconnectHandler: () => Promise.resolve(),
    state: await createTestDurableObjectState('test-do-id'),
    authApiKey: 'foo',
    logSink: testLogSink,
    logLevel: 'info',
    allowUnconfirmedWrites: true,
  });
  expect(testLogSink.messages).toEqual(
    expect.arrayContaining([
      ['info', 'RoomDO', 'doID=test-do-id', 'Starting server'],
      ['info', 'RoomDO', 'doID=test-do-id', 'Version:', version],
    ]),
  );
  expect(testLogSink.messages[1][4]).toMatch(/^\d+\.\d+\.\d+/);
});

test('Sets turn duration based on allowUnconfirmedWrites flag', async () => {
  const cases: {allowUnconfirmed: boolean; turnDuration: number}[] = [
    {allowUnconfirmed: true, turnDuration: 1000 / 60},
    {allowUnconfirmed: false, turnDuration: 1000 / 15},
  ];
  for (const {allowUnconfirmed, turnDuration} of cases) {
    const testLogSink = new TestLogSink();

    const room = new BaseRoomDO({
      mutators: {},
      roomStartHandler: () => Promise.resolve(),
      disconnectHandler: () => Promise.resolve(),
      state: await createTestDurableObjectState('test-do-id'),
      authApiKey: 'foo',
      logSink: testLogSink,
      logLevel: 'info',
      allowUnconfirmedWrites: allowUnconfirmed,
    });

    // @ts-expect-error: private field
    expect(room._turnDuration).toEqual(turnDuration);
  }
});

test('good, bad, invalid connect requests', async () => {
  const goodRequest = new Request('ws://test.roci.dev/connect');
  goodRequest.headers.set('Upgrade', 'websocket');
  const goodTest = {
    request: goodRequest,
    expectedStatus: 101,
    expectedText: '',
  };

  const nonWebSocketTest = {
    request: new Request('ws://test.roci.dev/connect'),
    expectedStatus: 400,
    expectedText: 'expected websocket',
  };

  const badRequestTest = {
    request: new Request('ws://test.roci.dev/connect', {method: 'POST'}),
    expectedStatus: 405,
    expectedText: 'unsupported method',
  };

  const testLogSink = new TestLogSink();
  const state = await createTestDurableObjectState('test-do-id');
  const roomDO = new BaseRoomDO({
    mutators: {},
    roomStartHandler: () => Promise.resolve(),
    disconnectHandler: () => Promise.resolve(),
    state,
    authApiKey: 'API KEY',
    logSink: testLogSink,
    logLevel: 'info',
    allowUnconfirmedWrites: true,
  });
  for (const test of [goodTest, nonWebSocketTest, badRequestTest]) {
    const response = await roomDO.fetch(test.request);
    expect(await response.text()).toEqual(test.expectedText);
    expect(response.status).toBe(test.expectedStatus);
  }
});

/*
import { ClientID, ClientMap, Socket } from "../../src/types/client-state";
import { Mocket } from "../util/test-utils";
import { sleep } from "../../src/util/sleep";
import { Server } from "../../src/server/server";
import { MessageHandler, CloseHandler } from "../../src/server/connect";
test("serialization", async () => {
  const s1 = new Mocket();
  const url = "u1";
  const clients: ClientMap = new Map();
  const roomID = "r1";
  const clientID = "c1";
  const data = "data";

  const log: string[] = [];

  const messageHandler = (
    pClients: ClientMap,
    pClientID: ClientID,
    pData: string,
    pWS: Socket
  ) => {
    log.push("> message");
    expect(pClients).toEqual(clients);
    expect(pClientID).toEqual(clientID);
    expect(pData).toEqual(data);
    expect(pWS).toEqual(s1);
    log.push("< message");
  };

  const closeHandler = (
    pRooms: RoomMap,
    pRoomID: RoomID,
    pClientID: ClientID
  ) => {
    log.push("> close");
    expect(pRooms).toEqual(rooms);
    expect(pRoomID).toEqual(roomID);
    expect(pClientID).toEqual(clientID);
    log.push("< close");
  };

  const connectHandler = async (
    pWS: Socket,
    pURL: string,
    pRooms: RoomMap,
    onMessage: MessageHandler,
    onClose: CloseHandler
  ): Promise<void> => {
    expect(pWS).toEqual(s1);
    expect(pURL).toEqual(url);
    expect(pRooms).deep.toEqual(rooms);
    log.push("> connect");
    onMessage(roomID, clientID, data, pWS);
    onClose(roomID, clientID);
    await sleep(10);
    onMessage(roomID, clientID, data, pWS);
    onClose(roomID, clientID);
    log.push("< connect");
  };

  const server = new Server(
    rooms,
    () => {},
    () => 42,
    () => {}
  );
  server.handleConnection(s1, url);
  server.handleConnection(s1, url);
  await sleep(50);
  expect(log).deep.toEqual([
    "> connect",
    "< connect",
    "> connect",
    "< connect",
    "> message",
    "< message",
    "> close",
    "< close",
    "> message",
    "< message",
    "> close",
    "< close",
    "> message",
    "< message",
    "> close",
    "< close",
    "> message",
    "< message",
    "> close",
    "< close",
  ]);
});
*/
