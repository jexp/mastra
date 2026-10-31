import { expandKnowledgeScope, knowledgeScopeKey, knowledgeVisibleScopeKeys } from '@mastra/core/storage';


import { beforeEach, describe, expect, it } from 'vitest';

import type { CypherLiteKnowledgeStorage } from './storage';
import { countNodes, openStorage } from './test-support';

// The scenarios of the reference suite in
// packages/core/src/storage/domains/knowledge/__tests__/scope.test.ts, driven through the adapter.
const context = ['thread:t1', 'org:o1', 'resource:r1'];

describe('knowledge scopes', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  it('canonicalizes and deduplicates ancestor chains on write', async () => {
    const node = await storage.createNode({ name: 'Widget', kind: 'entity', scope: [...context, 'org:o1'] });

    expect(node.scope).toEqual(['org:o1', 'resource:r1', 'thread:t1']);
    expect((await storage.getNode(node.id))?.scope).toEqual(node.scope);
    expect(
      await storage.getNodeByName({ name: 'widget', scope: ['resource:r1', 'org:o1', 'thread:t1'] }),
    ).toMatchObject({
      id: node.id,
    });
  });

  it('accepts opaque uncurated companion scopes without curated ancestors', async () => {
    const resourceCompanion = 'resource:r1:uncurated';
    const threadCompanion = 'thread:t1:uncurated';
    const threadOnly = await storage.createNode({ name: 'Thread finding', kind: 'note', scope: [threadCompanion] });
    const both = await storage.createNode({
      name: 'Resource finding',
      kind: 'note',
      scope: [threadCompanion, resourceCompanion],
    });

    expect(threadOnly.scope).toEqual([threadCompanion]);
    expect(both.scope).toEqual([resourceCompanion, threadCompanion]);
    expect((await storage.listNodes({ scope: [threadCompanion] })).map(candidate => candidate.id)).toEqual([
      threadOnly.id,
    ]);
    expect(await storage.listNodes({ scope: context })).toEqual([]);
    expect(
      (await storage.listNodes({ scope: [...context, resourceCompanion, threadCompanion] })).map(
        candidate => candidate.id,
      ),
    ).toEqual([both.id, threadOnly.id]);
  });

  it('expands a level from trusted conversation context', async () => {
    const orgNote = await storage.createNode({ name: 'Org note', kind: 'note', scope: ['org:o1'] });
    const resourceNote = await storage.createNode({
      name: 'Resource note',
      kind: 'note',
      scope: ['resource:r1', 'org:o1'],
    });
    const threadNote = await storage.createNode({ name: 'Thread note', kind: 'note', scope: [...context].reverse() });

    expect(expandKnowledgeScope(context, 'org')).toEqual(['org:o1']);
    expect(expandKnowledgeScope(context, 'resource')).toEqual(['org:o1', 'resource:r1']);
    expect(expandKnowledgeScope(context, 'thread')).toEqual(['org:o1', 'resource:r1', 'thread:t1']);
    expect(() => expandKnowledgeScope(['org:o1'], 'thread')).toThrow('context has no thread entry');

    // The adapter reads exactly the notes written at or above each expanded level.
    const visibleAt = async (level: 'org' | 'resource' | 'thread') =>
      (await storage.listNodes({ scope: expandKnowledgeScope(context, level) })).map(node => node.id).sort();
    expect(await visibleAt('org')).toEqual([orgNote.id]);
    expect(await visibleAt('resource')).toEqual([orgNote.id, resourceNote.id].sort());
    expect(await visibleAt('thread')).toEqual([orgNote.id, resourceNote.id, threadNote.id].sort());
  });

  it('enumerates persisted scope subsets including uncurated companions', async () => {
    const resourceCompanion = 'resource:r1:uncurated';
    const threadCompanion = 'thread:t1:uncurated';

    expect(knowledgeVisibleScopeKeys([...context, resourceCompanion, threadCompanion])).toEqual(
      expect.arrayContaining([
        knowledgeScopeKey(context),
        knowledgeScopeKey([resourceCompanion]),
        knowledgeScopeKey([threadCompanion]),
        knowledgeScopeKey([resourceCompanion, threadCompanion]),
      ]),
    );

    // Every subset a caller can persist is readable from the full conversation context.
    const companionOnly = await storage.createNode({
      name: 'Resource companion',
      kind: 'note',
      scope: [resourceCompanion],
    });
    const threadOnly = await storage.createNode({ name: 'Thread companion', kind: 'note', scope: [threadCompanion] });
    const both = await storage.createNode({
      name: 'Both companions',
      kind: 'note',
      scope: [threadCompanion, resourceCompanion],
    });
    const curated = await storage.createNode({ name: 'Curated note', kind: 'note', scope: context });

    expect(
      (await storage.listNodes({ scope: [...context, resourceCompanion, threadCompanion] }))
        .map(node => node.id)
        .sort(),
    ).toEqual([companionOnly.id, threadOnly.id, both.id, curated.id].sort());
  });

  it('uses subset visibility and excludes sibling scopes', async () => {
    const org = await storage.createNode({ name: 'Org note', kind: 'note', scope: ['org:o1'] });
    const resource = await storage.createNode({
      name: 'Resource note',
      kind: 'note',
      scope: ['org:o1', 'resource:r1'],
    });
    const sibling = await storage.createNode({
      name: 'Sibling note',
      kind: 'note',
      scope: ['org:o1', 'resource:r2'],
    });

    const visible = (await storage.listNodes({ scope: context })).map(node => node.id);
    expect(visible.sort()).toEqual([org.id, resource.id].sort());
    expect(visible).not.toContain(sibling.id);
  });

  it('rejects malformed, partial and cross-chain scopes without writing', async () => {
    const invalid: [string[], string][] = [
      [[], 'cannot be empty'],
      [['thread:t1'], 'requires resource and org ancestors'],
      [['resource:r1'], 'requires an org ancestor'],
      [['org:o1', 'org:o2'], 'multiple org entries'],
      [[`org:o1${String.fromCharCode(31)}resource:r1`], 'Invalid knowledge scope entry'],
      [['tenant:t1'], 'Invalid knowledge scope entry'],
    ];

    for (const [scope, message] of invalid) {
      await expect(storage.createNode({ name: 'Rejected', kind: 'note', scope })).rejects.toThrow(message);
    }
    expect(countNodes(storage)).toBe(0);
  });
});
