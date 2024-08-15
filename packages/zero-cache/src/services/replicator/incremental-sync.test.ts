import {LogContext} from '@rocicorp/logger';
import {Database} from 'better-sqlite3';
import {createSilentLogContext} from 'shared/src/logging-test-utils.js';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {DbFile, expectTables} from 'zero-cache/src/test/lite.js';
import {
  dropReplicationSlot,
  getConnectionURI,
  initDB,
  testDBs,
} from '../../test/db.js';
import {versionFromLexi, type LexiVersion} from '../../types/lexi-version.js';
import type {PostgresDB} from '../../types/pg.js';
import {IncrementalSyncer} from './incremental-sync.js';
import {initialSync, replicationSlot} from './initial-sync.js';
import {getReplicationState} from './schema/replication.js';
import {listTables} from './tables/list.js';
import {TableSpec} from './tables/specs.js';

const REPLICA_ID = 'incremental_sync_test_id';

const REPLICATED_ZERO_CLIENTS_SPEC: TableSpec = {
  columns: {
    clientGroupID: {
      characterMaximumLength: null,
      dataType: 'TEXT',
      notNull: false,
    },
    clientID: {
      characterMaximumLength: null,
      dataType: 'TEXT',
      notNull: false,
    },
    lastMutationID: {
      characterMaximumLength: null,
      dataType: 'INTEGER',
      notNull: false,
    },
    userID: {
      characterMaximumLength: null,
      dataType: 'TEXT',
      notNull: false,
    },
  },
  name: 'zero.clients',
  primaryKey: ['clientGroupID', 'clientID'],
  schema: '',
} as const;

