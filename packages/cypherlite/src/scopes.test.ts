import { KnowledgeNotFoundError } from '@mastra/core/storage';
import { Database } from '@neo4j-labs/cypherlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { CypherLiteKnowledgeStorage } from './storage';
import { countNodes, openStorage, setUpdatedAt } from './test-support';

const ORG = ['org:acme'];
const ORG_DB = ['org:acme', 'resource:db'];

describe('reconcileStructure', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  it('creates scope nodes for unknown addresses and is additively idempotent', async () => {
    const plan = {
      scopes: [
        { address: 'org:acme', name: 'mastra' },
        { address: 'features', name: 'features', kind: 'domain', parentAddresses: ['org:acme'] },
        { address: 'features:memory', name: 'memory', description: 'Memory scope', parentAddresses: ['features'] },
      ],
    };

    const first = await storage.reconcileStructure(plan);
    expect(first.changed).toBe(true);
    expect(first.createdScopeIds).toHaveLength(3);
    expect(Object.keys(first.scopes)).toEqual(['org:acme', 'features', 'features:memory']);
    expect(first.deletedScopeAddresses).toEqual([]);
    expect(first.accessEpoch).toBe(1);

    const second = await storage.reconcileStructure(plan);
    expect(second).toMatchObject({
      scopes: first.scopes,
      createdScopeIds: [],
      deletedScopeAddresses: [],
      changed: false,
      accessEpoch: 1,
    });
    expect(countNodes(storage, 'KScope')).toBe(3);
  });

  it('keeps the access epoch across storage instances on the same database', async () => {
    const connection = Database.open(':memory:').connect();
    const first = new CypherLiteKnowledgeStorage({ connection });
    await first.init();
    const created = await first.reconcileStructure({ scopes: [{ address: 'org:acme', name: 'Acme' }] });

    const second = new CypherLiteKnowledgeStorage({ connection });
    const again = await second.reconcileStructure({ scopes: [{ address: 'org:acme', name: 'Acme' }] });

    expect(again).toMatchObject({ changed: false, createdScopeIds: [], accessEpoch: created.accessEpoch });
  });

  it('retrofits parent edges and grants added to an existing scope by default', async () => {
    const org = { address: 'org:acme', name: 'Acme' };
    const first = await storage.reconcileStructure({ scopes: [org, { address: 'team', name: 'Team' }] });

    const grown = await storage.reconcileStructure({
      scopes: [
        org,
        {
          address: 'team',
          name: 'Team',
          parentAddresses: ['org:acme'],
          grants: [{ scopeRefAddress: 'org:acme', role: 'readonly', canSuggest: true }],
        },
      ],
    });

    expect(grown).toMatchObject({
      createdScopeIds: [],
      changed: true,
      accessEpoch: first.accessEpoch + 1,
    });
    const team = (await storage.listScopeNodes({ addresses: ['team'] })).scopes[0];
    expect(team?.parentIds).toEqual([first.scopes['org:acme']]);
    const grants = storage.connection
      .query(
        `MATCH (:KScope {address: 'team'})-[grant:SCOPE_GRANT]->(:KScope {address: 'org:acme'}) RETURN grant.role AS role`,
      )
      .rows.map(row => row.role);
    expect(grants).toEqual(['readonly']);
  });

  it('keeps the edges of an existing scope when the plan does not retrofit', async () => {
    const org = { address: 'org:acme', name: 'Acme' };
    const project = { address: 'project:atlas', name: 'Atlas', parentAddresses: ['org:acme'] };
    await storage.reconcileStructure({ scopes: [org] });
    const created = await storage.reconcileStructure({ scopes: [org, project], retrofit: false });
    expect(created.createdScopeIds).toHaveLength(1);

    const rematerialized = await storage.reconcileStructure({
      scopes: [org, { ...project, grants: [{ scopeRefAddress: 'org:acme', role: 'readonly' }] }],
      retrofit: false,
    });
    expect(rematerialized).toMatchObject({ createdScopeIds: [], changed: false, accessEpoch: created.accessEpoch });
  });

  it('rejects a missing parent scope and rolls the whole plan back', async () => {
    await expect(
      storage.reconcileStructure({
        scopes: [
          { address: 'org:acme', name: 'Acme' },
          { address: 'project:atlas', name: 'Atlas', parentAddresses: ['missing'] },
        ],
      }),
    ).rejects.toThrow('Knowledge parent scope does not exist: missing');

    expect(countNodes(storage, 'KScope')).toBe(0);
    expect(await storage.listScopeNodes()).toEqual({ scopes: [], nextCursor: null });
    expect((await storage.reconcileStructure({ scopes: [{ address: 'org:acme', name: 'Acme' }] })).accessEpoch).toBe(1);
  });

  it('rejects a missing grant scope and rolls the whole plan back', async () => {
    await expect(
      storage.reconcileStructure({
        scopes: [
          { address: 'org:acme', name: 'Acme' },
          {
            address: 'team:a',
            name: 'A',
            parentAddresses: ['org:acme'],
            grants: [{ scopeRefAddress: 'missing', role: 'readonly' }],
          },
        ],
      }),
    ).rejects.toThrow('Knowledge grant scope does not exist: missing');

    expect(countNodes(storage, 'KScope')).toBe(0);
  });

  it('rejects a sibling with the same name under the same parent only', async () => {
    const plan = {
      scopes: [
        { address: 'org:acme', name: 'Acme' },
        { address: 'org:other', name: 'Other' },
        { address: 'team:a', name: 'A', parentAddresses: ['org:acme'] },
      ],
    };
    await storage.reconcileStructure(plan);

    await expect(
      storage.reconcileStructure({
        scopes: [...plan.scopes, { address: 'team:dup', name: 'a', parentAddresses: ['org:acme'] }],
      }),
    ).rejects.toThrow('Knowledge scope name a already exists under org:acme');
    expect((await storage.listScopeNodes({ addresses: ['team:dup'] })).scopes).toEqual([]);

    await expect(
      storage.reconcileStructure({
        scopes: [...plan.scopes, { address: 'team:b', name: 'A', parentAddresses: ['org:other'] }],
      }),
    ).resolves.toMatchObject({ changed: true, createdScopeIds: [expect.any(String)] });
  });
});

