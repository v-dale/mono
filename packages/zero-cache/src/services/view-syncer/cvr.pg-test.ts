import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {unreachable} from '../../../../shared/src/asserts.js';
import {createSilentLogContext} from '../../../../shared/src/logging-test-utils.js';
import {testDBs} from '../../test/db.js';
import type {PostgresDB} from '../../types/pg.js';
import type {PatchToVersion} from './client-handler.js';
import {
  ConcurrentModificationException,
  CVRStore,
  OwnershipError,
} from './cvr-store.js';
import {
  CVRConfigDrivenUpdater,
  CVRQueryDrivenUpdater,
  type CVRSnapshot,
  CVRUpdater,
} from './cvr.js';
import {
  type ClientsRow,
  compareClientsRows,
  compareDesiresRows,
  compareInstancesRows,
  compareQueriesRows,
  compareRowsRows,
  type DesiresRow,
  type InstancesRow,
  type QueriesRow,
  type RowsRow,
  type RowsVersionRow,
  setupCVRTables,
} from './schema/cvr.js';
import type {CVRVersion, RowID} from './schema/types.js';

const SHARD_ID = 'jkl';

const LAST_CONNECT = Date.UTC(2024, 2, 1);

describe('view-syncer/cvr', () => {
  type DBState = {
    instances: (Partial<InstancesRow> &
      Pick<InstancesRow, 'clientGroupID' | 'version'>)[];
    clients: ClientsRow[];
    queries: QueriesRow[];
    desires: DesiresRow[];
    rows: RowsRow[];
    rowsVersion?: RowsVersionRow[];
  };

  function setInitialState(
    db: PostgresDB,
    state: Partial<DBState>,
  ): Promise<void> {
    return db.begin(async tx => {
      const {instances, rowsVersion} = state;
      if (instances && !rowsVersion) {
        state = {
          ...state,
          rowsVersion: instances.map(({clientGroupID, version}) => ({
            clientGroupID,
            version,
          })),
        };
      }
      for (const [table, rows] of Object.entries(state)) {
        for (const row of rows) {
          await tx`INSERT INTO ${tx('cvr.' + table)} ${tx(row)}`;
        }
      }
    });
  }

  async function expectState(db: PostgresDB, state: Partial<DBState>) {
    for (const table of Object.keys(state)) {
      const res = [...(await db`SELECT * FROM ${db('cvr.' + table)}`)];
      const tableState = [...(state[table as keyof DBState] || [])];
      switch (table) {
        case 'instances': {
          (res as InstancesRow[]).sort(compareInstancesRows);
          (tableState as InstancesRow[]).sort(compareInstancesRows);
          break;
        }
        case 'clients': {
          (res as ClientsRow[]).sort(compareClientsRows);
          (tableState as ClientsRow[]).sort(compareClientsRows);
          break;
        }
        case 'queries': {
          (res as QueriesRow[]).sort(compareQueriesRows);
          (tableState as QueriesRow[]).sort(compareQueriesRows);
          break;
        }
        case 'desires': {
          (res as DesiresRow[]).sort(compareDesiresRows);
          (tableState as DesiresRow[]).sort(compareDesiresRows);
          break;
        }
        case 'rows': {
          (res as RowsRow[]).sort(compareRowsRows);
          (tableState as RowsRow[]).sort(compareRowsRows);
          break;
        }
        default: {
          unreachable();
        }
      }
      expect(res).toEqual(tableState);
    }
  }

  async function getAllState(db: PostgresDB): Promise<DBState> {
    const [instances, clients, queries, desires, rows] = await Promise.all([
      db`SELECT * FROM ${db('cvr.instances')}`,
      db`SELECT * FROM ${db('cvr.clients')}`,
      db`SELECT * FROM ${db('cvr.queries')}`,
      db`SELECT * FROM ${db('cvr.desires')}`,
      db`SELECT * FROM ${db('cvr.rows')}`,
    ]);
    return {
      instances,
      clients,
      queries,
      desires,
      rows,
    } as unknown as DBState;
  }

  const lc = createSilentLogContext();
  let db: PostgresDB;

  const ON_FAILURE = (e: unknown) => {
    throw e;
  };

  beforeEach(async () => {
    db = await testDBs.create('cvr_test_db');
    await db.begin(tx => setupCVRTables(lc, tx));
  });

  afterEach(async () => {
    await testDBs.drop(db);
  });

  async function catchupRows(
    cvrStore: CVRStore,
    afterVersion: CVRVersion,
    upToCVR: CVRSnapshot,
    current: CVRVersion,
    excludeQueries: string[] = [],
  ) {
    const rows: RowsRow[] = [];
    for await (const batch of cvrStore.catchupRowPatches(
      lc,
      afterVersion,
      upToCVR,
      current,
      excludeQueries,
    )) {
      rows.push(...batch);
    }
    return rows;
  }

  test('load first time cvr', async () => {
    const pgStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);

    const cvr = await pgStore.load(lc, LAST_CONNECT);
    expect(cvr).toEqual({
      id: 'abc123',
      version: {stateVersion: '00'},
      lastActive: 0,
      replicaVersion: null,
      clients: {},
      queries: {},
    } satisfies CVRSnapshot);
    const flushed = (
      await new CVRUpdater(pgStore, cvr, cvr.replicaVersion).flush(
        lc,
        LAST_CONNECT,
        Date.UTC(2024, 3, 20),
      )
    ).cvr;

    expect(flushed).toEqual({
      ...cvr,
      lastActive: 1713571200000,
    } satisfies CVRSnapshot);

    // Verify round tripping.
    const pgStore2 = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const reloaded = await pgStore2.load(lc, LAST_CONNECT);
    expect(reloaded).toEqual(flushed);

    await expectState(db, {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '00',
          lastActive: 1713571200000,
          replicaVersion: null,
          owner: 'my-task',
          grantedAt: 1709251200000,
        },
      ],
      clients: [],
      queries: [],
      desires: [],
    });
  });

  // Relies on an async homing signal (with no explicit flush, so allow retries)
  test('load existing cvr', {retry: 3}, async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1a9:02',
          replicaVersion: '123',
          lastActive: Date.UTC(2024, 3, 23),
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          patchVersion: '1a9:01',
          deleted: false,
        },
      ],
      queries: [
        {
          clientGroupID: 'abc123',
          queryHash: 'oneHash',
          clientAST: {table: 'issues'},
          transformationHash: 'twoHash',
          transformationVersion: null,
          patchVersion: '1a9:02',
          internal: null,
          deleted: false,
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'oneHash',
          patchVersion: '1a9:01',
          deleted: false,
        },
      ],
      rows: [],
    };
    await setInitialState(db, initialState);

    const cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);

    const cvr = await cvrStore.load(lc, LAST_CONNECT);
    expect(cvr).toEqual({
      id: 'abc123',
      version: {stateVersion: '1a9', minorVersion: 2},
      replicaVersion: '123',
      lastActive: 1713830400000,
      clients: {
        fooClient: {
          id: 'fooClient',
          desiredQueryIDs: ['oneHash'],
          patchVersion: {stateVersion: '1a9', minorVersion: 1},
        },
      },
      queries: {
        ['oneHash']: {
          id: 'oneHash',
          ast: {table: 'issues'},
          transformationHash: 'twoHash',
          desiredBy: {fooClient: {stateVersion: '1a9', minorVersion: 1}},
          patchVersion: {stateVersion: '1a9', minorVersion: 2},
        },
      },
    } satisfies CVRSnapshot);

    await expectState(db, {
      ...initialState,
      instances: [
        {
          ...initialState.instances[0],
          owner: 'my-task',
          grantedAt: 1709251200000,
        },
      ],
    });
  });

  test('update active time', async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1a9:02',
          replicaVersion: '112',
          lastActive: Date.UTC(2024, 3, 23),
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          patchVersion: '1a9:01',
          deleted: false,
        },
      ],
      queries: [
        {
          clientGroupID: 'abc123',
          queryHash: 'oneHash',
          clientAST: {table: 'issues'},
          transformationHash: 'twoHash',
          transformationVersion: null,
          patchVersion: '1a9:02',
          internal: null,
          deleted: false,
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'oneHash',
          patchVersion: '1a9:01',
          deleted: false,
        },
      ],
      rows: [],
    };
    await setInitialState(db, initialState);

    const cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const cvr = await cvrStore.load(lc, LAST_CONNECT);
    const updater = new CVRUpdater(cvrStore, cvr, cvr.replicaVersion);

    const {cvr: updated, stats} = await updater.flush(
      lc,
      LAST_CONNECT,
      Date.UTC(2024, 3, 24),
    );
    expect(stats).toMatchInlineSnapshot(`
      {
        "clients": 0,
        "desires": 0,
        "instances": 1,
        "queries": 0,
        "rows": 0,
        "rowsDeferred": 0,
        "statements": 2,
      }
    `);

    expect(cvr).toEqual({
      id: 'abc123',
      version: {stateVersion: '1a9', minorVersion: 2},
      replicaVersion: '112',
      lastActive: 1713830400000,
      clients: {
        fooClient: {
          id: 'fooClient',
          desiredQueryIDs: ['oneHash'],
          patchVersion: {stateVersion: '1a9', minorVersion: 1},
        },
      },
      queries: {
        oneHash: {
          id: 'oneHash',
          ast: {table: 'issues'},
          transformationHash: 'twoHash',
          desiredBy: {fooClient: {stateVersion: '1a9', minorVersion: 1}},
          patchVersion: {stateVersion: '1a9', minorVersion: 2},
        },
      },
    } satisfies CVRSnapshot);

    expect(updated).toEqual({
      ...cvr,
      lastActive: 1713916800000,
    } satisfies CVRSnapshot);

    // Verify round tripping.
    const cvrStore2 = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const reloaded = await cvrStore2.load(lc, LAST_CONNECT);
    expect(reloaded).toEqual(updated);

    await expectState(db, {
      ...initialState,
      instances: [
        {
          ...initialState.instances[0],
          lastActive: Date.UTC(2024, 3, 24),
          owner: 'my-task',
          grantedAt: 1709251200000,
        },
      ],
    });
  });

  test('detects concurrent modification', async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1a9:02',
          replicaVersion: '100',
          lastActive: Date.UTC(2024, 3, 23),
        },
      ],
      clients: [],
      queries: [],
      desires: [],
      rows: [],
    };
    await setInitialState(db, initialState);

    const cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const cvr = await cvrStore.load(lc, LAST_CONNECT);
    const updater = new CVRUpdater(cvrStore, cvr, cvr.replicaVersion);

    // Simulate an external modification, incrementing the patch version.
    await db`UPDATE cvr.instances SET version = '1a9:03' WHERE "clientGroupID" = 'abc123'`;

    await expect(
      updater.flush(lc, LAST_CONNECT, Date.UTC(2024, 4, 19)),
    ).rejects.toThrow(ConcurrentModificationException);

    // The last active time should not have been modified.
    expect(
      await db`SELECT "lastActive" FROM cvr.instances WHERE "clientGroupID" = 'abc123'`,
    ).toEqual([{lastActive: Date.UTC(2024, 3, 23)}]);
  });

  test('detects ownership change', async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1a9:02',
          replicaVersion: '100',
          lastActive: Date.UTC(2024, 3, 23),
          owner: 'my-task',
          grantedAt: LAST_CONNECT,
        },
      ],
      clients: [],
      queries: [],
      desires: [],
      rows: [],
    };
    await setInitialState(db, initialState);

    const cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const cvr = await cvrStore.load(lc, LAST_CONNECT);
    const updater = new CVRUpdater(cvrStore, cvr, cvr.replicaVersion);

    // Simulate an ownership change.
    await db`
    UPDATE cvr.instances SET "owner"     = 'other-task', 
                             "grantedAt" = ${LAST_CONNECT + 1}
    WHERE "clientGroupID" = 'abc123'`;

    await expect(
      updater.flush(lc, LAST_CONNECT, Date.UTC(2024, 4, 19)),
    ).rejects.toThrow(OwnershipError);

    // The last active time should not have been modified.
    expect(
      await db`SELECT "lastActive" FROM cvr.instances WHERE "clientGroupID" = 'abc123'`,
    ).toEqual([{lastActive: Date.UTC(2024, 3, 23)}]);
  });

  test('update desired query set', async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1aa',
          replicaVersion: '101',
          lastActive: Date.UTC(2024, 3, 23),
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'dooClient',
          patchVersion: '1a8',
          deleted: false,
        },
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          patchVersion: '1a9:01',
          deleted: false,
        },
      ],
      queries: [
        {
          clientGroupID: 'abc123',
          queryHash: 'oneHash',
          clientAST: {table: 'issues'},
          transformationHash: 'twoHash',
          transformationVersion: null,
          patchVersion: '1a9:02',
          internal: null,
          deleted: false,
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'dooClient',
          queryHash: 'oneHash',
          patchVersion: '1a8',
          deleted: false,
        },
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'oneHash',
          patchVersion: '1a9:01',
          deleted: false,
        },
      ],
      rows: [],
    };
    await setInitialState(db, initialState);

    const cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const cvr = await cvrStore.load(lc, LAST_CONNECT);
    expect(cvr).toEqual({
      id: 'abc123',
      version: {stateVersion: '1aa'},
      replicaVersion: '101',
      lastActive: 1713830400000,
      clients: {
        dooClient: {
          id: 'dooClient',
          desiredQueryIDs: ['oneHash'],
          patchVersion: {stateVersion: '1a8'},
        },
        fooClient: {
          id: 'fooClient',
          desiredQueryIDs: ['oneHash'],
          patchVersion: {stateVersion: '1a9', minorVersion: 1},
        },
      },
      queries: {
        oneHash: {
          id: 'oneHash',
          ast: {table: 'issues'},
          transformationHash: 'twoHash',
          transformationVersion: undefined,
          desiredBy: {
            dooClient: {stateVersion: '1a8'},
            fooClient: {stateVersion: '1a9', minorVersion: 1},
          },
          patchVersion: {stateVersion: '1a9', minorVersion: 2},
        },
      },
    } satisfies CVRSnapshot);

    const updater = new CVRConfigDrivenUpdater(cvrStore, cvr, SHARD_ID);

    // This removes and adds desired queries to the existing fooClient.
    expect(updater.deleteDesiredQueries('fooClient', ['oneHash', 'twoHash']))
      .toMatchInlineSnapshot(`
        [
          {
            "patch": {
              "clientID": "fooClient",
              "id": "oneHash",
              "op": "del",
              "type": "query",
            },
            "toVersion": {
              "minorVersion": 1,
              "stateVersion": "1aa",
            },
          },
        ]
      `);

    expect(
      updater.putDesiredQueries('fooClient', {
        fourHash: {table: 'users'},
        threeHash: {table: 'comments'},
      }),
    ).toMatchInlineSnapshot(`
        [
          {
            "patch": {
              "ast": {
                "table": "users",
              },
              "clientID": "fooClient",
              "id": "fourHash",
              "op": "put",
              "type": "query",
            },
            "toVersion": {
              "minorVersion": 1,
              "stateVersion": "1aa",
            },
          },
          {
            "patch": {
              "ast": {
                "table": "comments",
              },
              "clientID": "fooClient",
              "id": "threeHash",
              "op": "put",
              "type": "query",
            },
            "toVersion": {
              "minorVersion": 1,
              "stateVersion": "1aa",
            },
          },
        ]
      `);

    // This adds a new barClient with desired queries.
    expect(
      updater.putDesiredQueries('barClient', {
        oneHash: {table: 'issues'},
        threeHash: {table: 'comments'},
      }),
    ).toMatchInlineSnapshot(`
          [
            {
              "patch": {
                "id": "barClient",
                "op": "put",
                "type": "client",
              },
              "toVersion": {
                "minorVersion": 1,
                "stateVersion": "1aa",
              },
            },
            {
              "patch": {
                "ast": {
                  "table": "issues",
                },
                "clientID": "barClient",
                "id": "oneHash",
                "op": "put",
                "type": "query",
              },
              "toVersion": {
                "minorVersion": 1,
                "stateVersion": "1aa",
              },
            },
            {
              "patch": {
                "ast": {
                  "table": "comments",
                },
                "clientID": "barClient",
                "id": "threeHash",
                "op": "put",
                "type": "query",
              },
              "toVersion": {
                "minorVersion": 1,
                "stateVersion": "1aa",
              },
            },
          ]
        `);

    // Adds a new client with no desired queries.
    expect(updater.putDesiredQueries('bonkClient', {})).toMatchInlineSnapshot(
      `
                [
                  {
                    "patch": {
                      "id": "bonkClient",
                      "op": "put",
                      "type": "client",
                    },
                    "toVersion": {
                      "minorVersion": 1,
                      "stateVersion": "1aa",
                    },
                  },
                ]
              `,
    );
    expect(updater.clearDesiredQueries('dooClient')).toMatchInlineSnapshot(`
                  [
                    {
                      "patch": {
                        "clientID": "dooClient",
                        "id": "oneHash",
                        "op": "del",
                        "type": "query",
                      },
                      "toVersion": {
                        "minorVersion": 1,
                        "stateVersion": "1aa",
                      },
                    },
                  ]
                `);

    const {cvr: updated, stats} = await updater.flush(
      lc,
      LAST_CONNECT,
      Date.UTC(2024, 3, 24),
    );

    expect(stats).toMatchInlineSnapshot(`
      {
        "clients": 4,
        "desires": 6,
        "instances": 2,
        "queries": 7,
        "rows": 0,
        "rowsDeferred": 0,
        "statements": 20,
      }
    `);
    expect(updated).toEqual({
      id: 'abc123',
      version: {stateVersion: '1aa', minorVersion: 1}, // minorVersion bump
      replicaVersion: '101',
      lastActive: 1713916800000,
      clients: {
        barClient: {
          id: 'barClient',
          desiredQueryIDs: ['oneHash', 'threeHash'],
          patchVersion: {stateVersion: '1aa', minorVersion: 1},
        },
        bonkClient: {
          id: 'bonkClient',
          desiredQueryIDs: [],
          patchVersion: {stateVersion: '1aa', minorVersion: 1},
        },
        dooClient: {
          desiredQueryIDs: [],
          id: 'dooClient',
          patchVersion: {stateVersion: '1a8'},
        },
        fooClient: {
          id: 'fooClient',
          desiredQueryIDs: ['fourHash', 'threeHash'],
          patchVersion: {stateVersion: '1a9', minorVersion: 1},
        },
      },
      queries: {
        lmids: {
          id: 'lmids',
          internal: true,
          ast: {
            table: `zero_${SHARD_ID}.clients`,
            schema: '',
            where: {
              type: 'simple',
              op: '=',
              left: {
                type: 'column',
                name: 'clientGroupID',
              },
              right: {
                type: 'literal',
                value: 'abc123',
              },
            },
            orderBy: [
              ['clientGroupID', 'asc'],
              ['clientID', 'asc'],
            ],
          },
        },
        oneHash: {
          id: 'oneHash',
          ast: {table: 'issues'},
          transformationHash: 'twoHash',
          transformationVersion: undefined,
          desiredBy: {barClient: {stateVersion: '1aa', minorVersion: 1}},
          patchVersion: {stateVersion: '1a9', minorVersion: 2},
        },
        threeHash: {
          id: 'threeHash',
          ast: {table: 'comments'},
          desiredBy: {
            barClient: {stateVersion: '1aa', minorVersion: 1},
            fooClient: {stateVersion: '1aa', minorVersion: 1},
          },
        },
        fourHash: {
          id: 'fourHash',
          ast: {table: 'users'},
          desiredBy: {fooClient: {stateVersion: '1aa', minorVersion: 1}},
        },
      },
    } satisfies CVRSnapshot);

    await expectState(db, {
      instances: [
        {
          clientGroupID: 'abc123',
          lastActive: new Date('2024-04-24T00:00:00.000Z').getTime(),
          version: '1aa:01',
          replicaVersion: '101',
          owner: 'my-task',
          grantedAt: 1709251200000,
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          deleted: false,
          patchVersion: '1a9:01',
        },
        {
          clientGroupID: 'abc123',
          clientID: 'barClient',
          deleted: false,
          patchVersion: '1aa:01',
        },
        {
          clientGroupID: 'abc123',
          clientID: 'bonkClient',
          deleted: false,
          patchVersion: '1aa:01',
        },
        {
          clientGroupID: 'abc123',
          clientID: 'dooClient',
          deleted: false,
          patchVersion: '1a8',
        },
      ],
      queries: [
        {
          clientAST: {
            table: 'users',
          },
          clientGroupID: 'abc123',
          deleted: false,
          internal: null,
          patchVersion: null,
          queryHash: 'fourHash',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            schema: '',
            table: `zero_${SHARD_ID}.clients`,
            where: {
              left: {
                type: 'column',
                name: 'clientGroupID',
              },
              op: '=',
              type: 'simple',
              right: {
                type: 'literal',
                value: 'abc123',
              },
            },
            orderBy: [
              ['clientGroupID', 'asc'],
              ['clientID', 'asc'],
            ],
          },
          clientGroupID: 'abc123',
          deleted: false,
          internal: true,
          patchVersion: null,
          queryHash: 'lmids',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            table: 'comments',
          },
          clientGroupID: 'abc123',
          deleted: false,
          internal: null,
          patchVersion: null,
          queryHash: 'threeHash',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: false,
          internal: null,
          patchVersion: '1a9:02',
          queryHash: 'oneHash',
          transformationHash: 'twoHash',
          transformationVersion: null,
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          deleted: true,
          patchVersion: '1aa:01',
          queryHash: 'oneHash',
        },
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          deleted: false,
          patchVersion: '1aa:01',
          queryHash: 'fourHash',
        },
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          deleted: false,
          patchVersion: '1aa:01',
          queryHash: 'threeHash',
        },
        {
          clientGroupID: 'abc123',
          clientID: 'barClient',
          deleted: false,
          patchVersion: '1aa:01',
          queryHash: 'oneHash',
        },
        {
          clientGroupID: 'abc123',
          clientID: 'barClient',
          deleted: false,
          patchVersion: '1aa:01',
          queryHash: 'threeHash',
        },
        {
          clientGroupID: 'abc123',
          clientID: 'dooClient',
          deleted: true,
          patchVersion: '1aa:01',
          queryHash: 'oneHash',
        },
      ],

      //  rows: [],
    });

    // Verify round tripping.
    const cvrStore2 = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const reloaded = await cvrStore2.load(lc, LAST_CONNECT);
    expect(reloaded).toEqual(updated);

    // Add the deleted desired query back. This ensures that the
    // desired query update statement is an UPSERT.
    const updater2 = new CVRConfigDrivenUpdater(cvrStore2, reloaded, SHARD_ID);
    expect(
      updater2.putDesiredQueries('fooClient', {
        oneHash: {table: 'issues'},
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "clientID": "fooClient",
            "id": "oneHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 2,
            "stateVersion": "1aa",
          },
        },
      ]
    `);

    const {cvr: updated2} = await updater2.flush(
      lc,
      LAST_CONNECT,
      Date.UTC(2024, 3, 24, 1),
    );
    expect(updated2.clients.fooClient.desiredQueryIDs).toContain('oneHash');
  });

  test('no-op change to desired query set', async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1aa',
          replicaVersion: '03',
          lastActive: Date.UTC(2024, 3, 23),
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          patchVersion: '1a9:01',
          deleted: false,
        },
      ],
      queries: [
        {
          clientGroupID: 'abc123',
          queryHash: 'oneHash',
          clientAST: {table: 'issues'},
          transformationHash: 'twoHash',
          transformationVersion: null,
          patchVersion: '1a9:02',
          deleted: false,
          internal: null,
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'oneHash',
          patchVersion: '1a9:01',
          deleted: false,
        },
      ],
      rows: [],
    };
    await setInitialState(db, initialState);

    const cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const cvr = await cvrStore.load(lc, LAST_CONNECT);
    const updater = new CVRConfigDrivenUpdater(cvrStore, cvr, SHARD_ID);

    // Same desired query set. Nothing should change except last active time.
    expect(
      updater.putDesiredQueries('fooClient', {oneHash: {table: 'issues'}}),
    ).toMatchInlineSnapshot(`[]`);

    // Same last active day (no index change), but different hour.
    const {cvr: updated, stats} = await updater.flush(
      lc,
      LAST_CONNECT,
      Date.UTC(2024, 3, 23, 1),
    );
    expect(stats).toMatchInlineSnapshot(`
      {
        "clients": 0,
        "desires": 0,
        "instances": 1,
        "queries": 0,
        "rows": 0,
        "rowsDeferred": 0,
        "statements": 2,
      }
    `);

    expect(updated).toEqual({
      ...cvr,
      lastActive: 1713834000000,
    } satisfies CVRSnapshot);

    // Verify round tripping.
    const doCVRStore2 = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const reloaded = await doCVRStore2.load(lc, LAST_CONNECT);
    expect(reloaded).toEqual(updated);

    await expectState(db, {
      ...initialState,
      instances: [
        {
          ...initialState.instances[0],
          lastActive: Date.UTC(2024, 3, 23, 1),
          owner: 'my-task',
          grantedAt: 1709251200000,
        },
      ],
    });
  });

  const ROW_KEY1 = {id: '123'};
  const ROW_ID1: RowID = {
    schema: 'public',
    table: 'issues',
    rowKey: ROW_KEY1,
  };

  const ROW_KEY2 = {id: '321'};
  const ROW_ID2: RowID = {
    schema: 'public',
    table: 'issues',
    rowKey: ROW_KEY2,
  };

  const ROW_KEY3 = {id: '888'};
  const ROW_ID3: RowID = {
    schema: 'public',
    table: 'issues',
    rowKey: ROW_KEY3,
  };

  const DELETE_ROW_KEY = {id: '456'};

  const IN_OLD_PATCH_ROW_KEY = {id: '777'};

  test('desired to got', async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1aa',
          replicaVersion: null,
          lastActive: Date.UTC(2024, 3, 23),
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      queries: [
        {
          clientGroupID: 'abc123',
          queryHash: 'oneHash',
          clientAST: {table: 'issues'},
          transformationHash: null,
          transformationVersion: null,
          patchVersion: null,
          internal: null,
          deleted: null,
        },
        {
          clientGroupID: 'abc123',
          queryHash: 'already-deleted',
          clientAST: {table: 'issues'}, // TODO(arv): Maybe nullable
          patchVersion: '189',
          transformationHash: null,
          transformationVersion: null,
          internal: null,
          deleted: true, // Already in CVRs from "189"
        },
        {
          clientGroupID: 'abc123',
          queryHash: 'catchup-delete',
          clientAST: {table: 'issues'}, // TODO(arv): Maybe nullable
          patchVersion: '19z',
          transformationHash: null,
          transformationVersion: null,
          internal: null,
          deleted: true,
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'oneHash',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      rows: [
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY1,
          rowVersion: '03',
          refCounts: {twoHash: 1},
          patchVersion: '1a0',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY2,
          rowVersion: '03',
          refCounts: {twoHash: 1},
          patchVersion: '1a0',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY3,
          rowVersion: '03',
          refCounts: null,
          patchVersion: '19z',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: IN_OLD_PATCH_ROW_KEY,
          rowVersion: '03',
          refCounts: null,
          patchVersion: '189',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: DELETE_ROW_KEY,
          rowVersion: '03',
          refCounts: null,
          patchVersion: '1aa',
          schema: 'public',
          table: 'issues',
        },
      ],
    };

    await setInitialState(db, initialState);

    const cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const cvr = await cvrStore.load(lc, LAST_CONNECT);
    const updater = new CVRQueryDrivenUpdater(cvrStore, cvr, '1aa', '123');

    const {newVersion, queryPatches} = updater.trackQueries(
      lc,
      [{id: 'oneHash', transformationHash: 'serverOneHash'}],
      [],
    );
    expect(newVersion).toEqual({stateVersion: '1aa', minorVersion: 1});
    expect(queryPatches).toMatchInlineSnapshot(`
      [
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "id": "oneHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1aa",
          },
        },
      ]
    `);

    // Simulate receiving different views rows at different time times.
    expect(
      await updater.received(
        lc,
        new Map([
          [
            ROW_ID1,
            {
              version: '03',
              refCounts: {oneHash: 1},
              contents: {id: 'should-show-up-in-patch'},
            },
          ],
        ]),
      ),
    ).toEqual([
      {
        toVersion: {stateVersion: '1a0'},
        patch: {
          type: 'row',
          op: 'put',
          id: ROW_ID1,
          contents: {id: 'should-show-up-in-patch'},
        },
      },
    ] satisfies PatchToVersion[]);
    expect(
      await updater.received(
        lc,
        new Map([
          [
            ROW_ID2,
            {
              version: '03',
              refCounts: {oneHash: 1},
              contents: {id: 'same column selection as twoHash'},
            },
          ],
          [
            ROW_ID3,
            {
              version: '09',
              refCounts: {oneHash: 1},
              contents: {id: 'new version patch'},
            },
          ],
        ]),
      ),
    ).toEqual([
      {
        toVersion: {stateVersion: '1a0'},
        patch: {
          type: 'row',
          op: 'put',
          id: ROW_ID2,
          contents: {id: 'same column selection as twoHash'},
        },
      },
      {
        toVersion: {stateVersion: '1aa', minorVersion: 1},
        patch: {
          type: 'row',
          op: 'put',
          id: ROW_ID3,
          contents: {id: 'new version patch'},
        },
      },
    ] satisfies PatchToVersion[]);
    expect(
      await updater.received(
        lc,
        new Map([
          [
            ROW_ID1,
            {
              version: '03',
              refCounts: {oneHash: 1},
              contents: {id: 'should-show-up-in-patch'},
            },
          ],
        ]),
      ),
    ).toEqual([
      {
        toVersion: {stateVersion: '1a0'},
        patch: {
          type: 'row',
          op: 'put',
          id: ROW_ID1,
          contents: {id: 'should-show-up-in-patch'},
        },
      },
    ] satisfies PatchToVersion[]);

    expect(await updater.deleteUnreferencedRows()).toEqual([]);

    // Same last active day (no index change), but different hour.
    const {cvr: updated, stats} = await updater.flush(
      lc,
      LAST_CONNECT,
      Date.UTC(2024, 3, 23, 1),
    );
    expect(stats).toMatchInlineSnapshot(`
        {
          "clients": 0,
          "desires": 0,
          "instances": 2,
          "queries": 1,
          "rows": 3,
          "rowsDeferred": 0,
          "statements": 5,
        }
      `);

    expect(
      await cvrStore.catchupConfigPatches(
        lc,
        {stateVersion: '189'},
        cvr,
        updated.version,
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "patch": {
            "id": "catchup-delete",
            "op": "del",
            "type": "query",
          },
          "toVersion": {
            "stateVersion": "19z",
          },
        },
        {
          "patch": {
            "id": "fooClient",
            "op": "put",
            "type": "client",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1a9",
          },
        },
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "clientID": "fooClient",
            "id": "oneHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1a9",
          },
        },
      ]
    `);

    expect(
      await catchupRows(cvrStore, {stateVersion: '189'}, cvr, updated.version, [
        'oneHash',
      ]),
    ).toMatchInlineSnapshot(`
      [
        {
          "clientGroupID": "abc123",
          "patchVersion": "1aa",
          "refCounts": null,
          "rowKey": {
            "id": "456",
          },
          "rowVersion": "03",
          "schema": "public",
          "table": "issues",
        },
      ]
    `);

    expect(updated).toEqual({
      ...cvr,
      replicaVersion: '123',
      version: newVersion,
      queries: {
        oneHash: {
          id: 'oneHash',
          ast: {table: 'issues'},
          desiredBy: {fooClient: {stateVersion: '1a9', minorVersion: 1}},
          transformationHash: 'serverOneHash',
          transformationVersion: {stateVersion: '1aa', minorVersion: 1},
          patchVersion: {stateVersion: '1aa', minorVersion: 1},
        },
      },
      lastActive: 1713834000000,
    } satisfies CVRSnapshot);

    // Verify round tripping.
    const cvrStore2 = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const reloaded = await cvrStore2.load(lc, LAST_CONNECT);
    expect(reloaded).toEqual(updated);

    await expectState(db, {
      instances: [
        {
          clientGroupID: 'abc123',
          lastActive: new Date('2024-04-23T01:00:00Z').getTime(),
          version: '1aa:01',
          replicaVersion: '123',
          owner: 'my-task',
          grantedAt: 1709251200000,
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          deleted: null,
          patchVersion: '1a9:01',
        },
      ],
      queries: [
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: true,
          internal: null,
          patchVersion: '189',
          queryHash: 'already-deleted',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: true,
          internal: null,
          patchVersion: '19z',
          queryHash: 'catchup-delete',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: false,
          internal: null,
          patchVersion: '1aa:01',
          queryHash: 'oneHash',
          transformationHash: 'serverOneHash',
          transformationVersion: '1aa:01',
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          deleted: null,
          patchVersion: '1a9:01',
          queryHash: 'oneHash',
        },
      ],
      rows: [
        {
          clientGroupID: 'abc123',
          patchVersion: '189',
          refCounts: null,
          rowKey: IN_OLD_PATCH_ROW_KEY,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1aa',
          refCounts: null,
          rowKey: DELETE_ROW_KEY,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1a0',
          refCounts: {
            oneHash: 1,
            twoHash: 1,
          },
          rowKey: ROW_KEY2,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1aa:01',
          refCounts: {
            oneHash: 1,
          },
          rowKey: ROW_KEY3,
          rowVersion: '09',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1a0',
          refCounts: {
            oneHash: 2,
            twoHash: 1,
          },
          rowKey: ROW_KEY1,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
      ],
    });
  });

  // ^^: just run this test twice? Once for executed once for transformed
  test('new transformation hash', async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1ba',
          replicaVersion: '123',
          lastActive: Date.UTC(2024, 3, 23),
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      queries: [
        {
          clientGroupID: 'abc123',
          queryHash: 'oneHash',
          clientAST: {table: 'issues'},
          transformationHash: 'serverOneHash',
          transformationVersion: '1aa',
          patchVersion: '1aa:01',
          internal: null,
          deleted: null,
        },
        {
          clientGroupID: 'abc123',
          queryHash: 'already-deleted',
          clientAST: {table: 'issues'}, // TODO(arv): Maybe nullable
          patchVersion: '189',
          transformationHash: null,
          transformationVersion: null,
          internal: null,
          deleted: true, // Already in CVRs from "189"
        },
        {
          clientGroupID: 'abc123',
          queryHash: 'catchup-delete',
          clientAST: {table: 'issues'}, // TODO(arv): Maybe nullable
          patchVersion: '19z',
          transformationHash: null,
          transformationVersion: null,
          internal: null,
          deleted: true,
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'oneHash',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      rows: [
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY1,
          rowVersion: '03',
          refCounts: {
            oneHash: 1,
            twoHash: 1,
          },
          patchVersion: '1aa:01',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY2,
          rowVersion: '03',
          refCounts: {twoHash: 1},
          patchVersion: '1a0',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY3,
          rowVersion: '09',
          refCounts: {oneHash: 1},
          patchVersion: '1aa:01',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: IN_OLD_PATCH_ROW_KEY,
          rowVersion: '03',
          refCounts: null,
          patchVersion: '189',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: DELETE_ROW_KEY,
          rowVersion: '03',
          refCounts: null,
          patchVersion: '1ba',
          schema: 'public',
          table: 'issues',
        },
      ],
    };
    await setInitialState(db, initialState);

    let cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    let cvr = await cvrStore.load(lc, LAST_CONNECT);
    let updater = new CVRQueryDrivenUpdater(cvrStore, cvr, '1ba', '123');

    let {newVersion, queryPatches} = updater.trackQueries(
      lc,
      [{id: 'oneHash', transformationHash: 'serverTwoHash'}],
      [],
    );
    expect(newVersion).toEqual({stateVersion: '1ba', minorVersion: 1});
    expect(queryPatches).toHaveLength(0);

    expect(
      await updater.received(
        lc,
        new Map([
          [
            ROW_ID1,
            {
              version: '03',
              refCounts: {oneHash: 1},
              contents: {id: 'existing patch'},
            },
          ],
        ]),
      ),
    ).toEqual([
      {
        toVersion: {stateVersion: '1aa', minorVersion: 1},
        patch: {
          type: 'row',
          op: 'put',
          id: ROW_ID1,
          contents: {id: 'existing patch'},
        },
      },
    ] satisfies PatchToVersion[]);

    expect(updater.updatedVersion()).toEqual({
      stateVersion: '1ba',
      minorVersion: 1,
    });

    expect(
      await updater.received(
        lc,
        new Map([
          [
            // Now referencing ROW_ID2 instead of ROW_ID3
            ROW_ID2,
            {
              version: '09',
              refCounts: {oneHash: 1},
              contents: {id: 'new-row-version-should-bump-cvr-version'},
            },
          ],
        ]),
      ),
    ).toEqual([
      {
        toVersion: {stateVersion: '1ba', minorVersion: 1},
        patch: {
          type: 'row',
          op: 'put',
          id: ROW_ID2,
          contents: {id: 'new-row-version-should-bump-cvr-version'},
        },
      },
    ]);

    expect(await updater.deleteUnreferencedRows()).toEqual([
      {
        patch: {type: 'row', op: 'del', id: ROW_ID3},
        toVersion: newVersion,
      },
    ] satisfies PatchToVersion[]);

    // Same last active day (no index change), but different hour.
    let {cvr: updated, stats} = await updater.flush(
      lc,
      LAST_CONNECT,
      Date.UTC(2024, 3, 23, 1),
    );
    expect(stats).toMatchInlineSnapshot(`
        {
          "clients": 0,
          "desires": 0,
          "instances": 2,
          "queries": 1,
          "rows": 2,
          "rowsDeferred": 0,
          "statements": 5,
        }
      `);

    expect(
      await cvrStore.catchupConfigPatches(
        lc,
        {stateVersion: '189'},
        cvr,
        updated.version,
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "id": "oneHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1aa",
          },
        },
        {
          "patch": {
            "id": "catchup-delete",
            "op": "del",
            "type": "query",
          },
          "toVersion": {
            "stateVersion": "19z",
          },
        },
        {
          "patch": {
            "id": "fooClient",
            "op": "put",
            "type": "client",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1a9",
          },
        },
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "clientID": "fooClient",
            "id": "oneHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1a9",
          },
        },
      ]
    `);

    expect(
      await catchupRows(cvrStore, {stateVersion: '189'}, cvr, updated.version, [
        'oneHash',
      ]),
    ).toMatchInlineSnapshot(`
      [
        {
          "clientGroupID": "abc123",
          "patchVersion": "1ba",
          "refCounts": null,
          "rowKey": {
            "id": "456",
          },
          "rowVersion": "03",
          "schema": "public",
          "table": "issues",
        },
      ]
    `);

    expect(updated).toEqual({
      ...cvr,
      version: newVersion,
      queries: {
        oneHash: {
          id: 'oneHash',
          ast: {table: 'issues'},
          desiredBy: {fooClient: {stateVersion: '1a9', minorVersion: 1}},
          transformationHash: 'serverTwoHash',
          transformationVersion: {stateVersion: '1ba', minorVersion: 1},
          patchVersion: {stateVersion: '1aa', minorVersion: 1},
        },
      },
      lastActive: 1713834000000,
    } satisfies CVRSnapshot);

    // Verify round tripping.
    cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    cvr = await cvrStore.load(lc, LAST_CONNECT);
    expect(cvr).toEqual(updated);

    expect(await getAllState(db)).toEqual({
      instances: [
        {
          clientGroupID: 'abc123',
          lastActive: new Date('2024-04-23T01:00:00Z').getTime(),
          version: '1ba:01',
          replicaVersion: '123',
          owner: 'my-task',
          grantedAt: 1709251200000,
        },
      ],
      clients: initialState.clients,
      queries: [
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: true,
          internal: null,
          patchVersion: '189',
          queryHash: 'already-deleted',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: true,
          internal: null,
          patchVersion: '19z',
          queryHash: 'catchup-delete',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: false,
          internal: null,
          patchVersion: '1aa:01',
          queryHash: 'oneHash',
          transformationHash: 'serverTwoHash',
          transformationVersion: '1ba:01',
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          deleted: null,
          patchVersion: '1a9:01',
          queryHash: 'oneHash',
        },
      ],
      rows: [
        {
          clientGroupID: 'abc123',
          patchVersion: '1aa:01',
          refCounts: {
            oneHash: 1,
            twoHash: 1,
          },
          rowKey: ROW_KEY1,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '189',
          refCounts: null,
          rowKey: IN_OLD_PATCH_ROW_KEY,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1ba',
          refCounts: null,
          rowKey: DELETE_ROW_KEY,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1ba:01',
          refCounts: {
            oneHash: 1,
            twoHash: 1,
          },
          rowKey: ROW_KEY2,
          rowVersion: '09',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1ba:01',
          refCounts: null,
          rowKey: ROW_KEY3,
          rowVersion: '09',
          schema: 'public',
          table: 'issues',
        },
      ],
    });

    updater = new CVRQueryDrivenUpdater(cvrStore, cvr, '1ba', '123');
    ({newVersion, queryPatches} = updater.trackQueries(
      lc,
      [{id: 'oneHash', transformationHash: 'newXFormHash'}],
      [],
    ));
    expect(newVersion).toEqual({stateVersion: '1ba', minorVersion: 2});
    expect(queryPatches).toHaveLength(0);

    ({cvr: updated, stats} = await updater.flush(
      lc,
      LAST_CONNECT,
      Date.UTC(2024, 3, 23, 2),
    ));
    expect(stats).toMatchInlineSnapshot(`
      {
        "clients": 0,
        "desires": 0,
        "instances": 2,
        "queries": 1,
        "rows": 0,
        "rowsDeferred": 0,
        "statements": 4,
      }
    `);

    const newState = await getAllState(db);
    expect({
      instances: newState.instances,
      clients: newState.clients,
      queries: newState.queries,
    }).toEqual({
      instances: [
        {
          clientGroupID: 'abc123',
          lastActive: new Date('2024-04-23T02:00:00Z').getTime(),
          version: '1ba:02',
          replicaVersion: '123',
          owner: 'my-task',
          grantedAt: 1709251200000,
        },
      ],
      clients: initialState.clients,
      queries: [
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: true,
          internal: null,
          patchVersion: '189',
          queryHash: 'already-deleted',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: true,
          internal: null,
          patchVersion: '19z',
          queryHash: 'catchup-delete',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: false,
          internal: null,
          patchVersion: '1aa:01',
          queryHash: 'oneHash',
          transformationHash: 'newXFormHash',
          transformationVersion: '1ba:02',
        },
      ],
    });
  });

  test('multiple executed queries', async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1ba',
          replicaVersion: '123',
          lastActive: Date.UTC(2024, 3, 23),
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      queries: [
        {
          clientGroupID: 'abc123',
          queryHash: 'oneHash',
          clientAST: {table: 'issues'},
          transformationHash: 'serverOneHash',
          transformationVersion: '1aa',
          patchVersion: '1aa:01',
          internal: null,
          deleted: null,
        },
        {
          clientGroupID: 'abc123',
          queryHash: 'twoHash',
          clientAST: {table: 'issues'},
          transformationHash: 'serverTwoHash',
          transformationVersion: '1aa',
          patchVersion: '1aa:01',
          internal: null,
          deleted: null,
        },
        {
          clientGroupID: 'abc123',
          queryHash: 'already-deleted',
          clientAST: {table: 'issues'},
          patchVersion: '189',
          transformationHash: null,
          transformationVersion: null,
          internal: null,
          deleted: true,
        },
        {
          clientGroupID: 'abc123',
          queryHash: 'catchup-delete',
          clientAST: {table: 'issues'},
          patchVersion: '19z',
          transformationHash: null,
          transformationVersion: null,
          internal: null,
          deleted: true,
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'oneHash',
          patchVersion: '1a9:01',
          deleted: null,
        },
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'twoHash',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      rows: [
        {
          clientGroupID: 'abc123',
          rowKey: IN_OLD_PATCH_ROW_KEY,
          rowVersion: '03',
          refCounts: null,
          patchVersion: '189',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: DELETE_ROW_KEY,
          rowVersion: '03',
          refCounts: null,
          patchVersion: '1ba',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY1,
          rowVersion: '03',
          refCounts: {
            oneHash: 1,
            twoHash: 1,
          },
          patchVersion: '1aa:01',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY2,
          rowVersion: '03',
          refCounts: {twoHash: 1},
          patchVersion: '1a0',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY3,
          rowVersion: '09',
          refCounts: {oneHash: 1},
          patchVersion: '1aa:01',
          schema: 'public',
          table: 'issues',
        },
      ],
    };

    await setInitialState(db, initialState);

    const cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const cvr = await cvrStore.load(lc, LAST_CONNECT);
    const updater = new CVRQueryDrivenUpdater(cvrStore, cvr, '1ba', '123');

    const {newVersion, queryPatches} = updater.trackQueries(
      lc,
      [
        {id: 'oneHash', transformationHash: 'updatedServerOneHash'},
        {id: 'twoHash', transformationHash: 'updatedServerTwoHash'},
      ],
      [],
    );
    expect(newVersion).toEqual({stateVersion: '1ba', minorVersion: 1});
    expect(queryPatches).toHaveLength(0);

    expect(
      await updater.received(
        lc,
        new Map([
          [
            ROW_ID1,
            {
              version: '03',
              refCounts: {oneHash: 1},
              contents: {id: 'existing-patch'},
            },
          ],
        ]),
      ),
    ).toEqual([
      {
        toVersion: {stateVersion: '1aa', minorVersion: 1},
        patch: {
          type: 'row',
          op: 'put',
          id: ROW_ID1,
          contents: {id: 'existing-patch'},
        },
      },
    ] satisfies PatchToVersion[]);
    expect(
      await updater.received(
        lc,
        new Map([
          [
            ROW_ID1,
            {
              version: '03',
              refCounts: {twoHash: 1},
              contents: {id: 'existing-patch'},
            },
          ],
        ]),
      ),
    ).toEqual([
      {
        toVersion: {stateVersion: '1aa', minorVersion: 1},
        patch: {
          type: 'row',
          op: 'put',
          id: ROW_ID1,
          contents: {id: 'existing-patch'},
        },
      },
    ] satisfies PatchToVersion[]);
    await updater.received(
      lc,
      new Map([
        [
          // Now referencing ROW_ID2 instead of ROW_ID3
          ROW_ID2,
          {
            version: '09',
            refCounts: {oneHash: 1},
            contents: {
              /* ignored */
            },
          },
        ],
      ]),
    );
    await updater.received(
      lc,
      new Map([
        [
          ROW_ID2,
          {
            version: '09',
            refCounts: {twoHash: 1},
            contents: {
              /* ignored */
            },
          },
        ],
      ]),
    );

    expect(await updater.deleteUnreferencedRows()).toEqual([
      {
        patch: {type: 'row', op: 'del', id: ROW_ID3},
        toVersion: newVersion,
      },
    ] satisfies PatchToVersion[]);

    // Same last active day (no index change), but different hour.
    const {cvr: updated, stats} = await updater.flush(
      lc,
      LAST_CONNECT,
      Date.UTC(2024, 3, 23, 1),
    );
    expect(stats).toMatchInlineSnapshot(`
      {
        "clients": 0,
        "desires": 0,
        "instances": 2,
        "queries": 2,
        "rows": 2,
        "rowsDeferred": 0,
        "statements": 6,
      }
    `);

    expect(
      await cvrStore.catchupConfigPatches(
        lc,
        {stateVersion: '189'},
        cvr,
        updated.version,
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "id": "oneHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1aa",
          },
        },
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "id": "twoHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1aa",
          },
        },
        {
          "patch": {
            "id": "catchup-delete",
            "op": "del",
            "type": "query",
          },
          "toVersion": {
            "stateVersion": "19z",
          },
        },
        {
          "patch": {
            "id": "fooClient",
            "op": "put",
            "type": "client",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1a9",
          },
        },
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "clientID": "fooClient",
            "id": "oneHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1a9",
          },
        },
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "clientID": "fooClient",
            "id": "twoHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1a9",
          },
        },
      ]
    `);

    expect(
      await catchupRows(cvrStore, {stateVersion: '189'}, cvr, updated.version, [
        'oneHash',
        'twoHash',
      ]),
    ).toMatchInlineSnapshot(`
      [
        {
          "clientGroupID": "abc123",
          "patchVersion": "1ba",
          "refCounts": null,
          "rowKey": {
            "id": "456",
          },
          "rowVersion": "03",
          "schema": "public",
          "table": "issues",
        },
      ]
    `);

    expect(updated).toEqual({
      ...cvr,
      version: newVersion,
      lastActive: 1713834000000,
      queries: {
        oneHash: {
          id: 'oneHash',
          ast: {table: 'issues'},
          desiredBy: {fooClient: {stateVersion: '1a9', minorVersion: 1}},
          transformationHash: 'updatedServerOneHash',
          transformationVersion: newVersion,
          patchVersion: {stateVersion: '1aa', minorVersion: 1},
        },
        twoHash: {
          id: 'twoHash',
          ast: {table: 'issues'},
          desiredBy: {fooClient: {stateVersion: '1a9', minorVersion: 1}},
          transformationHash: 'updatedServerTwoHash',
          transformationVersion: newVersion,
          patchVersion: {stateVersion: '1aa', minorVersion: 1},
        },
      },
    } satisfies CVRSnapshot);

    // Verify round tripping.
    const doCVRStore2 = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const reloaded = await doCVRStore2.load(lc, LAST_CONNECT);
    expect(reloaded).toEqual(updated);

    await expectState(db, {
      instances: [
        {
          clientGroupID: 'abc123',
          lastActive: new Date('2024-04-23T01:00:00Z').getTime(),
          version: '1ba:01',
          replicaVersion: '123',
          owner: 'my-task',
          grantedAt: 1709251200000,
        },
      ],
      clients: initialState.clients,
      queries: [
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: true,
          internal: null,
          patchVersion: '189',
          queryHash: 'already-deleted',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: true,
          internal: null,
          patchVersion: '19z',
          queryHash: 'catchup-delete',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: false,
          internal: null,
          patchVersion: '1aa:01',
          queryHash: 'oneHash',
          transformationHash: 'updatedServerOneHash',
          transformationVersion: '1ba:01',
        },
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: false,
          internal: null,
          patchVersion: '1aa:01',
          queryHash: 'twoHash',
          transformationHash: 'updatedServerTwoHash',
          transformationVersion: '1ba:01',
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          deleted: null,
          patchVersion: '1a9:01',
          queryHash: 'oneHash',
        },
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          deleted: null,
          patchVersion: '1a9:01',
          queryHash: 'twoHash',
        },
      ],
      rows: [
        {
          clientGroupID: 'abc123',
          patchVersion: '189',
          refCounts: null,
          rowKey: IN_OLD_PATCH_ROW_KEY,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1ba',
          refCounts: null,
          rowKey: DELETE_ROW_KEY,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1aa:01',
          refCounts: {
            oneHash: 1,
            twoHash: 1,
          },
          rowKey: ROW_KEY1,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1ba:01',
          refCounts: {
            oneHash: 1,
            twoHash: 1,
          },
          rowKey: ROW_KEY2,
          rowVersion: '09',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1ba:01',
          refCounts: null,
          rowKey: ROW_KEY3,
          rowVersion: '09',
          schema: 'public',
          table: 'issues',
        },
      ],
    });
  });

  test('removed query', async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1ba',
          replicaVersion: '123',
          lastActive: Date.UTC(2024, 3, 23),
        },
      ],
      clients: [],
      queries: [
        {
          clientGroupID: 'abc123',
          queryHash: 'oneHash',
          clientAST: {table: 'issues'},
          transformationHash: 'serverOneHash',
          transformationVersion: '1aa',
          patchVersion: '1aa:01',
          internal: null,
          deleted: false,
        },
        {
          clientGroupID: 'abc123',
          queryHash: 'already-deleted',
          clientAST: {table: 'issues'},
          patchVersion: '189',
          transformationHash: null,
          transformationVersion: null,
          internal: null,
          deleted: true,
        },
        {
          clientGroupID: 'abc123',
          queryHash: 'catchup-delete',
          clientAST: {table: 'issues'},
          patchVersion: '19z',
          transformationHash: null,
          transformationVersion: null,
          internal: null,
          deleted: true,
        },
      ],
      desires: [],
      rows: [
        {
          clientGroupID: 'abc123',
          patchVersion: '189',
          rowKey: IN_OLD_PATCH_ROW_KEY,
          rowVersion: '03',
          refCounts: null,
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '19z',
          rowKey: DELETE_ROW_KEY,
          rowVersion: '03',
          refCounts: null,
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1aa:01',
          rowKey: ROW_KEY1,
          refCounts: {
            oneHash: 1,
            twoHash: 1,
          },
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1ba',
          rowKey: ROW_KEY2,
          refCounts: {twoHash: 1},
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1aa:01',
          rowKey: ROW_KEY3,
          refCounts: {oneHash: 1},
          rowVersion: '09',
          schema: 'public',
          table: 'issues',
        },
      ],
    };

    await setInitialState(db, initialState);

    const cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const cvr = await cvrStore.load(lc, LAST_CONNECT);
    const updater = new CVRQueryDrivenUpdater(cvrStore, cvr, '1ba', '123');

    const {newVersion, queryPatches} = updater.trackQueries(
      lc,
      [],
      [{id: 'oneHash', transformationHash: 'oneHash'}],
    );
    expect(newVersion).toEqual({stateVersion: '1ba', minorVersion: 1});
    expect(queryPatches).toMatchInlineSnapshot(`
      [
        {
          "patch": {
            "id": "oneHash",
            "op": "del",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1ba",
          },
        },
      ]
    `);

    expect(await updater.deleteUnreferencedRows()).toEqual([
      {
        patch: {type: 'row', op: 'del', id: ROW_ID3},
        toVersion: newVersion,
      },
    ] satisfies PatchToVersion[]);

    // Same last active day (no index change), but different hour.
    // Note: Must flush before generating config patches.
    const {cvr: updated, stats} = await updater.flush(
      lc,
      LAST_CONNECT,
      Date.UTC(2024, 3, 23, 1),
    );
    expect(stats).toMatchInlineSnapshot(`
      {
        "clients": 0,
        "desires": 0,
        "instances": 2,
        "queries": 1,
        "rows": 2,
        "rowsDeferred": 0,
        "statements": 5,
      }
    `);

    expect(
      await cvrStore.catchupConfigPatches(
        lc,
        {stateVersion: '189'},
        cvr,
        updated.version,
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "patch": {
            "id": "catchup-delete",
            "op": "del",
            "type": "query",
          },
          "toVersion": {
            "stateVersion": "19z",
          },
        },
      ]
    `);

    expect(
      await catchupRows(
        cvrStore,
        {stateVersion: '189'},
        cvr,
        updated.version,
        [],
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "clientGroupID": "abc123",
          "patchVersion": "19z",
          "refCounts": null,
          "rowKey": {
            "id": "456",
          },
          "rowVersion": "03",
          "schema": "public",
          "table": "issues",
        },
        {
          "clientGroupID": "abc123",
          "patchVersion": "1ba",
          "refCounts": {
            "twoHash": 1,
          },
          "rowKey": {
            "id": "321",
          },
          "rowVersion": "03",
          "schema": "public",
          "table": "issues",
        },
        {
          "clientGroupID": "abc123",
          "patchVersion": "1aa:01",
          "refCounts": {
            "twoHash": 1,
          },
          "rowKey": {
            "id": "123",
          },
          "rowVersion": "03",
          "schema": "public",
          "table": "issues",
        },
      ]
    `);

    expect(updated).toEqual({
      ...cvr,
      version: newVersion,
      queries: {},
      lastActive: 1713834000000,
    } satisfies CVRSnapshot);

    // Verify round tripping.
    const doCVRStore2 = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const reloaded = await doCVRStore2.load(lc, LAST_CONNECT);
    expect(reloaded).toEqual(updated);

    await expectState(db, {
      instances: [
        {
          clientGroupID: 'abc123',
          lastActive: new Date('2024-04-23T01:00:00Z').getTime(),
          version: '1ba:01',
          replicaVersion: '123',
          owner: 'my-task',
          grantedAt: 1709251200000,
        },
      ],
      clients: [],
      queries: [
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: true,
          internal: null,
          patchVersion: '189',
          queryHash: 'already-deleted',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: true,
          internal: null,
          patchVersion: '19z',
          queryHash: 'catchup-delete',
          transformationHash: null,
          transformationVersion: null,
        },
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: true,
          internal: null,
          patchVersion: '1ba:01',
          queryHash: 'oneHash',
          transformationHash: null,
          transformationVersion: null,
        },
      ],
      desires: [],
      rows: [
        {
          clientGroupID: 'abc123',
          patchVersion: '189',
          refCounts: null,
          rowKey: IN_OLD_PATCH_ROW_KEY,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '19z',
          refCounts: null,
          rowKey: DELETE_ROW_KEY,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1ba',
          refCounts: {
            twoHash: 1,
          },
          rowKey: ROW_KEY2,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1aa:01',
          refCounts: {
            twoHash: 1,
          },
          rowKey: ROW_KEY1,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1ba:01',
          refCounts: null,
          rowKey: ROW_KEY3,
          rowVersion: '09',
          schema: 'public',
          table: 'issues',
        },
      ],
    });
  });

  test('unchanged queries', async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1ba',
          replicaVersion: '120',
          lastActive: Date.UTC(2024, 3, 23),
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          patchVersion: '1a9:01',
          deleted: false,
        },
      ],
      queries: [
        {
          clientGroupID: 'abc123',
          queryHash: 'oneHash',
          clientAST: {table: 'issues'},
          transformationHash: 'serverOneHash',
          transformationVersion: '1aa',
          patchVersion: '1aa:01',
          internal: null,
          deleted: null,
        },
        {
          clientGroupID: 'abc123',
          queryHash: 'twoHash',
          clientAST: {table: 'issues'},
          transformationHash: 'serverTwoHash',
          transformationVersion: '1aa',
          patchVersion: '1aa:01',
          internal: null,
          deleted: null,
        },
        {
          clientGroupID: 'abc123',
          queryHash: 'already-deleted',
          clientAST: {table: 'issues'},
          patchVersion: '189',
          transformationHash: null,
          transformationVersion: null,
          internal: null,
          deleted: true,
        },
        {
          clientGroupID: 'abc123',
          queryHash: 'catchup-delete',
          clientAST: {table: 'issues'},
          patchVersion: '19z',
          transformationHash: null,
          transformationVersion: null,
          internal: null,
          deleted: true,
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'oneHash',
          patchVersion: '1a9:01',
          deleted: null,
        },
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'twoHash',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      rows: [
        {
          clientGroupID: 'abc123',
          patchVersion: '189',
          rowKey: IN_OLD_PATCH_ROW_KEY,
          rowVersion: '03',
          refCounts: null,
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1ba',
          rowKey: DELETE_ROW_KEY,
          rowVersion: '03',
          refCounts: null,
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1aa:01',
          rowKey: ROW_KEY1,
          rowVersion: '03',
          refCounts: {
            oneHash: 1,
            twoHash: 1,
          },
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1a0',
          rowKey: ROW_KEY2,
          rowVersion: '03',
          refCounts: {twoHash: 1},
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1aa:01',
          rowKey: ROW_KEY3,
          rowVersion: '09',
          refCounts: {oneHash: 1},
          schema: 'public',
          table: 'issues',
        },
      ],
    };

    await setInitialState(db, initialState);

    const cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const cvr = await cvrStore.load(lc, LAST_CONNECT);
    expect(cvr).toMatchInlineSnapshot(`
      {
        "clients": {
          "fooClient": {
            "desiredQueryIDs": [
              "oneHash",
              "twoHash",
            ],
            "id": "fooClient",
            "patchVersion": {
              "minorVersion": 1,
              "stateVersion": "1a9",
            },
          },
        },
        "id": "abc123",
        "lastActive": 1713830400000,
        "queries": {
          "oneHash": {
            "ast": {
              "table": "issues",
            },
            "desiredBy": {
              "fooClient": {
                "minorVersion": 1,
                "stateVersion": "1a9",
              },
            },
            "id": "oneHash",
            "patchVersion": {
              "minorVersion": 1,
              "stateVersion": "1aa",
            },
            "transformationHash": "serverOneHash",
            "transformationVersion": {
              "stateVersion": "1aa",
            },
          },
          "twoHash": {
            "ast": {
              "table": "issues",
            },
            "desiredBy": {
              "fooClient": {
                "minorVersion": 1,
                "stateVersion": "1a9",
              },
            },
            "id": "twoHash",
            "patchVersion": {
              "minorVersion": 1,
              "stateVersion": "1aa",
            },
            "transformationHash": "serverTwoHash",
            "transformationVersion": {
              "stateVersion": "1aa",
            },
          },
        },
        "replicaVersion": "120",
        "version": {
          "stateVersion": "1ba",
        },
      }
    `);
    const updater = new CVRQueryDrivenUpdater(cvrStore, cvr, '1ba', '120');

    const {newVersion, queryPatches} = updater.trackQueries(
      lc,
      [
        {id: 'oneHash', transformationHash: 'serverOneHash'},
        {id: 'twoHash', transformationHash: 'serverTwoHash'},
      ],
      [],
    );
    expect(newVersion).toEqual({stateVersion: '1ba'});
    expect(queryPatches).toHaveLength(0);

    expect(
      await updater.received(
        lc,
        new Map([
          [
            ROW_ID1,
            {
              version: '03',
              refCounts: {oneHash: 1},
              contents: {id: 'existing-patch'},
            },
          ],
        ]),
      ),
    ).toEqual([
      {
        toVersion: {stateVersion: '1aa', minorVersion: 1},
        patch: {
          type: 'row',
          op: 'put',
          id: ROW_ID1,
          contents: {id: 'existing-patch'},
        },
      },
    ] satisfies PatchToVersion[]);
    expect(
      await updater.received(
        lc,
        new Map([
          [
            ROW_ID1,
            {
              version: '03',
              refCounts: {twoHash: 1},
              contents: {id: 'existing-patch'},
            },
          ],
        ]),
      ),
    ).toEqual([
      {
        toVersion: {stateVersion: '1aa', minorVersion: 1},
        patch: {
          type: 'row',
          op: 'put',
          id: ROW_ID1,
          contents: {id: 'existing-patch'},
        },
      },
    ] satisfies PatchToVersion[]);
    await updater.received(
      lc,
      new Map([
        [
          ROW_ID3,
          {
            version: '09',
            refCounts: {oneHash: 1},
            contents: {
              /* ignored */
            },
          },
        ],
      ]),
    );
    await updater.received(
      lc,
      new Map([
        [
          ROW_ID2,
          {
            version: '03',
            refCounts: {twoHash: 1},
            contents: {
              /* ignored */
            },
          },
        ],
      ]),
    );

    expect(await updater.deleteUnreferencedRows()).toEqual([]);

    // Only the last active time should change.
    const {cvr: updated, stats} = await updater.flush(
      lc,
      LAST_CONNECT,
      Date.UTC(2024, 3, 23, 1),
    );
    expect(stats).toMatchInlineSnapshot(`
      {
        "clients": 0,
        "desires": 0,
        "instances": 1,
        "queries": 0,
        "rows": 0,
        "rowsDeferred": 0,
        "statements": 2,
      }
    `);

    expect(
      await cvrStore.catchupConfigPatches(
        lc,
        {stateVersion: '189'},
        cvr,
        updated.version,
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "id": "oneHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1aa",
          },
        },
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "id": "twoHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1aa",
          },
        },
        {
          "patch": {
            "id": "catchup-delete",
            "op": "del",
            "type": "query",
          },
          "toVersion": {
            "stateVersion": "19z",
          },
        },
        {
          "patch": {
            "id": "fooClient",
            "op": "put",
            "type": "client",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1a9",
          },
        },
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "clientID": "fooClient",
            "id": "oneHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1a9",
          },
        },
        {
          "patch": {
            "ast": {
              "table": "issues",
            },
            "clientID": "fooClient",
            "id": "twoHash",
            "op": "put",
            "type": "query",
          },
          "toVersion": {
            "minorVersion": 1,
            "stateVersion": "1a9",
          },
        },
      ]
    `);

    expect(
      await catchupRows(cvrStore, {stateVersion: '189'}, cvr, updated.version, [
        'oneHash',
        'twoHash',
      ]),
    ).toMatchInlineSnapshot(`
      [
        {
          "clientGroupID": "abc123",
          "patchVersion": "1ba",
          "refCounts": null,
          "rowKey": {
            "id": "456",
          },
          "rowVersion": "03",
          "schema": "public",
          "table": "issues",
        },
      ]
    `);

    expect(updated).toEqual({
      ...cvr,
      lastActive: 1713834000000,
    } satisfies CVRSnapshot);

    // Verify round tripping.
    const doCVRStore2 = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const reloaded = await doCVRStore2.load(lc, LAST_CONNECT);
    expect(reloaded).toEqual(updated);

    // await expectStorage(storage, {
    //   ...initialState,
    //   ['/vs/cvr/abc123/m/lastActive']: {
    //     epochMillis: Date.UTC(2024, 3, 23, 1),
    //   } satisfies LastActive,
    // });
  });

  test('row key changed', async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1ba',
          replicaVersion: '123',
          lastActive: Date.UTC(2024, 3, 23),
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      queries: [
        {
          clientGroupID: 'abc123',
          queryHash: 'oneHash',
          clientAST: {table: 'issues'},
          transformationHash: 'serverOneHash',
          transformationVersion: '1aa',
          patchVersion: '1aa:01',
          internal: null,
          deleted: null,
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'oneHash',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      rows: [
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY1,
          rowVersion: '03',
          refCounts: {oneHash: 1},
          patchVersion: '1aa:01',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY2,
          rowVersion: '03',
          refCounts: {oneHash: 1},
          patchVersion: '1a0',
          schema: 'public',
          table: 'issues',
        },
      ],
    };

    await setInitialState(db, initialState);

    const cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const cvr = await cvrStore.load(lc, LAST_CONNECT);
    const updater = new CVRQueryDrivenUpdater(cvrStore, cvr, '1bb', '123');

    const {newVersion, queryPatches} = updater.trackQueries(
      lc,
      [{id: 'oneHash', transformationHash: 'serverOneHash'}],
      [],
    );
    expect(newVersion).toEqual({stateVersion: '1bb'});
    expect(queryPatches).toHaveLength(0);

    const NEW_ROW_KEY1 = {newID: '1foo'};
    const NEW_ROW_KEY3 = {newID: '3baz'};

    // NEW_ROW_KEY1 should replace ROW_KEY1
    expect(
      await updater.received(
        lc,
        new Map([
          [
            {...ROW_ID1, rowKey: NEW_ROW_KEY1},
            {
              version: '03',
              refCounts: {oneHash: 1},
              contents: {...ROW_KEY1, ...NEW_ROW_KEY1, value: 'foobar'},
            },
          ],
        ]),
      ),
    ).toEqual([
      {
        toVersion: {stateVersion: '1aa', minorVersion: 1},
        patch: {
          type: 'row',
          op: 'put',
          id: {...ROW_ID1, rowKey: NEW_ROW_KEY1},
          contents: {...ROW_KEY1, ...NEW_ROW_KEY1, value: 'foobar'},
        },
      },
    ] satisfies PatchToVersion[]);

    // NEW_ROW_KEY3 is new to this CVR.
    expect(
      await updater.received(
        lc,
        new Map([
          [
            {...ROW_ID3, rowKey: NEW_ROW_KEY3},
            {
              version: '09',
              refCounts: {oneHash: 1},
              contents: {...ROW_KEY3, ...NEW_ROW_KEY3, value: 'barfoo'},
            },
          ],
        ]),
      ),
    ).toEqual([
      {
        toVersion: newVersion,
        patch: {
          type: 'row',
          op: 'put',
          id: {...ROW_ID3, rowKey: NEW_ROW_KEY3},
          contents: {...ROW_KEY3, ...NEW_ROW_KEY3, value: 'barfoo'},
        },
      },
    ] satisfies PatchToVersion[]);

    // Note: ROW_ID2 was not received so it is deleted.
    // ROW_ID1, on the other hand was recognized with the NEW_ROW_KEY1
    // and so it is not deleted.
    expect(await updater.deleteUnreferencedRows()).toEqual([
      {
        patch: {type: 'row', op: 'del', id: ROW_ID2},
        toVersion: newVersion,
      },
    ] satisfies PatchToVersion[]);

    const {cvr: updated, stats} = await updater.flush(
      lc,
      LAST_CONNECT,
      Date.UTC(2024, 3, 23, 1),
    );
    expect(stats).toMatchInlineSnapshot(`
      {
        "clients": 0,
        "desires": 0,
        "instances": 2,
        "queries": 0,
        "rows": 4,
        "rowsDeferred": 0,
        "statements": 5,
      }
    `);

    // Verify round tripping.
    const doCVRStore2 = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const reloaded = await doCVRStore2.load(lc, LAST_CONNECT);
    expect(reloaded).toEqual(updated);

    await expectState(db, {
      instances: [
        {
          clientGroupID: 'abc123',
          lastActive: new Date('2024-04-23T01:00:00Z').getTime(),
          version: '1bb',
          replicaVersion: '123',
          owner: 'my-task',
          grantedAt: 1709251200000,
        },
      ],
      clients: initialState.clients,
      queries: [
        {
          clientAST: {
            table: 'issues',
          },
          clientGroupID: 'abc123',
          deleted: null,
          internal: null,
          patchVersion: '1aa:01',
          queryHash: 'oneHash',
          transformationHash: 'serverOneHash',
          transformationVersion: '1aa',
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          deleted: null,
          patchVersion: '1a9:01',
          queryHash: 'oneHash',
        },
      ],
      rows: [
        // Note: All the state from the previous ROW_KEY1 remains.
        {
          clientGroupID: 'abc123',
          patchVersion: '1aa:01',
          refCounts: {oneHash: 1},
          rowKey: NEW_ROW_KEY1,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1bb',
          refCounts: null, // Deleted
          rowKey: ROW_KEY2,
          rowVersion: '03',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          patchVersion: '1bb',
          refCounts: {oneHash: 1},
          rowKey: NEW_ROW_KEY3,
          rowVersion: '09',
          schema: 'public',
          table: 'issues',
        },
      ],
    });
  });

  test('advance with delete that cancels out add', async () => {
    const initialState: DBState = {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1aa',
          replicaVersion: '120',
          lastActive: Date.UTC(2024, 3, 23),
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      queries: [
        {
          clientGroupID: 'abc123',
          queryHash: 'oneHash',
          clientAST: {table: 'issues'},
          transformationHash: null,
          transformationVersion: null,
          patchVersion: null,
          internal: null,
          deleted: null,
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'oneHash',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      rows: [
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY1,
          rowVersion: '03',
          refCounts: {oneHash: 1},
          patchVersion: '1a0',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY2,
          rowVersion: '03',
          refCounts: {oneHash: 1},
          patchVersion: '1a0',
          schema: 'public',
          table: 'issues',
        },
      ],
    };

    await setInitialState(db, initialState);

    const cvrStore = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const cvr = await cvrStore.load(lc, LAST_CONNECT);
    const updater = new CVRQueryDrivenUpdater(cvrStore, cvr, '1ba', '120');

    const newVersion = updater.updatedVersion();
    expect(newVersion).toEqual({
      stateVersion: '1ba',
    });

    expect(
      await updater.received(
        lc,
        new Map([
          [
            ROW_ID1,
            {
              version: '04',
              refCounts: {oneHash: 0},
              contents: {id: 'should-show-up-in-patch'},
            },
          ],
          [
            ROW_ID3,
            {
              version: '01',
              refCounts: {oneHash: 0},
              contents: {id: 'should-not-show-up-in-patch'},
            },
          ],
        ]),
      ),
    ).toEqual([
      {
        toVersion: {stateVersion: '1ba'},
        patch: {
          type: 'row',
          op: 'put',
          id: ROW_ID1,
          contents: {id: 'should-show-up-in-patch'},
        },
      },
    ] satisfies PatchToVersion[]);

    // Same last active day (no index change), but different hour.
    const {cvr: updated, stats} = await updater.flush(
      lc,
      LAST_CONNECT,
      Date.UTC(2024, 3, 23, 1),
    );
    expect(stats).toMatchInlineSnapshot(`
      {
        "clients": 0,
        "desires": 0,
        "instances": 2,
        "queries": 0,
        "rows": 1,
        "rowsDeferred": 0,
        "statements": 4,
      }
    `);

    // Verify round tripping.
    const cvrStore2 = new CVRStore(lc, db, 'my-task', 'abc123', ON_FAILURE);
    const reloaded = await cvrStore2.load(lc, LAST_CONNECT);
    expect(reloaded).toEqual(updated);

    await expectState(db, {
      instances: [
        {
          clientGroupID: 'abc123',
          version: '1ba',
          replicaVersion: '120',
          lastActive: Date.UTC(2024, 3, 23, 1),
          owner: 'my-task',
          grantedAt: 1709251200000,
        },
      ],
      clients: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      queries: [
        {
          clientGroupID: 'abc123',
          queryHash: 'oneHash',
          clientAST: {table: 'issues'},
          transformationHash: null,
          transformationVersion: null,
          patchVersion: null,
          internal: null,
          deleted: null,
        },
      ],
      desires: [
        {
          clientGroupID: 'abc123',
          clientID: 'fooClient',
          queryHash: 'oneHash',
          patchVersion: '1a9:01',
          deleted: null,
        },
      ],
      rows: [
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY2,
          rowVersion: '03',
          refCounts: {oneHash: 1},
          patchVersion: '1a0',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: 'abc123',
          rowKey: ROW_KEY1,
          rowVersion: '04',
          refCounts: {oneHash: 1},
          patchVersion: '1ba',
          schema: 'public',
          table: 'issues',
        },
      ],
    });
  });
});
