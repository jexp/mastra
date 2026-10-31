import { Database } from '@neo4j-labs/cypherlite';
import { describe, expect, it } from 'vitest';

import { createAdapterContext } from './connection';
import { CypherLiteKnowledgeStorage } from './storage';
import { countNodes, openStorage } from './test-support';

const ORG = ['org:acme'];

describe('capabilities and schema', () => {
  it('reports the v2 contract and schema', () => {
    const storage = openStorage({ connection: Database.open(':memory:').connect() });

    expect(storage.getCapabilities()).toEqual({
      contractVersion: 2,
      schemaVersion: 2,
      supportsV2: true,
      supportsSchemaInspection: true,
      supportsExplicitReset: true,
    });
  });

  it('reports an uninitialized store, then a compatible one after init', async () => {
    const connection = Database.open(':memory:').connect();
    const storage = openStorage({ connection });

    expect(await storage.inspectSchema()).toEqual({ status: 'uninitialized', schemaVersion: null });

    await storage.init();

    expect(await storage.inspectSchema()).toEqual({ status: 'compatible', schemaVersion: 2 });
  });

  it('reports a store whose marker declares another schema version as reset-required', async () => {
    const connection = Database.open(':memory:').connect();
    connection.query(`CREATE (:KMeta {id: 'knowledge', schemaVersion: 1})`);
    const storage = openStorage({ connection });

    expect(await storage.inspectSchema()).toMatchObject({ status: 'incompatible-reset-required', schemaVersion: 1 });
    await expect(storage.init()).rejects.toThrow(/schema reset required/);
  });

  it('creates the constraints and the marker idempotently, without a fulltext index', async () => {
    const storage = openStorage({ path: ':memory:' });

    await storage.init();
    await storage.init();

    const constraints = storage.connection
      .query(`SHOW CONSTRAINTS`)
      .rows.map(row => String(row.name))
      .sort();
    expect(constraints).toEqual([
      'knowledge_activity_id',
      'knowledge_node_scope_name',
      'knowledge_outbox_idempotency_key',
      'knowledge_record_id',
      'knowledge_scope_address',
    ]);

    // Search scans KNode with a CONTAINS predicate; a node fulltext index would only answer tokens.
    const fulltextIndexes = storage.connection.query(`SHOW INDEXES`).rows.filter(row => row.type === 'FULLTEXT');
    expect(fulltextIndexes).toEqual([]);
  });

  it('resets Knowledge data and edges while keeping the schema marker', async () => {
    const storage = openStorage({ connection: Database.open(':memory:').connect() });
    await storage.init();
    await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    storage.connection.query(`CREATE (:KScope {id: 'scope-1', address: 'features:memory'})`);

    await storage.dangerouslyReset();

    expect(await storage.listNodes({ scope: ORG })).toEqual([]);
    for (const label of ['KNode', 'KRecord', 'KActivity', 'KOutbox', 'KScope']) {
      expect(countNodes(storage, label)).toBe(0);
    }
    expect(await storage.inspectSchema()).toEqual({ status: 'compatible', schemaVersion: 2 });
  });
});

describe('transaction frame', () => {
  it('rolls back the frame when the operation throws and commits it otherwise', () => {
    const context = createAdapterContext({ connection: Database.open(':memory:').connect() });

    expect(() =>
      context.transaction(() => {
        context.run(`CREATE (:Probe {id: $id})`, { id: 'rolled-back' });
        throw new Error('boom');
      }),
    ).toThrow('boom');

    context.transaction(() => context.run(`CREATE (:Probe {id: $id})`, { id: 'kept' }));

    const ids = context.run(`MATCH (p:Probe) RETURN p.id AS id ORDER BY id`).map(row => row.id);
    expect(ids).toEqual(['kept']);
  });
});

describe('constructor', () => {
  it('rejects a config that names neither or both sources', () => {
    expect(() => new CypherLiteKnowledgeStorage({} as never)).toThrow(/requires \{ path \} or \{ connection \}/);
    expect(
      () =>
        new CypherLiteKnowledgeStorage({
          path: ':memory:',
          connection: Database.open(':memory:').connect(),
        } as never),
    ).toThrow(/not both/);
  });
});
