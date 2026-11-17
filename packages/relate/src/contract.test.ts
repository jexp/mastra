/**
 * The schema-4 Knowledge contract over Relate: the shared adapter suites every page-store adapter
 * runs (pg, mysql, mongodb, libsql, the mock store), plus the graph-specific lifecycle cases —
 * legacy schema-2 stores, the storage-isolation key, file-backed persistence and composite-store
 * wiring.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKnowledgePageStoreTests, createKnowledgeSchemaResetTests } from '@internal/storage-test-utils';
import { KNOWLEDGE_STORAGE_SCHEMA_VERSION, MastraCompositeStore } from '@mastra/core/storage';
import { Database } from '@relate/relate';
import { describe, expect, it } from 'vitest';

import { KNOWLEDGE_LABELS, LEGACY_KNOWLEDGE_LABELS } from './page-store';
import { RelateKnowledgeStorage } from './storage';
import { countNodes, openInitializedStorage, openStorage } from './test-support';

const host = { author: 'host' };
const all = 'all' as const;

createKnowledgePageStoreTests(() => openStorage());

createKnowledgeSchemaResetTests(async () => {
  const store = await openInitializedStorage();
  const connection = store.connection;
  // A schema version this release doesn't know: init must refuse and only reset may replace it.
  connection.query('MATCH (m:KMeta {kind: $kind}) SET m.schemaVersion = $version', {
    kind: 'knowledge',
    version: KNOWLEDGE_STORAGE_SCHEMA_VERSION + 1,
  });
  connection.query('CREATE (:Application {id: $id})', { id: 'preserved' });
  return {
    store,
    snapshot: () =>
      connection.query(
        'MATCH (n) UNWIND labels(n) AS label WITH label WHERE label IN $labels RETURN label, count(*) AS count ORDER BY label',
        { labels: [...KNOWLEDGE_LABELS, ...LEGACY_KNOWLEDGE_LABELS, 'Application'] },
      ).rows,
    assertResetResult: async () => {
      expect(countNodes(store, 'Application')).toBe(1);
      expect(countNodes(store, 'KPage')).toBe(0);
      expect(countNodes(store, 'KNote')).toBe(0);
      expect(countNodes(store, 'KPin')).toBe(0);
      expect(countNodes(store, 'KActivity')).toBe(0);
      expect(countNodes(store, 'KBodyLink')).toBe(0);
    },
    cleanup: async () => {
      // :memory: — nothing to clean up.
    },
  };
});

describe('Relate knowledge storage', () => {
  it('reports the schema-4 page store in its capabilities', () => {
    expect(openStorage().getCapabilities()).toEqual({
      contractVersion: 4,
      schemaVersion: KNOWLEDGE_STORAGE_SCHEMA_VERSION,
      supportsSchemaInspection: true,
      supportsExplicitReset: true,
      supportsPinKinds: true,
    });
  });

  it('overrides every base-class refusal with a real implementation', () => {
    // KnowledgeStorage's defaults refuse each page-store method; our storage must own an override
    // for each of them, not inherit the refusal. Base-class methods leave a prototype entry, so
    // an own property on our prototype is exactly the set of overrides.
    for (const method of [
      'materializeScope',
      'getScopesByAddress',
      'listScopeDeclarations',
      'renameScopeDeclaration',
      'listChildScopes',
      'countChildScopes',
      'getPage',
      'getPages',
      'getPageByPath',
      'findPagesByName',
      'listChildPages',
      'countChildPages',
      'listPages',
      'createPage',
      'updatePage',
      'movePage',
      'mergePages',
      'deletePage',
      'replacePageBodyLinks',
      'listPageBodyLinkSources',
      'countPageLinks',
      'listPageLinks',
      'getNote',
      'countNotes',
      'listNotes',
      'listNotesMentioning',
      'addNote',
      'restampNote',
      'removeNote',
      'restoreNote',
      'searchPages',
      'listPageActivity',
      'addPinAudience',
      'removePinAudience',
      'listPins',
    ] as const) {
      expect(Object.hasOwn(RelateKnowledgeStorage.prototype, method), method).toBe(true);
    }
  });

  it('drops a pre-schema-4 store on init, keeping non-Knowledge nodes', async () => {
    const store = openStorage();
    const connection = store.connection;
    // A schema-2 store: legacy labels plus the old kindless KMeta marker.
    connection.query('CREATE (:KNode {id: $id})', { id: 'legacy' });
    connection.query('CREATE (:KMeta {id: $id, schemaVersion: $version})', { id: 'knowledge', version: 2 });
    connection.query('CREATE (:Application {id: $id})', { id: 'kept' });
    expect(await store.inspectSchema()).toMatchObject({ status: 'incompatible-reset-required' });

    await store.init();
    expect(countNodes(store, 'KNode')).toBe(0);
    expect(countNodes(store, 'KMeta')).toBe(1);
    expect(countNodes(store, 'Application')).toBe(1);
    expect(await store.inspectSchema()).toEqual({
      status: 'compatible',
      schemaVersion: KNOWLEDGE_STORAGE_SCHEMA_VERSION,
    });

    const { scope } = await store.materializeScope({
      address: 'org:acme',
      declaration: 'org:$orgId',
      name: 'Acme',
      provenance: host,
    });
    const page = await store.createPage({ parentId: scope.id, name: 'Policy', provenance: host });
    expect((await store.getPage({ id: page.id, read: all }))?.name).toBe('Policy');
  });

  it('keeps a cleared store initialized', async () => {
    const store = await openInitializedStorage();
    const { scope } = await store.materializeScope({
      address: 'org:acme',
      declaration: 'org:$orgId',
      name: 'Acme',
      provenance: host,
    });
    await store.createPage({ parentId: scope.id, name: 'Policy', provenance: host });

    await store.dangerouslyClearAll();
    expect(await store.inspectSchema()).toEqual({
      status: 'compatible',
      schemaVersion: KNOWLEDGE_STORAGE_SCHEMA_VERSION,
    });
    expect(countNodes(store, 'KPage')).toBe(0);
    // The composite store only calls init() once, so the cleared store must stay usable as-is.
    const { scope: fresh } = await store.materializeScope({
      address: 'org:acme',
      declaration: 'org:$orgId',
      name: 'Acme',
      provenance: host,
    });
    const page = await store.createPage({ parentId: fresh.id, name: 'Fresh', provenance: host });
    expect((await store.getPage({ id: page.id, read: all }))?.name).toBe('Fresh');
  });
});

describe('Relate knowledge storage isolation', () => {
  it('identifies domains over the same file as one physical backend', () => {
    // Constructing a store opens nothing: the database connects lazily on first use.
    expect(new RelateKnowledgeStorage({ path: './shared' }).getStorageIsolationKey()).toBe(
      new RelateKnowledgeStorage({ path: 'shared' }).getStorageIsolationKey(),
    );
    expect(new RelateKnowledgeStorage({ path: './first' }).getStorageIsolationKey()).not.toBe(
      new RelateKnowledgeStorage({ path: './second' }).getStorageIsolationKey(),
    );
  });

  it('treats each :memory: handle as its own backend', () => {
    expect(new RelateKnowledgeStorage({ path: ':memory:' }).getStorageIsolationKey()).not.toBe(
      new RelateKnowledgeStorage({ path: ':memory:' }).getStorageIsolationKey(),
    );
  });

  it('identifies domains sharing one connection as one backend, and lets callers override', () => {
    const connection = Database.open(':memory:').connect();
    expect(new RelateKnowledgeStorage({ connection }).getStorageIsolationKey()).toBe(
      new RelateKnowledgeStorage({ connection }).getStorageIsolationKey(),
    );
    expect(new RelateKnowledgeStorage({ connection, storageIsolationKey: 'tenant-a' }).getStorageIsolationKey()).toBe(
      'tenant-a',
    );
  });
});

describe.skipIf(process.platform === 'win32')('file-backed persistence', () => {
  it('writes through to the file and reattaches over the same connection', async () => {
    // shortcut: @relate/relate 1.0.1 exposes no Database.close(), so a second open of the same
    // store while the first handle is alive fails on the single-writer lock. Reopen-across-handles
    // becomes possible when the client exposes close(); here we prove the durable form works at all.
    const dir = mkdtempSync(join(tmpdir(), 'relate-knowledge-'));
    try {
      const storage = await openInitializedStorage({ path: join(dir, 'knowledge') });
      const { scope } = await storage.materializeScope({
        address: 'org:acme',
        declaration: 'org:$orgId',
        name: 'Acme',
        provenance: host,
      });
      const page = await storage.createPage({
        parentId: scope.id,
        name: 'Durable',
        key: 'durable',
        body: 'written through the WAL',
        provenance: host,
      });
      await storage.addNote({
        pageId: page.id,
        text: 'durable note',
        stampScopeIds: [scope.id],
        mentions: [],
        provenance: host,
      });

      // A second adapter instance over the same connection must see the first one's writes.
      const reopen = new RelateKnowledgeStorage({ connection: storage.connection });
      expect(await reopen.getPageByPath({ scopeId: scope.id, path: ['durable'], read: all })).toMatchObject({
        name: 'Durable',
        body: 'written through the WAL',
      });
      expect((await reopen.listNotes({ pageId: page.id, read: all })).notes).toHaveLength(1);
      expect(await reopen.listScopeDeclarations()).toEqual([{ declaration: 'org:$orgId', scopes: 1 }]);
      expect(existsSync(join(dir, 'knowledge'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('composite store wiring', () => {
  it('initializes the knowledge domain through the composite store', async () => {
    const store = openStorage();
    const composite = new MastraCompositeStore({ id: 'relate-knowledge', domains: { knowledge: store } });
    const knowledge = await composite.getStore('knowledge');
    expect(knowledge).toBe(store);
    // getStore ran init(): the marker exists, so inspection reports compatible.
    expect(await store.inspectSchema()).toEqual({
      status: 'compatible',
      schemaVersion: KNOWLEDGE_STORAGE_SCHEMA_VERSION,
    });
    const { scope } = await store.materializeScope({
      address: 'org:acme',
      declaration: 'org:$orgId',
      name: 'Acme',
      provenance: host,
    });
    expect(await knowledge!.getScopesByAddress([scope.address!])).toHaveLength(1);
  });
});
