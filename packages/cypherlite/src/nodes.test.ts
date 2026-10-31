import { createKnowledgeNodeCursor, KnowledgeConflictError, KnowledgeNotFoundError } from '@mastra/core/storage';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CypherLiteKnowledgeStorage } from './storage';
import { countNodes, openStorage, setUpdatedAt } from './test-support';

const ORG = ['org:acme'];
const ORG_DB = ['org:acme', 'resource:db'];
const THREAD = ['org:acme', 'resource:db', 'thread:t1'];

describe('node lifecycle', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  it('creates a node with a canonical scope and reads it back', async () => {
    const created = await storage.createNode({
      name: '  Alpha ',
      kind: 'entity',
      content: 'long form',
      description: 'short form',
      scope: ['resource:db', 'org:acme'],
    });

    expect(created).toMatchObject({
      name: 'Alpha',
      kind: 'entity',
      content: 'long form',
      description: 'short form',
      type: 'node',
      version: 1,
      scope: ORG_DB,
    });
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(await storage.getNode(created.id)).toEqual(created);
    expect(await storage.getNodeByName({ name: 'alpha', scope: ORG_DB })).toEqual(created);
  });

  it('returns the existing node when the same name is created in the same scope', async () => {
    const first = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const second = await storage.createNode({ name: 'alpha', kind: 'entity', scope: ORG, content: 'ignored' });

    expect(second.id).toBe(first.id);
    expect(second.version).toBe(1);
    expect(second.content).toBeUndefined();
    expect(countNodes(storage, 'KNode')).toBe(1);
  });

  it('rejects a description over the storage bound without writing anything', async () => {
    await expect(
      storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG, description: 'x'.repeat(401) }),
    ).rejects.toThrow(/description exceeds/);
    expect(countNodes(storage, 'KNode')).toBe(0);
  });

  it('places a node in the structural scopes it names', async () => {
    storage.connection.query(`CREATE (:KScope {id: 'scope-1', address: 'features:memory'})`);

    const node = await storage.createNode({
      name: 'Alpha',
      kind: 'entity',
      scope: ORG,
      scopeAddresses: ['features:memory'],
    });

    const placed = storage.connection
      .query(`MATCH (n:KNode {id: $id})-[:IN_SCOPE]->(scope:KScope) RETURN scope.address AS address`, { id: node.id })
      .rows.map(row => row.address);
    expect(placed).toEqual(['features:memory']);
  });

  it('rejects an unknown structural scope address', async () => {
    await expect(
      storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG, scopeAddresses: ['features:missing'] }),
    ).rejects.toBeInstanceOf(KnowledgeNotFoundError);
    expect(countNodes(storage, 'KNode')).toBe(0);
  });

  it('lists nodes newest-first with scope, kind, prefix, content and cursor filters', async () => {
    const older = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const newer = await storage.createNode({ name: 'Alpine', kind: 'entity', scope: ORG_DB, content: 'body' });
    const beta = await storage.createNode({ name: 'Beta', kind: 'topic', scope: THREAD });
    setUpdatedAt(storage, older.id, 1_000);
    setUpdatedAt(storage, newer.id, 2_000);
    setUpdatedAt(storage, beta.id, 3_000);

    expect((await storage.listNodes({ scope: THREAD })).map(node => node.id)).toEqual([beta.id, newer.id, older.id]);
    expect((await storage.listNodes({ scope: THREAD, namePrefix: 'alp' })).map(node => node.id)).toEqual([
      newer.id,
      older.id,
    ]);
    expect((await storage.listNodes({ scope: THREAD, kind: 'topic' })).map(node => node.name)).toEqual(['Beta']);
    expect((await storage.listNodes({ scope: THREAD, hasContent: true })).map(node => node.id)).toEqual([newer.id]);
    expect((await storage.listNodes({ scope: ORG })).map(node => node.name)).toEqual(['Alpha']);

    const page = await storage.listNodes({ scope: THREAD, limit: 2 });
    expect(page.map(node => node.id)).toEqual([beta.id, newer.id]);
    const cursor = createKnowledgeNodeCursor(page[1]!, {});
    expect((await storage.listNodes({ scope: THREAD, cursor, limit: 2 })).map(node => node.id)).toEqual([older.id]);
  });
});

