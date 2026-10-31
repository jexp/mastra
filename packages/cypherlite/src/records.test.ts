import { KnowledgeNotFoundError } from '@mastra/core/storage';
import { beforeEach, describe, expect, it } from 'vitest';

import type { CypherLiteKnowledgeStorage } from './storage';
import { countRows, openStorage } from './test-support';

const ORG = ['org:acme'];
const ORG_DB = ['org:acme', 'resource:db'];
const THREAD = ['org:acme', 'resource:db', 'thread:t1'];

function activities(storage: CypherLiteKnowledgeStorage, recordId: string): string[] {
  return storage.connection
    .query(`MATCH (e:KActivity {recordId: $recordId}) RETURN e.action AS action`, { recordId })
    .rows.map(row => String(row.action))
    .sort();
}

describe('appendKnowledge', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  it('binds the record to the terminal node of a merge and keeps the node fresh', async () => {
    const broad = await storage.createNode({ name: 'Widget', kind: 'entity', scope: ORG });
    const narrow = await storage.createNode({ name: 'Widget', kind: 'entity', scope: ORG_DB });
    await storage.mergeNodes({ sourceId: narrow.id, targetId: broad.id, sourceVersion: 1 });
    storage.connection.query(`MATCH (n:KNode {id: $id}) SET n.updatedAt = 1000`, { id: broad.id });

    const record = await storage.appendKnowledge({
      node: narrow.id,
      text: 'Widget shipped.',
      scope: THREAD,
      sourceThreadId: 'thread-1',
      resolutionScope: THREAD,
      defaultScope: THREAD,
    });

    expect(record).toMatchObject({
      node: broad.id,
      text: 'Widget shipped.',
      scope: THREAD,
      sourceThreadId: 'thread-1',
    });
    expect(record.capturedAt).toBeInstanceOf(Date);
    expect(await storage.getKnowledge({ id: record.id })).toEqual(record);
    const updatedAt = storage.connection.query(`MATCH (n:KNode {id: $id}) RETURN n.updatedAt AS at`, { id: broad.id })
      .rows[0]?.at;
    expect(Number(updatedAt)).toBeGreaterThan(1000);
  });

  it('rejects over-long text and an unknown node without writing', async () => {
    const node = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });

    await expect(
      storage.appendKnowledge({
        node: node.id,
        text: 'x'.repeat(1001),
        scope: ORG,
        sourceThreadId: 'thread-1',
        resolutionScope: ORG,
        defaultScope: ORG,
      }),
    ).rejects.toThrow(/record text exceeds/);
    await expect(
      storage.appendKnowledge({
        node: 'missing',
        text: 'fact',
        scope: ORG,
        sourceThreadId: 'thread-1',
        resolutionScope: ORG,
        defaultScope: ORG,
      }),
    ).rejects.toBeInstanceOf(KnowledgeNotFoundError);
    expect(countRows(storage, `MATCH (r:KRecord) RETURN count(r) AS count`)).toBe(0);
  });

  it('derives MENTIONS from wikilinks, reusing visible nodes and creating missing ones', async () => {
    const alpha = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });

    const record = await storage.appendKnowledge({
      node: alpha.id,
      text: 'Met [[alpha]] and [[Beta]] and [[Alpha]] again.',
      scope: THREAD,
      sourceThreadId: 'thread-1',
      resolutionScope: THREAD,
      defaultScope: ORG_DB,
    });

    const mentioned = storage.connection
      .query(`MATCH (r:KRecord {id: $id})-[:MENTIONS]->(n:KNode) RETURN n.id AS id, n.name AS name, n.scope AS scope`, {
        id: record.id,
      })
      .rows.map(row => ({ id: String(row.id), name: String(row.name), scope: row.scope }));

    const beta = await storage.getNodeByName({ name: 'Beta', scope: ORG_DB });
    expect(beta).toMatchObject({ kind: 'node', scope: ORG_DB });
    // One edge per distinct name (case-insensitive), pointing at the visible Alpha and the new Beta.
    expect(mentioned).toHaveLength(2);
    expect(mentioned).toEqual(
      expect.arrayContaining([
        { id: alpha.id, name: 'Alpha', scope: ORG },
        { id: beta!.id, name: 'Beta', scope: ORG_DB },
      ]),
    );
  });

  it('persists optional when and metadata through a round trip', async () => {
    const node = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const when = new Date('2026-01-02T03:04:05.000Z');

    const record = await storage.appendKnowledge({
      node: node.id,
      text: 'fact',
      scope: ORG,
      sourceThreadId: 'thread-1',
      when,
      metadata: { reason: 'explicit', nested: { level: 2 } },
      resolutionScope: ORG,
      defaultScope: ORG,
    });

    expect((await storage.getKnowledge({ id: record.id }))?.when).toEqual(when);
    expect((await storage.getKnowledge({ id: record.id }))?.metadata).toEqual({
      reason: 'explicit',
      nested: { level: 2 },
    });
  });

  it('records a record-created activity and an upsert outbox entry', async () => {
    const node = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const record = await storage.appendKnowledge({
      node: node.id,
      text: 'fact',
      scope: THREAD,
      sourceThreadId: 'thread-1',
      resolutionScope: THREAD,
      defaultScope: THREAD,
    });

    expect(activities(storage, record.id)).toEqual(['record-created']);
    const entry = storage.connection.query(
      `MATCH (o:KOutbox {documentId: $documentId}) RETURN o.operation AS operation, o.scope AS scope`,
      {
        documentId: `knowledge:record:${record.id}`,
      },
    ).rows[0];
    expect(entry).toMatchObject({ operation: 'upsert', scope: THREAD });
  });
});