describe('listScopeNodes', () => {
  let storage: CypherLiteKnowledgeStorage;
  let ids: Record<string, string>;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
    ({ scopes: ids } = await storage.reconcileStructure({
      scopes: [
        { address: 'org:acme', name: 'Acme' },
        { address: 'team:a', name: 'A', parentAddresses: ['org:acme'] },
        { address: 'team:b', name: 'B', parentAddresses: ['org:acme'] },
        { address: 'project:p', name: 'P', parentAddresses: ['team:a', 'team:b'] },
        { address: 'org:other', name: 'Other' },
        { address: 'team:o', name: 'O', parentAddresses: ['org:other'] },
      ],
    }));
  });

  it('lists every scope node with its parent membership edges', async () => {
    const { scopes, nextCursor } = await storage.listScopeNodes();
    expect(nextCursor).toBeNull();
    expect(scopes.map(scope => scope.name)).toEqual(['A', 'Acme', 'B', 'O', 'Other', 'P']);
    // `project:p` hangs off two parents, so the subtree match reaches it once per path; each parent
    // still appears exactly once.
    expect(scopes.find(scope => scope.address === 'project:p')?.parentIds).toEqual(
      [ids['team:a'], ids['team:b']].sort(),
    );
    const org = scopes.find(scope => scope.address === 'org:acme')!;
    expect(org.parentIds).toEqual([]);
    expect(org).not.toHaveProperty('kind');
  });

  it('filters to one transitive subtree', async () => {
    const within = await storage.listScopeNodes({ withinAddress: 'org:acme' });
    expect(within.scopes.map(scope => scope.address)).toEqual(['team:a', 'org:acme', 'team:b', 'project:p']);
    expect(within.nextCursor).toBeNull();

    expect((await storage.listScopeNodes({ withinAddress: 'team:b' })).scopes.map(scope => scope.address)).toEqual([
      'team:b',
      'project:p',
    ]);
    expect(await storage.listScopeNodes({ withinAddress: 'missing' })).toEqual({ scopes: [], nextCursor: null });
  });

  it('filters by exact address and by id', async () => {
    expect((await storage.listScopeNodes({ addresses: ['team:o', 'missing'] })).scopes.map(scope => scope.id)).toEqual([
      ids['team:o'],
    ]);
    expect(
      (await storage.listScopeNodes({ withinAddress: 'org:acme', ids: [ids['project:p']!] })).scopes.map(
        scope => scope.address,
      ),
    ).toEqual(['project:p']);
  });

  it('pages name-ordered scopes with the contract cursor', async () => {
    const within = await storage.listScopeNodes({ withinAddress: 'org:acme' });
    expect(await storage.listScopeNodes({ withinAddress: 'org:acme', limit: Number.NaN })).toEqual(within);

    const first = await storage.listScopeNodes({ withinAddress: 'org:acme', limit: 3 });
    expect(first.scopes).toHaveLength(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await storage.listScopeNodes({ withinAddress: 'org:acme', limit: 3, cursor: first.nextCursor! });
    expect([...first.scopes, ...second.scopes]).toEqual(within.scopes);
    expect(second.nextCursor).toBeNull();

    await expect(storage.listScopeNodes({ withinAddress: 'org:other', cursor: first.nextCursor! })).rejects.toThrow(
      'does not match this query',
    );
    await expect(storage.listScopeNodes({ cursor: 'not-a-cursor' })).rejects.toThrow(
      'Invalid Knowledge scope node cursor.',
    );
  });
});