describe('node resolution', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  it('resolves narrow-to-broad: the most specific visible node wins', async () => {
    const broad = await storage.createNode({ name: 'Widget', kind: 'entity', scope: ORG });
    const narrow = await storage.createNode({ name: 'Widget', kind: 'entity', scope: ORG_DB });

    expect(await storage.resolveNode({ name: 'widget', scope: THREAD })).toMatchObject({ id: narrow.id });
    expect(await storage.resolveNode({ name: 'Widget', scope: ORG })).toMatchObject({ id: broad.id });
    expect(await storage.resolveNode({ name: 'Widget', scope: ['org:other'] })).toBeNull();
  });

  it('resolves a merged alias to its terminal node', async () => {
    const broad = await storage.createNode({ name: 'Widget', kind: 'entity', scope: ORG });
    const narrow = await storage.createNode({ name: 'Widget', kind: 'entity', scope: ORG_DB });

    await storage.mergeNodes({ sourceId: narrow.id, targetId: broad.id, sourceVersion: 1 });

    expect((await storage.getNode(narrow.id))?.mergedInto).toBe(broad.id);
    expect(await storage.resolveNode({ name: 'Widget', scope: THREAD })).toMatchObject({ id: broad.id });
  });
});

describe('updateNode', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  it('applies a compare-and-set update and rejects a stale version', async () => {
    const created = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });

    const updated = await storage.updateNode({
      id: created.id,
      version: 1,
      content: 'new body',
      description: 'new summary',
      kind: 'topic',
    });

    expect(updated).toMatchObject({ id: created.id, version: 2, content: 'new body', description: 'new summary' });
    expect(updated.kind).toBe('topic');
    expect(await storage.getNode(created.id)).toEqual(updated);

    await expect(storage.updateNode({ id: created.id, version: 1, content: 'stale' })).rejects.toBeInstanceOf(
      KnowledgeConflictError,
    );
    expect((await storage.getNode(created.id))?.version).toBe(2);
  });

  it('rejects a rename that collides in the target scope and keeps the node unchanged', async () => {
    await storage.createNode({ name: 'Beta', kind: 'entity', scope: ORG });
    const alpha = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });

    await expect(storage.updateNode({ id: alpha.id, version: 1, name: 'beta' })).rejects.toThrow(
      'Knowledge node already exists in scope: beta',
    );

    expect(await storage.getNode(alpha.id)).toMatchObject({ name: 'Alpha', version: 1 });
  });

  it('renames within the same scope and re-keys the node', async () => {
    const alpha = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });

    await storage.updateNode({ id: alpha.id, version: 1, name: 'Gamma' });

    expect(await storage.getNodeByName({ name: 'Alpha', scope: ORG })).toBeNull();
    expect(await storage.getNodeByName({ name: 'Gamma', scope: ORG })).toMatchObject({ id: alpha.id, version: 2 });
  });

  it('rejects updating a merged node', async () => {
    const source = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG_DB });
    const target = await storage.createNode({ name: 'Omega', kind: 'entity', scope: ORG });
    await storage.mergeNodes({ sourceId: source.id, targetId: target.id, sourceVersion: 1 });

    await expect(storage.updateNode({ id: source.id, version: 2, content: 'x' })).rejects.toThrow(
      'Cannot update merged knowledge node',
    );
  });

  it('enqueues a delete for the old scope and an upsert for the new one on a scope change', async () => {
    const created = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    await storage.updateNode({ id: created.id, version: 1, scope: ORG_DB });

    const entries = storage.connection.query(
      `MATCH (entry:KOutbox {documentId: $documentId}) RETURN entry.operation AS operation, entry.scope AS scope`,
      {
        documentId: `knowledge:node:${created.id}`,
      },
    ).rows;
    expect(entries.map(row => row.operation).sort()).toEqual(['delete', 'upsert', 'upsert']);
    expect(entries.filter(row => row.operation === 'delete')).toEqual([expect.objectContaining({ scope: ORG })]);
    expect(entries.filter(row => row.operation === 'upsert').map(row => row.scope)).toContainEqual(ORG_DB);
  });
});

