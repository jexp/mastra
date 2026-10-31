import { beforeEach, describe, expect, it } from 'vitest';

import { storeScope } from './scope';
import type { CypherLiteKnowledgeStorage } from './storage';
import { openStorage } from './test-support';

const ORG = ['org:acme'];
const RESOURCE = ['org:acme', 'resource:db'];
const OTHER_RESOURCE = ['org:acme', 'resource:other'];
const THREAD = ['org:acme', 'resource:db', 'thread:t1'];

describe('knowledge activity', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  it('records node activity and reads it newest first with an after cursor', async () => {
    const first = await storage.createNode({ name: 'One', kind: 'task', scope: RESOURCE });
    const second = await storage.createNode({ name: 'Two', kind: 'task', scope: RESOURCE });
    await storage.updateNode({ id: second.id, version: second.version, kind: 'project' });

    const all = await storage.listActivity({ scope: THREAD });
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ action: 'node-updated', recordType: 'node', recordId: second.id, scope: RESOURCE });
    expect(all[0]?.createdAt).toBeInstanceOf(Date);
    expect(all.map(event => event.id)).toEqual([...all.map(event => event.id)].sort().reverse());

    const page = await storage.listActivity({ scope: THREAD, limit: 2 });
    expect(page.map(event => event.id)).toEqual(all.slice(0, 2).map(event => event.id));

    const next = await storage.listActivity({ scope: THREAD, after: page.at(-1)!.id, limit: 2 });
    expect(next.map(event => event.id)).toEqual(all.slice(2).map(event => event.id));
    expect(next.map(event => event.recordId)).toEqual([first.id]);
  });

  it('keeps thread and import provenance on the event', async () => {
    const node = await storage.createNode({ name: 'Imported', kind: 'task', scope: RESOURCE });
    const { scope, scopeKey } = storeScope(RESOURCE);
    storage.connection.query(
      `CREATE (event:KActivity {
         id: 'event-1', action: 'record-created', recordType: 'record', recordId: $recordId,
         scope: $scope, scopeKey: $scopeKey, createdAt: $now, sourceThreadId: 't1', importRunId: 'run-1'
       })`,
      { recordId: node.id, scope, scopeKey, now: Date.now() },
    );

    expect((await storage.listActivity({ scope: THREAD }))[0]).toEqual({
      id: 'event-1',
      action: 'record-created',
      recordType: 'record',
      recordId: node.id,
      scope: RESOURCE,
      sourceThreadId: 't1',
      importRunId: 'run-1',
      createdAt: expect.any(Date),
    });
  });

  it('filters by scope visibility and defaults to a hundred events', async () => {
    await storage.createNode({ name: 'Visible', kind: 'task', scope: RESOURCE });
    await storage.createNode({ name: 'Hidden', kind: 'task', scope: OTHER_RESOURCE });

    expect((await storage.listActivity({ scope: THREAD })).map(event => event.recordId)).toHaveLength(1);
    expect(await storage.listActivity({ scope: ORG })).toEqual([]);

    for (let index = 0; index < 120; index++) {
      await storage.createNode({ name: `Bulk ${index}`, kind: 'task', scope: RESOURCE });
    }
    expect(await storage.listActivity({ scope: THREAD })).toHaveLength(100);
  });
});
