import { beforeEach, describe, expect, it } from 'vitest';

import type { CypherLiteKnowledgeStorage } from './storage';
import { openStorage } from './test-support';

const ORG = ['org:acme'];
const RESOURCE = ['org:acme', 'resource:db'];
const OTHER_RESOURCE = ['org:acme', 'resource:search'];

describe('semantic outbox', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  it('lists entries oldest first and narrows by status and visible scope', async () => {
    const first = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const second = await storage.createNode({ name: 'Beta', kind: 'entity', scope: OTHER_RESOURCE });

    const all = await storage.listSemanticOutbox();
    expect(all.map(entry => entry.documentId)).toEqual([`knowledge:node:${first.id}`, `knowledge:node:${second.id}`]);
    expect(all[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      documentType: 'node',
      operation: 'upsert',
      scope: ORG,
      idempotencyKey: `knowledge:node:${first.id}:upsert:1`,
    });
    expect(all[0]?.availableAt).toBeInstanceOf(Date);
    expect(all[0]?.createdAt).toBeInstanceOf(Date);
    expect(all[0]?.claimedAt).toBeUndefined();
    expect(all[0]?.claimedBy).toBeUndefined();
    expect(all[0]?.completedAt).toBeUndefined();

    expect(await storage.listSemanticOutbox({ status: 'completed' })).toEqual([]);
    expect((await storage.listSemanticOutbox({ scope: RESOURCE })).map(entry => entry.documentId)).toEqual([
      `knowledge:node:${first.id}`,
    ]);
    expect((await storage.listSemanticOutbox({ limit: 1 })).map(entry => entry.documentId)).toEqual([
      `knowledge:node:${first.id}`,
    ]);
  });

  it('claims due entries, stamps the lease and counts the attempt', async () => {
    const node = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const now = new Date(Date.now() + 1_000);

    const claimed = await storage.claimSemanticOutbox({ workerId: 'worker-1', now });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      documentId: `knowledge:node:${node.id}`,
      status: 'processing',
      claimedBy: 'worker-1',
      claimedAt: now,
      attempts: 1,
    });
    expect(await storage.claimSemanticOutbox({ workerId: 'worker-2', now })).toEqual([]);
  });

  it('serializes successive versions of one document', async () => {
    const node = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    await storage.updateNode({ id: node.id, version: node.version, kind: 'project' });
    const versions = (await storage.listSemanticOutbox()).filter(
      entry => entry.documentId === `knowledge:node:${node.id}`,
    );
    expect(versions.length).toBeGreaterThan(1);

    const first = await storage.claimSemanticOutbox({ workerId: 'worker-1', limit: 10 });
    expect(first).toHaveLength(1);
    expect(first[0]?.documentId).toBe(`knowledge:node:${node.id}`);

    // The second version stays blocked while the first is unfinished.
    expect(await storage.claimSemanticOutbox({ workerId: 'worker-2', limit: 10 })).toEqual([]);

    await storage.completeSemanticOutbox({ ids: [first[0]!.id], workerId: 'worker-1' });
    const second = await storage.claimSemanticOutbox({ workerId: 'worker-2', limit: 10 });
    expect(second).toHaveLength(1);
    expect(second[0]?.documentId).toBe(first[0]?.documentId);
    expect(await storage.claimSemanticOutbox({ workerId: 'worker-3', limit: 10 })).toEqual([]);
  });

  it('reclaims a processing entry once its lease expired', async () => {
    await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const claimedAt = new Date(Date.now() + 1_000);
    await storage.claimSemanticOutbox({ workerId: 'worker-1', now: claimedAt, claimTimeoutMs: 5_000 });

    const early = await storage.claimSemanticOutbox({
      workerId: 'worker-2',
      now: new Date(claimedAt.getTime() + 4_999),
      claimTimeoutMs: 5_000,
    });
    expect(early).toEqual([]);

    const reclaimed = await storage.claimSemanticOutbox({
      workerId: 'worker-2',
      now: new Date(claimedAt.getTime() + 5_000),
      claimTimeoutMs: 5_000,
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ claimedBy: 'worker-2', attempts: 2, status: 'processing' });
  });

  it('claims only entries the caller scope can see', async () => {
    await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const hidden = await storage.createNode({ name: 'Beta', kind: 'entity', scope: OTHER_RESOURCE });

    const claimed = await storage.claimSemanticOutbox({ workerId: 'worker-1', scope: RESOURCE });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.documentId).not.toBe(`knowledge:node:${hidden.id}`);
    expect((await storage.listSemanticOutbox({ status: 'pending' })).map(entry => entry.documentId)).toEqual([
      `knowledge:node:${hidden.id}`,
    ]);
  });

  it('completes and releases only entries the worker holds', async () => {
    const node = await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const [claimed] = await storage.claimSemanticOutbox({ workerId: 'worker-1' });

    await storage.completeSemanticOutbox({ ids: [claimed!.id], workerId: 'worker-2' });
    const stillProcessing = await storage.listSemanticOutbox({ status: 'processing' });
    expect(stillProcessing.map(entry => entry.id)).toEqual([claimed!.id]);
    expect(stillProcessing[0]?.claimedBy).toBe('worker-1');
    expect(stillProcessing[0]?.completedAt).toBeUndefined();

    await storage.releaseSemanticOutbox({ ids: [claimed!.id], workerId: 'worker-2' });
    expect(await storage.listSemanticOutbox({ status: 'processing' })).toHaveLength(1);

    await storage.completeSemanticOutbox({ ids: [claimed!.id], workerId: 'worker-1' });
    const completed = await storage.listSemanticOutbox({ status: 'completed' });
    expect(completed).toEqual([
      expect.objectContaining({
        id: claimed!.id,
        documentId: `knowledge:node:${node.id}`,
        completedAt: expect.any(Date),
      }),
    ]);
  });

  it('releases an entry back to pending at the retry time', async () => {
    await storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG });
    const claimedAt = new Date(Date.now() + 1_000);
    const [claimed] = await storage.claimSemanticOutbox({ workerId: 'worker-1', now: claimedAt });
    const retryAt = new Date(claimedAt.getTime() + 60_000);

    await storage.releaseSemanticOutbox({ ids: [claimed!.id], workerId: 'worker-1', retryAt });

    const pending = await storage.listSemanticOutbox({ status: 'pending' });
    expect(pending).toEqual([expect.objectContaining({ id: claimed!.id, availableAt: retryAt, attempts: 1 })]);
    expect(pending[0]?.claimedAt).toBeUndefined();
    expect(pending[0]?.claimedBy).toBeUndefined();
    expect(
      await storage.claimSemanticOutbox({ workerId: 'worker-2', now: new Date(claimedAt.getTime() + 59_999) }),
    ).toEqual([]);
    const retried = await storage.claimSemanticOutbox({ workerId: 'worker-2', now: new Date(retryAt.getTime() + 1) });
    expect(retried).toEqual([expect.objectContaining({ id: claimed!.id, attempts: 2, claimedBy: 'worker-2' })]);
  });
});