describe('record queries', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  async function seed() {
    const alpha = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const beta = await storage.createNode({ name: 'Beta', kind: 'entity', scope: ORG });
    const aboutAlpha = await storage.appendKnowledge({
      node: alpha.id,
      text: 'Alpha fact mentioning [[Beta]].',
      scope: THREAD,
      sourceThreadId: 'thread-1',
      resolutionScope: THREAD,
      defaultScope: THREAD,
    });
    const aboutBeta = await storage.appendKnowledge({
      node: beta.id,
      text: 'Beta fact.',
      scope: THREAD,
      sourceThreadId: 'thread-1',
      resolutionScope: THREAD,
      defaultScope: THREAD,
    });
    const broadOnly = await storage.appendKnowledge({
      node: alpha.id,
      text: 'Alpha fact at org scope.',
      scope: ORG,
      sourceThreadId: 'thread-2',
      resolutionScope: ORG,
      defaultScope: ORG,
    });
    return { alpha, beta, aboutAlpha, aboutBeta, broadOnly };
  }

  it('splits about / mentioning / related by the reference semantics', async () => {
    const { alpha, aboutAlpha, aboutBeta, broadOnly } = await seed();

    expect((await storage.listKnowledgeAbout({ node: alpha.id, scope: ORG })).records.map(r => r.id)).toEqual([
      broadOnly.id,
    ]);
    expect((await storage.listKnowledgeMentioning({ node: alpha.id, scope: ORG })).records).toEqual([]);
    expect((await storage.listKnowledgeRelatedTo({ node: alpha.id, scope: ORG })).records.map(r => r.id)).toEqual([
      broadOnly.id,
    ]);

    const beta = await storage.getNodeByName({ name: 'Beta', scope: ORG });
    expect((await storage.listKnowledgeMentioning({ node: beta!.id, scope: THREAD })).records.map(r => r.id)).toEqual([
      aboutAlpha.id,
    ]);
    expect((await storage.listKnowledgeAbout({ node: beta!.id, scope: THREAD })).records.map(r => r.id)).toEqual([
      aboutBeta.id,
    ]);
    expect((await storage.listKnowledgeRelatedTo({ node: beta!.id, scope: THREAD })).records.map(r => r.id)).toEqual([
      aboutBeta.id,
      aboutAlpha.id,
    ]);
  });

  it('pages newest-first with an exclusive after cursor', async () => {
    const { alpha, aboutAlpha, broadOnly } = await seed();

    const first = await storage.listKnowledgeRelatedTo({ node: alpha.id, scope: THREAD, limit: 1 });
    expect(first.records.map(r => r.id)).toEqual([broadOnly.id]);
    expect(first.nextCursor).toBe(broadOnly.id);

    const second = await storage.listKnowledgeRelatedTo({
      node: alpha.id,
      scope: THREAD,
      limit: 1,
      after: first.nextCursor,
    });
    expect(second.records.map(r => r.id)).toEqual([aboutAlpha.id]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('filters records by scope visibility', async () => {
    const { alpha, aboutAlpha, broadOnly } = await seed();

    // An org-scoped record is visible to a thread query, but a thread-scoped record is not visible
    // to an org query.
    const orgOnly = await storage.listKnowledgeAbout({ node: alpha.id, scope: ORG });
    expect(orgOnly.records.map(r => r.id)).toEqual([broadOnly.id]);

    const threadScoped = await storage.listKnowledgeAbout({ node: alpha.id, scope: THREAD });
    expect(threadScoped.records.map(r => r.id)).toEqual([broadOnly.id, aboutAlpha.id]);
  });

  it('returns an empty page for a node that does not exist', async () => {
    expect(await storage.listKnowledgeAbout({ node: 'missing', scope: THREAD })).toEqual({ records: [] });
  });

  it('reads a source oldest-first with an after cursor', async () => {
    const alpha = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const first = await storage.appendKnowledge({
      node: alpha.id,
      text: 'one',
      scope: ORG,
      sourceThreadId: 'thread-1',
      resolutionScope: ORG,
      defaultScope: ORG,
    });
    const second = await storage.appendKnowledge({
      node: alpha.id,
      text: 'two',
      scope: ORG,
      sourceThreadId: 'thread-1',
      resolutionScope: ORG,
      defaultScope: ORG,
    });
    await storage.appendKnowledge({
      node: alpha.id,
      text: 'other thread',
      scope: ORG,
      sourceThreadId: 'thread-2',
      resolutionScope: ORG,
      defaultScope: ORG,
    });

    const page = await storage.knowledgeBySource({ sourceThreadId: 'thread-1', scope: ORG, limit: 1 });
    expect(page.records.map(r => r.id)).toEqual([first.id]);
    expect(page.nextCursor).toBe(first.id);

    const next = await storage.knowledgeBySource({
      sourceThreadId: 'thread-1',
      scope: ORG,
      limit: 1,
      after: page.nextCursor,
    });
    expect(next.records.map(r => r.id)).toEqual([second.id]);
    expect(next.nextCursor).toBeUndefined();
  });
});

describe('soft delete, restore and rescope', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  async function seedRecord() {
    const alpha = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const beta = await storage.createNode({ name: 'Beta', kind: 'entity', scope: ORG });
    const record = await storage.appendKnowledge({
      node: alpha.id,
      text: 'Alpha mentions [[Beta]].',
      scope: THREAD,
      sourceThreadId: 'thread-1',
      resolutionScope: THREAD,
      defaultScope: THREAD,
    });
    return { alpha, beta, record };
  }

  it('toggles the Deleted label and attributes, hiding the record unless includeDeleted', async () => {
    const { record } = await seedRecord();

    const removed = await storage.removeKnowledge({ id: record.id, deletedBy: 'curator' });
    expect(removed.deletedBy).toBe('curator');
    expect(removed.deletedAt).toBeInstanceOf(Date);
    expect(await storage.getKnowledge({ id: record.id })).toBeNull();
    expect(await storage.getKnowledge({ id: record.id, includeDeleted: true })).toEqual(removed);
    expect(countRows(storage, `MATCH (r:KRecord:Deleted {id: $id}) RETURN count(r) AS count`, { id: record.id })).toBe(
      1,
    );

    // A second remove is a no-op and does not emit a second event.
    expect(await storage.removeKnowledge({ id: record.id, deletedBy: 'other' })).toEqual(removed);

    const restored = await storage.restoreKnowledge({ id: record.id });
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.deletedBy).toBeUndefined();
    expect(await storage.getKnowledge({ id: record.id })).toEqual(restored);
    expect(countRows(storage, `MATCH (r:KRecord:Deleted {id: $id}) RETURN count(r) AS count`, { id: record.id })).toBe(
      0,
    );
    expect(activities(storage, record.id)).toEqual(['record-created', 'record-deleted', 'record-restored']);
  });

  it('keeps MENTIONS edges across delete and restore', async () => {
    const { beta, record } = await seedRecord();
    const mentionCount = () =>
      countRows(storage, `MATCH (:KRecord {id: $id})-[:MENTIONS]->(:KNode) RETURN count(*) AS count`, {
        id: record.id,
      });

    expect(mentionCount()).toBe(1);
    await storage.removeKnowledge({ id: record.id, deletedBy: 'curator' });

    expect(mentionCount()).toBe(1);
    expect((await storage.listKnowledgeMentioning({ node: beta.id, scope: THREAD })).records).toEqual([]);
    expect(
      (await storage.listKnowledgeMentioning({ node: beta.id, scope: THREAD, includeDeleted: true })).records.map(
        r => r.id,
      ),
    ).toEqual([record.id]);

    await storage.restoreKnowledge({ id: record.id });
    expect(mentionCount()).toBe(1);
    expect((await storage.listKnowledgeMentioning({ node: beta.id, scope: THREAD })).records.map(r => r.id)).toEqual([
      record.id,
    ]);
  });

  it('enqueues a delete keyed by the deletion time', async () => {
    const { record } = await seedRecord();
    const removed = await storage.removeKnowledge({ id: record.id, deletedBy: 'curator' });

    const keys = storage.connection
      .query(`MATCH (o:KOutbox {documentId: $documentId}) RETURN o.idempotencyKey AS key, o.operation AS operation`, {
        documentId: `knowledge:record:${record.id}`,
      })
      .rows.map(row => ({ key: String(row.key), operation: String(row.operation) }));

    expect(keys).toEqual(
      expect.arrayContaining([
        { key: `knowledge:record:${record.id}:delete:${removed.deletedAt!.toISOString()}`, operation: 'delete' },
      ]),
    );
  });

  it('rescopes the stored scope list and enqueues the old-scope delete plus the new upsert', async () => {
    const { record } = await seedRecord();

    const rescoped = await storage.rescopeKnowledge({ id: record.id, scope: ORG_DB });

    expect(rescoped.scope).toEqual(ORG_DB);
    expect(await storage.getKnowledge({ id: record.id })).toEqual(rescoped);
    const scopeKey = storage.connection.query(`MATCH (r:KRecord {id: $id}) RETURN r.scopeKey AS scopeKey`, {
      id: record.id,
    }).rows[0]?.scopeKey;
    expect(scopeKey).toBe(ORG_DB.join('\u001f'));

    const entries = storage.connection
      .query(`MATCH (o:KOutbox {documentId: $documentId}) RETURN o.operation AS operation, o.scope AS scope`, {
        documentId: `knowledge:record:${record.id}`,
      })
      .rows.map(row => ({ operation: String(row.operation), scope: row.scope }));
    expect(entries).toEqual(
      expect.arrayContaining([
        { operation: 'delete', scope: THREAD },
        { operation: 'upsert', scope: ORG_DB },
      ]),
    );
    expect(activities(storage, record.id)).toEqual(['record-created', 'record-rescoped']);
  });

  it('does not enqueue a delete when the scope key is unchanged', async () => {
    const { record } = await seedRecord();

    await storage.rescopeKnowledge({ id: record.id, scope: [...THREAD] });

    expect(
      countRows(storage, `MATCH (o:KOutbox {documentId: $documentId, operation: 'delete'}) RETURN count(o) AS count`, {
        documentId: `knowledge:record:${record.id}`,
      }),
    ).toBe(0);
  });

  it('only enqueues the old-scope delete when rescoping a deleted record', async () => {
    const { record } = await seedRecord();
    await storage.removeKnowledge({ id: record.id, deletedBy: 'curator' });
    const upsertsBefore = countRows(
      storage,
      `MATCH (o:KOutbox {documentId: $documentId, operation: 'upsert'}) RETURN count(o) AS count`,
      { documentId: `knowledge:record:${record.id}` },
    );

    await storage.rescopeKnowledge({ id: record.id, scope: ORG_DB });

    expect(
      countRows(storage, `MATCH (o:KOutbox {documentId: $documentId, operation: 'upsert'}) RETURN count(o) AS count`, {
        documentId: `knowledge:record:${record.id}`,
      }),
    ).toBe(upsertsBefore);
  });

  it('rejects remove, restore and rescope for an unknown record', async () => {
    await expect(storage.removeKnowledge({ id: 'missing', deletedBy: 'curator' })).rejects.toBeInstanceOf(
      KnowledgeNotFoundError,
    );
    await expect(storage.restoreKnowledge({ id: 'missing' })).rejects.toBeInstanceOf(KnowledgeNotFoundError);
    await expect(storage.rescopeKnowledge({ id: 'missing', scope: ORG })).rejects.toBeInstanceOf(
      KnowledgeNotFoundError,
    );
  });
});