describe('replicator/incremental-sync', {retry: 3}, () => {
  let lc: LogContext;
  let upstream: PostgresDB;
  let replicaFile: DbFile;
  let replica: Database;
  let syncer: IncrementalSyncer;

  beforeEach(async () => {
    lc = createSilentLogContext();
    upstream = await testDBs.create('incremental_sync_test_upstream');
    replicaFile = new DbFile('incremental_sync_test_replica');
    replica = replicaFile.connect();
    syncer = new IncrementalSyncer(
      getConnectionURI(upstream),
      REPLICA_ID,
      replica,
    );
  });

  afterEach(async () => {
    await syncer.stop(lc);
    await dropReplicationSlot(upstream, replicationSlot(REPLICA_ID));
    await testDBs.drop(upstream);
    await replicaFile.unlink();
  });

  type Case = {
    name: string;
    setupUpstream?: string;
    writeUpstream?: string[];
    specs: Record<string, TableSpec>;
    data: Record<string, Record<string, unknown>[]>;
  };

  const cases: Case[] = [
    {
      name: 'no tables',
      specs: {
        ['zero.clients']: REPLICATED_ZERO_CLIENTS_SPEC,
      },
      data: {
        ['zero.clients']: [],
        ['_zero.ChangeLog']: [],
      },
    },
    {
      name: 'existing tables',
      setupUpstream: `
      CREATE TABLE issues (
        "issueID" INTEGER PRIMARY KEY
      );
      CREATE TABLE "table-with-special-characters" (
        "id" INTEGER PRIMARY KEY
      );
      `,
      specs: {
        issues: {
          schema: '',
          name: 'issues',
          columns: {
            issueID: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            ['_0_version']: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: true,
            },
          },
          primaryKey: ['issueID'],
        },
        ['table-with-special-characters']: {
          schema: '',
          name: 'table-with-special-characters',
          columns: {
            id: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            ['_0_version']: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: true,
            },
          },
          primaryKey: ['id'],
        },
        ['zero.clients']: REPLICATED_ZERO_CLIENTS_SPEC,
      },
      data: {
        issues: [],
        ['table-with-special-characters']: [],
        ['zero.clients']: [],
        ['_zero.ChangeLog']: [],
      },
    },
    {
      name: 'insert rows',
      setupUpstream: `
      CREATE TABLE issues(
        "issueID" INTEGER PRIMARY KEY,
        big BIGINT,
        flt FLOAT8,
        description TEXT
      );
      CREATE PUBLICATION zero_all FOR TABLE issues WHERE ("issueID" < 1000);
      `,
      specs: {
        issues: {
          schema: '',
          name: 'issues',
          columns: {
            issueID: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            big: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            flt: {
              dataType: 'REAL',
              characterMaximumLength: null,
              notNull: false,
            },
            description: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: false,
            },
            ['_0_version']: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: true,
            },
          },
          primaryKey: ['issueID'],
        },
        ['zero.clients']: REPLICATED_ZERO_CLIENTS_SPEC,
      },
      writeUpstream: [
        `
      INSERT INTO issues ("issueID") VALUES (123);
      INSERT INTO issues ("issueID") VALUES (456);
      -- Rows > 1000 should be filtered by PG.
      INSERT INTO issues ("issueID") VALUES (1001);
      `,
        `
      INSERT INTO issues ("issueID", big) VALUES (789, 9223372036854775807);
      INSERT INTO issues ("issueID") VALUES (987);
      INSERT INTO issues ("issueID", flt) VALUES (234, 123.456);

      -- Rows > 1000 should be filtered by PG.
      INSERT INTO issues ("issueID") VALUES (2001);
      `,
      ],
      data: {
        issues: [
          {
            issueID: 123n,
            big: null,
            flt: null,
            description: null,
            ['_0_version']: '01',
          },
          {
            issueID: 456n,
            big: null,
            flt: null,
            description: null,
            ['_0_version']: '01',
          },
          {
            issueID: 789n,
            big: 9223372036854775807n,
            flt: null,
            description: null,
            ['_0_version']: '02',
          },
          {
            issueID: 987n,
            big: null,
            flt: null,
            description: null,
            ['_0_version']: '02',
          },
          {
            issueID: 234n,
            big: null,
            flt: 123.456,
            description: null,
            ['_0_version']: '02',
          },
        ],
        ['_zero.ChangeLog']: [
          {
            stateVersion: '01',
            table: 'issues',
            op: 's',
            rowKey: '{"issueID":123}',
          },
          {
            stateVersion: '01',
            table: 'issues',
            op: 's',
            rowKey: '{"issueID":456}',
          },
          {
            stateVersion: '02',
            table: 'issues',
            op: 's',
            rowKey: '{"issueID":789}',
          },
          {
            stateVersion: '02',
            table: 'issues',
            op: 's',
            rowKey: '{"issueID":987}',
          },
          {
            stateVersion: '02',
            table: 'issues',
            op: 's',
            rowKey: '{"issueID":234}',
          },
        ],
      },
    },
    {
      name: 'update rows with multiple key columns and key value updates',
      setupUpstream: `
      CREATE TABLE issues(
        "issueID" INTEGER,
        "orgID" INTEGER,
        description TEXT,
        PRIMARY KEY("orgID", "issueID")
      );
      `,
      specs: {
        issues: {
          schema: '',
          name: 'issues',
          columns: {
            issueID: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            orgID: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            description: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: false,
            },
            ['_0_version']: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: true,
            },
          },
          primaryKey: ['orgID', 'issueID'],
        },
        ['zero.clients']: REPLICATED_ZERO_CLIENTS_SPEC,
      },
      writeUpstream: [
        `
      INSERT INTO issues ("orgID", "issueID") VALUES (1, 123);
      INSERT INTO issues ("orgID", "issueID") VALUES (1, 456);
      INSERT INTO issues ("orgID", "issueID") VALUES (2, 789);
      `,
        `
      UPDATE issues SET (description) = ROW('foo') WHERE "issueID" = 456;
      UPDATE issues SET ("orgID", description) = ROW(2, 'bar') WHERE "issueID" = 123;
      `,
      ],
      data: {
        issues: [
          {orgID: 2n, issueID: 123n, description: 'bar', ['_0_version']: '02'},
          {orgID: 1n, issueID: 456n, description: 'foo', ['_0_version']: '02'},
          {orgID: 2n, issueID: 789n, description: null, ['_0_version']: '01'},
        ],
        ['_zero.ChangeLog']: [
          {
            stateVersion: '01',
            table: 'issues',
            op: 's',
            rowKey: '{"issueID":789,"orgID":2}',
          },
          {
            stateVersion: '02',
            table: 'issues',
            op: 's',
            rowKey: '{"issueID":456,"orgID":1}',
          },
          {
            stateVersion: '02',
            table: 'issues',
            op: 'd',
            rowKey: '{"issueID":123,"orgID":1}',
          },
          {
            stateVersion: '02',
            table: 'issues',
            op: 's',
            rowKey: '{"issueID":123,"orgID":2}',
          },
        ],
      },
    },
    {
      name: 'delete rows',
      setupUpstream: `
      CREATE TABLE issues(
        "issueID" INTEGER,
        "orgID" INTEGER,
        description TEXT,
        PRIMARY KEY("orgID", "issueID")
      );
      CREATE PUBLICATION zero_all FOR TABLES IN SCHEMA public;
      `,
      specs: {
        issues: {
          schema: '',
          name: 'issues',
          columns: {
            issueID: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            orgID: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            description: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: false,
            },
            ['_0_version']: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: true,
            },
          },
          primaryKey: ['orgID', 'issueID'],
        },
        ['zero.clients']: REPLICATED_ZERO_CLIENTS_SPEC,
      },
      writeUpstream: [
        `
      INSERT INTO issues ("orgID", "issueID") VALUES (1, 123);
      INSERT INTO issues ("orgID", "issueID") VALUES (1, 456);
      INSERT INTO issues ("orgID", "issueID") VALUES (2, 789);
      INSERT INTO issues ("orgID", "issueID") VALUES (2, 987);
      `,
        `
      DELETE FROM issues WHERE "orgID" = 1;
      DELETE FROM issues WHERE "issueID" = 987;
      `,
      ],
      data: {
        issues: [
          {orgID: 2n, issueID: 789n, description: null, ['_0_version']: '01'},
        ],
        ['_zero.ChangeLog']: [
          {
            stateVersion: '01',
            table: 'issues',
            op: 's',
            rowKey: '{"issueID":789,"orgID":2}',
          },
          {
            stateVersion: '02',
            table: 'issues',
            op: 'd',
            rowKey: '{"issueID":123,"orgID":1}',
          },
          {
            stateVersion: '02',
            table: 'issues',
            op: 'd',
            rowKey: '{"issueID":456,"orgID":1}',
          },
          {
            stateVersion: '02',
            table: 'issues',
            op: 'd',
            rowKey: '{"issueID":987,"orgID":2}',
          },
        ],
      },
    },
    {
      name: 'truncate tables',
      setupUpstream: `
      CREATE TABLE foo(id INTEGER PRIMARY KEY);
      CREATE TABLE bar(id INTEGER PRIMARY KEY);
      CREATE TABLE baz(id INTEGER PRIMARY KEY);
      CREATE PUBLICATION zero_all FOR TABLES IN SCHEMA public;
      `,
      specs: {
        foo: {
          schema: '',
          name: 'foo',
          columns: {
            id: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            ['_0_version']: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: true,
            },
          },
          primaryKey: ['id'],
        },
        bar: {
          schema: '',
          name: 'bar',
          columns: {
            id: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            ['_0_version']: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: true,
            },
          },
          primaryKey: ['id'],
        },
        baz: {
          schema: '',
          name: 'baz',
          columns: {
            id: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            ['_0_version']: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: true,
            },
          },
          primaryKey: ['id'],
        },
        ['zero.clients']: REPLICATED_ZERO_CLIENTS_SPEC,
      },
      writeUpstream: [
        `
      INSERT INTO foo (id) VALUES (1);
      INSERT INTO foo (id) VALUES (2);
      INSERT INTO foo (id) VALUES (3);
      INSERT INTO bar (id) VALUES (4);
      INSERT INTO bar (id) VALUES (5);
      INSERT INTO bar (id) VALUES (6);
      INSERT INTO baz (id) VALUES (7);
      INSERT INTO baz (id) VALUES (8);
      INSERT INTO baz (id) VALUES (9);
      TRUNCATE foo, baz;
      TRUNCATE foo;  -- Redundant. Shouldn't cause problems.
      `,
        `
      TRUNCATE foo;
      INSERT INTO foo (id) VALUES (101);
      `,
      ],
      data: {
        foo: [{id: 101n, ['_0_version']: '02'}],
        bar: [
          {id: 4n, ['_0_version']: '01'},
          {id: 5n, ['_0_version']: '01'},
          {id: 6n, ['_0_version']: '01'},
        ],
        baz: [],
        ['_zero.ChangeLog']: [
          {
            stateVersion: '01',
            table: 'bar',
            op: 's',
            rowKey: '{"id":4}',
          },
          {
            stateVersion: '01',
            table: 'bar',
            op: 's',
            rowKey: '{"id":5}',
          },
          {
            stateVersion: '01',
            table: 'bar',
            op: 's',
            rowKey: '{"id":6}',
          },
          {
            stateVersion: '01',
            table: 'baz',
            op: 't',
            rowKey: null,
          },
          {
            stateVersion: '02',
            table: 'foo',
            op: 't',
            rowKey: null,
          },
          {
            stateVersion: '02',
            table: 'foo',
            op: 's',
            rowKey: '{"id":101}',
          },
        ],
      },
    },
    {
      name: 'overwriting updates in the same transaction',
      setupUpstream: `
      CREATE TABLE issues(
        "issueID" INTEGER,
        "orgID" INTEGER,
        description TEXT,
        PRIMARY KEY("orgID", "issueID")
      );
      CREATE PUBLICATION zero_all FOR TABLES IN SCHEMA public;
      `,
      specs: {
        issues: {
          schema: '',
          name: 'issues',
          columns: {
            issueID: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            orgID: {
              dataType: 'INTEGER',
              characterMaximumLength: null,
              notNull: false,
            },
            description: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: false,
            },
            ['_0_version']: {
              dataType: 'TEXT',
              characterMaximumLength: null,
              notNull: true,
            },
          },
          primaryKey: ['orgID', 'issueID'],
        },
        ['zero.clients']: REPLICATED_ZERO_CLIENTS_SPEC,
      },
      writeUpstream: [
        `
      INSERT INTO issues ("orgID", "issueID") VALUES (1, 123);
      UPDATE issues SET ("orgID", "issueID") = (1, 456);
      INSERT INTO issues ("orgID", "issueID") VALUES (2, 789);
      DELETE FROM issues WHERE "orgID" = 2;
      UPDATE issues SET "description" = 'foo';
      `,
      ],
      data: {
        issues: [
          {orgID: 1n, issueID: 456n, description: 'foo', ['_0_version']: '01'},
        ],
        ['_zero.ChangeLog']: [
          {
            stateVersion: '01',
            table: 'issues',
            op: 'd',
            rowKey: '{"issueID":123,"orgID":1}',
          },
          {
            stateVersion: '01',
            table: 'issues',
            op: 's',
            rowKey: '{"issueID":456,"orgID":1}',
          },
          {
            stateVersion: '01',
            table: 'issues',
            op: 'd',
            rowKey: '{"issueID":789,"orgID":2}',
          },
        ],
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      await initDB(upstream, c.setupUpstream);
      await initialSync(
        lc,
        REPLICA_ID,
        replica,
        upstream,
        getConnectionURI(upstream),
      );

      const syncing = syncer.run(lc);
      const notifications = await syncer.subscribe();

      const versions: string[] = ['00'];
      const versionReady = notifications[Symbol.asyncIterator]();
      const nextVersion = async () => {
        await versionReady.next();
        const {nextStateVersion} = getReplicationState(replica);
        versions.push(nextStateVersion);
      };

      await nextVersion(); // Get the initial nextStateVersion.
      for (const query of c.writeUpstream ?? []) {
        await upstream.unsafe(query);
        await Promise.race([nextVersion(), syncing]);
      }

      const tables = listTables(replica);
      expect(
        Object.fromEntries(tables.map(table => [table.name, table])),
      ).toMatchObject(c.specs);

      expectTables(
        replica,
        replaceVersions(structuredClone(c.data), versions),
        'bigint',
      );
    });
  }

  function replaceVersions(
    data: Record<string, Record<string, unknown>[]>,
    versions: string[],
  ): Record<string, unknown[]> {
    const replace = (key: string, obj: Record<string, unknown>) => {
      const v = obj[key] as LexiVersion;
      const index = Number(versionFromLexi(v));
      if (index > 0) {
        obj[key] = versions[index];
      }
    };
    Object.values(data).forEach(table =>
      table.forEach(row => {
        for (const col of ['_0_version', 'stateVersion']) {
          if (col in row) {
            replace(col, row);
          }
        }
      }),
    );
    return data;
  }
});