describe('mergeNodes', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  it('merges into the terminal of a chain and re-points an already merged source', async () => {
    const first = await storage.createNode({ name: 'First', kind: 'entity', scope: ORG_DB });
    const second = await storage.createNode({ name: 'Second', kind: 'entity', scope: ORG_DB });
    const third = await storage.createNode({ name: 'Third', kind: 'entity', scope: ORG });

    await storage.mergeNodes({ sourceId: first.id, targetId: second.id, sourceVersion: 1 });
    const mergedIntoThird = await storage.mergeNodes({ sourceId: second.id, targetId: third.id, sourceVersion: 1 });

    expect(mergedIntoThird.id).toBe(third.id);
    expect((await storage.getNode(first.id))?.mergedInto).toBe(second.id);
    expect(await storage.resolveNode({ name: 'First', scope: ORG_DB })).toMatchObject({ id: third.id });

    const remerged = await storage.mergeNodes({ sourceId: first.id, targetId: second.id, sourceVersion: 2 });
    expect(remerged.id).toBe(third.id);
    expect(await storage.getNode(first.id)).toMatchObject({ mergedInto: third.id, version: 3 });
  });

  it('rejects a stale source version, a narrower target and a self merge', async () => {
    const broad = await storage.createNode({ name: 'Broad', kind: 'entity', scope: ORG_DB });
    const narrow = await storage.createNode({ name: 'Narrow', kind: 'entity', scope: THREAD });

    await expect(
      storage.mergeNodes({ sourceId: broad.id, targetId: narrow.id, sourceVersion: 2 }),
    ).rejects.toBeInstanceOf(KnowledgeConflictError);
    await expect(storage.mergeNodes({ sourceId: broad.id, targetId: narrow.id, sourceVersion: 1 })).rejects.toThrow(
      'narrower than its source scope',
    );
    await expect(storage.mergeNodes({ sourceId: broad.id, targetId: broad.id, sourceVersion: 1 })).rejects.toThrow(
      'Cannot merge a knowledge node into itself',
    );
  });

  it('adopts the source description only when the target never had one', async () => {
    const source = await storage.createNode({
      name: 'Source',
      kind: 'entity',
      scope: ORG_DB,
      description: 'source summary',
    });
    const blank = await storage.createNode({ name: 'Blank', kind: 'entity', scope: ORG });
    const written = await storage.createNode({
      name: 'Written',
      kind: 'entity',
      scope: ORG,
      description: 'kept summary',
    });
    const explicitClear = await storage.createNode({ name: 'Cleared', kind: 'entity', scope: ORG, description: '' });

    const adopted = await storage.mergeNodes({ sourceId: source.id, targetId: blank.id, sourceVersion: 1 });
    expect(adopted).toMatchObject({ description: 'source summary', version: 2 });

    const kept = await storage.mergeNodes({ sourceId: source.id, targetId: written.id, sourceVersion: 2 });
    expect(kept).toMatchObject({ description: 'kept summary', version: 1 });

    const cleared = await storage.mergeNodes({ sourceId: source.id, targetId: explicitClear.id, sourceVersion: 3 });
    expect(cleared.description).toBe('');
  });

  it('records activity and deduplicated outbox entries for every mutation', async () => {
    const source = await storage.createNode({ name: 'Source', kind: 'entity', scope: ORG_DB, description: 'd' });
    const target = await storage.createNode({ name: 'Target', kind: 'entity', scope: ORG });
    await storage.updateNode({ id: target.id, version: 1, content: 'body' });
    await storage.mergeNodes({ sourceId: source.id, targetId: target.id, sourceVersion: 1 });

    const actions = storage.connection
      .query(`MATCH (event:KActivity) RETURN event.action AS action, event.recordId AS recordId`)
      .rows.map(row => `${row.action}:${row.recordId}`);
    expect(actions).toContain(`node-created:${source.id}`);
    expect(actions).toContain(`node-updated:${target.id}`);
    expect(actions).toContain(`node-merged:${source.id}`);

    const outbox = storage.connection
      .query(`MATCH (entry:KOutbox) RETURN entry.idempotencyKey AS key ORDER BY key`)
      .rows.map(row => row.key);
    expect(new Set(outbox).size).toBe(outbox.length);
    expect(outbox).toEqual(
      expect.arrayContaining([
        `knowledge:node:${source.id}:upsert:1`,
        `knowledge:node:${source.id}:delete:2`,
        `knowledge:node:${target.id}:upsert:2`,
      ]),
    );
  });
});
