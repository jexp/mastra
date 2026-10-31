import type { KnowledgeScope } from '@mastra/core/storage';
import { beforeEach, describe, expect, it } from 'vitest';

import { storeScope } from './scope';
import type { CypherLiteKnowledgeStorage } from './storage';
import { openStorage } from './test-support';

const ORG = ['org:acme'];
const RESOURCE = ['org:acme', 'resource:db'];
const OTHER_RESOURCE = ['org:acme', 'resource:other'];
const THREAD = ['org:acme', 'resource:db', 'thread:t1'];

let recordSequence = 0;

/** Inserts a record with the property layout the records domain writes. */
function createRecord(
  storage: CypherLiteKnowledgeStorage,
  record: { node: string; text: string; scope: KnowledgeScope; deletedAt?: number },
): string {
  const { scope, scopeKey } = storeScope(record.scope);
  const id = `record-${++recordSequence}`;
  storage.connection.query(
    `CREATE (r:KRecord {
       id: $id, node: $node, text: $text, scope: $scope, scopeKey: $scopeKey,
       sourceThreadId: 't1', capturedAt: $now, deletedAt: $deletedAt
     })`,
    { id, node: record.node, text: record.text, scope, scopeKey, now: Date.now(), deletedAt: record.deletedAt ?? null },
  );
  return id;
}