describe('listScopeMembers', () => {
  let storage: CypherLiteKnowledgeStorage;
  let scopes: Record<string, string>;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
    ({ scopes } = await storage.reconcileStructure({
      scopes: [
        { address: 'org:acme', name: 'mastra' },
        { address: 'features', name: 'features', kind: 'domain', parentAddresses: ['org:acme'] },
        { address: 'features:memory', name: 'memory', description: 'Memory scope', parentAddresses: ['features'] },
      ],
    }));
  });

  it('returns child scopes as members with a null content scope', async () => {
    expect(await storage.listScopeMembers({ scopeNodeId: scopes['org:acme']! })).toEqual({
      members: [
        expect.objectContaining({
          id: scopes['features'],
          type: 'node',
          name: 'features',
          kind: 'domain',
          scope: null,
        }),
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(await storage.listScopeMembers({ scopeNodeId: scopes['features']! })).toEqual({
      members: [
        expect.objectContaining({
          id: scopes['features:memory'],
          name: 'memory',
          kind: '',
          description: 'Memory scope',
        }),
      ],
      hasMore: false,
      nextCursor: null,
    });
    expect(await storage.listScopeMembers({ scopeNodeId: scopes['features:memory']! })).toEqual({
      members: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(await storage.listScopeMembers({ scopeNodeId: 'missing' })).toEqual({
      members: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  it('returns placed content nodes newest-first together with child scopes', async () => {
    const first = await storage.createNode({
      name: 'Deploy',
      kind: 'doc',
      scope: ORG_DB,
      scopeAddresses: ['features'],
    });
    const second = await storage.createNode({
      name: 'Release',
      kind: 'doc',
      scope: ORG,
      scopeAddresses: ['features'],
    });
    const now = Date.now();
    setUpdatedAt(storage, first.id, now + 1_000);
    setUpdatedAt(storage, second.id, now + 2_000);

    const { members } = await storage.listScopeMembers({ scopeNodeId: scopes['features']! });
    expect(members.map(member => member.name)).toEqual(['Release', 'Deploy', 'memory']);
    expect(members[0]).toMatchObject({ id: second.id, scope: ORG, kind: 'doc' });
    expect(members[1]).toMatchObject({ id: first.id, scope: ORG_DB });
    expect(members[2]).toMatchObject({ id: scopes['features:memory'], scope: null });
  });

  it('bounded-pages members with the contract cursor', async () => {
    await storage.reconcileStructure({
      scopes: [
        { address: 'org:acme', name: 'mastra' },
        { address: 'docs', name: 'docs', parentAddresses: ['org:acme'] },
      ],
    });

    const firstPage = await storage.listScopeMembers({ scopeNodeId: scopes['org:acme']!, limit: 1 });
    expect(firstPage.members).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await storage.listScopeMembers({
      scopeNodeId: scopes['org:acme']!,
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage).toMatchObject({ hasMore: false, nextCursor: null });
    expect([...firstPage.members, ...secondPage.members].map(member => member.name).sort()).toEqual([
      'docs',
      'features',
    ]);

    await expect(
      storage.listScopeMembers({ scopeNodeId: scopes['features']!, cursor: firstPage.nextCursor! }),
    ).rejects.toThrow('Knowledge scope member cursor does not match this query.');
    await expect(storage.listScopeMembers({ scopeNodeId: scopes['org:acme']!, limit: 2 })).resolves.toMatchObject({
      hasMore: false,
    });
  });

  it('pages every member of a scope across both member sources', async () => {
    const now = Date.now();
    for (const [index, name] of ['N1', 'N2', 'N3', 'N4'].entries()) {
      const node = await storage.createNode({ name, kind: 'doc', scope: ORG, scopeAddresses: ['org:acme'] });
      setUpdatedAt(storage, node.id, now + (index + 1) * 1_000);
    }

    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await storage.listScopeMembers({ scopeNodeId: scopes['org:acme']!, limit: 2, cursor });
      pages.push(page.members.map(member => member.name));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    // Five members at limit two: two pages of two and a last page of one, each continuing after the
    // cursor instead of losing rows to the per-source fetch bound.
    expect(pages).toEqual([['N4', 'N3'], ['N2', 'N1'], ['features']]);
  });

  it('leaves merged nodes out of the member list', async () => {
    const source = await storage.createNode({
      name: 'Draft',
      kind: 'doc',
      scope: ORG_DB,
      scopeAddresses: ['features'],
    });
    const target = await storage.createNode({ name: 'Final', kind: 'doc', scope: ORG, scopeAddresses: ['features'] });
    await storage.mergeNodes({ sourceId: source.id, targetId: target.id, sourceVersion: 1 });

    const { members } = await storage.listScopeMembers({ scopeNodeId: scopes['features']! });
    expect(members.map(member => member.id)).toEqual([target.id, scopes['features:memory']]);
  });
});

describe('structural placement', () => {
  let storage: CypherLiteKnowledgeStorage;

  beforeEach(async () => {
    storage = openStorage();
    await storage.init();
  });

  it('places a node in a reconciled scope and reads it back as a member', async () => {
    const { scopes } = await storage.reconcileStructure({ scopes: [{ address: 'features:memory', name: 'memory' }] });
    const node = await storage.createNode({
      name: 'Alpha',
      kind: 'entity',
      scope: ORG,
      scopeAddresses: ['features:memory'],
    });

    const { members } = await storage.listScopeMembers({ scopeNodeId: scopes['features:memory']! });
    expect(members).toEqual([expect.objectContaining({ id: node.id, name: 'Alpha', scope: ORG })]);
  });

  it('rejects an unknown or deleted scope address before writing the node', async () => {
    const { scopes } = await storage.reconcileStructure({ scopes: [{ address: 'features:memory', name: 'memory' }] });
    storage.connection.query(`MATCH (scope:KScope {id: $id}) SET scope.deletedAt = $deletedAt`, {
      id: scopes['features:memory'],
      deletedAt: Date.now(),
    });

    await expect(
      storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG, scopeAddresses: ['features:missing'] }),
    ).rejects.toBeInstanceOf(KnowledgeNotFoundError);
    await expect(
      storage.createNode({ name: 'Alpha', kind: 'entity', scope: ORG, scopeAddresses: ['features:memory'] }),
    ).rejects.toBeInstanceOf(KnowledgeNotFoundError);
    expect(countNodes(storage)).toBe(0);
  });
});