describe('knowledge search', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  it('matches name, kind, content and description as substrings and shapes node text', async () => {
    const named = await storage.createNode({ name: 'namehit node', kind: 'document', scope: RESOURCE });
    const kinded = await storage.createNode({ name: 'Kinded', kind: 'kindhit', scope: RESOURCE });
    const contained = await storage.createNode({
      name: 'Contained',
      kind: 'document',
      content: 'the contenthit body',
      scope: RESOURCE,
    });
    const described = await storage.createNode({
      name: 'Described',
      kind: 'document',
      content: 'plain body',
      description: 'findable deschit synopsis',
      scope: RESOURCE,
    });

    expect(await storage.search({ query: 'namehit', scope: RESOURCE })).toEqual([
      { type: 'node', id: named.id, recordId: named.id, name: 'namehit node', text: 'namehit node', scope: RESOURCE },
    ]);
    expect((await storage.search({ query: 'KINDHIT', scope: RESOURCE })).map(result => result.id)).toEqual([kinded.id]);
    expect((await storage.search({ query: 'contenthit', scope: RESOURCE })).map(result => result.id)).toEqual([
      contained.id,
    ]);
    expect(await storage.search({ query: 'deschit', scope: RESOURCE })).toEqual([
      {
        type: 'node',
        id: described.id,
        recordId: described.id,
        name: 'Described',
        text: 'Described\nfindable deschit synopsis\nplain body',
        scope: RESOURCE,
      },
    ]);
  });

  it('treats query metacharacters literally', async () => {
    const percent = await storage.createNode({ name: 'Literal% node', kind: 'document', scope: RESOURCE });
    const underscore = await storage.createNode({ name: 'Under_score node', kind: 'document', scope: RESOURCE });
    await storage.createNode({ name: 'LiteralX node', kind: 'document', scope: RESOURCE });
    await storage.createNode({ name: 'UnderXscore node', kind: 'document', scope: RESOURCE });

    expect((await storage.search({ query: '%', scope: RESOURCE })).map(result => result.id)).toEqual([percent.id]);
    expect((await storage.search({ query: '_', scope: RESOURCE })).map(result => result.id)).toEqual([underscore.id]);
  });

  it('skips merged nodes and nodes outside the caller scope', async () => {
    const target = await storage.createNode({ name: 'Visible zebra', kind: 'entity', scope: RESOURCE });
    const alias = await storage.createNode({ name: 'Alias zebra', kind: 'entity', scope: RESOURCE });
    await storage.mergeNodes({ sourceId: alias.id, targetId: target.id, sourceVersion: alias.version });
    const hidden = await storage.createNode({ name: 'Zebra hidden', kind: 'entity', scope: OTHER_RESOURCE });

    const results = await storage.search({ query: 'zebra', scope: RESOURCE });

    expect(results.map(result => result.id)).toEqual([target.id]);
    expect(results.map(result => result.id)).not.toContain(alias.id);
    expect(results.map(result => result.id)).not.toContain(hidden.id);
  });

  it('returns record hits under the parent name only when the parent is visible', async () => {
    const node = await storage.createNode({ name: 'Resource node', kind: 'task', scope: RESOURCE });
    const record = createRecord(storage, {
      node: node.id,
      text: 'organization-visible knowledge',
      scope: ORG,
    });

    expect(await storage.search({ query: 'organization-visible', scope: ORG })).toEqual([
      {
        type: 'record',
        id: record,
        recordId: record,
        name: '(private node)',
        text: 'organization-visible knowledge',
        scope: ORG,
      },
    ]);
    expect(await storage.search({ query: 'organization-visible', scope: THREAD })).toEqual([
      {
        type: 'record',
        id: record,
        recordId: node.id,
        name: 'Resource node',
        text: 'organization-visible knowledge',
        scope: ORG,
      },
    ]);
  });

  it('excludes deleted records and records whose parent node is gone', async () => {
    const node = await storage.createNode({ name: 'Parent', kind: 'task', scope: RESOURCE });
    const live = createRecord(storage, { node: node.id, text: 'zebra fact', scope: RESOURCE });
    createRecord(storage, { node: node.id, text: 'zebra fact deleted', scope: RESOURCE, deletedAt: Date.now() });
    createRecord(storage, { node: 'missing-node', text: 'zebra fact orphaned', scope: RESOURCE });

    expect(await storage.search({ query: 'zebra fact', scope: RESOURCE })).toEqual([
      {
        type: 'record',
        id: live,
        recordId: node.id,
        name: 'Parent',
        text: 'zebra fact',
        scope: RESOURCE,
      },
    ]);
  });

  it('resolves a merged parent to its terminal node', async () => {
    const target = await storage.createNode({ name: 'Terminal', kind: 'person', scope: RESOURCE });
    const alias = await storage.createNode({ name: 'Alias', kind: 'person', scope: RESOURCE });
    await storage.mergeNodes({ sourceId: alias.id, targetId: target.id, sourceVersion: alias.version });
    const record = createRecord(storage, { node: alias.id, text: 'zebra alias fact', scope: RESOURCE });

    expect(await storage.search({ query: 'zebra alias', scope: RESOURCE })).toEqual([
      { type: 'record', id: record, recordId: target.id, name: 'Terminal', text: 'zebra alias fact', scope: RESOURCE },
    ]);
  });

  it('fills the page with nodes first, then records, and defaults to twenty results', async () => {
    for (let index = 0; index < 21; index++) {
      await storage.createNode({ name: `Bulk zebra ${index}`, kind: 'entity', scope: RESOURCE });
    }
    const node = await storage.createNode({ name: 'Anchor', kind: 'task', scope: RESOURCE });
    const record = createRecord(storage, { node: node.id, text: 'zebra record', scope: RESOURCE });

    const page = await storage.search({ query: 'zebra', scope: RESOURCE });
    expect(page).toHaveLength(20);
    expect(page.every(result => result.type === 'node')).toBe(true);

    const mixed = await storage.search({ query: 'zebra record', scope: RESOURCE });
    expect(mixed.map(result => [result.type, result.id])).toEqual([['record', record]]);

    const limited = await storage.search({ query: 'zebra', scope: RESOURCE, limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('returns nothing for a blank query and rejects an invalid scope', async () => {
    await storage.createNode({ name: 'Alpha', kind: 'entity', scope: RESOURCE });

    expect(await storage.search({ query: '   ', scope: RESOURCE })).toEqual([]);
    await expect(storage.search({ query: 'alpha', scope: ['resource:db'] })).rejects.toThrow('requires an org');
  });
});
