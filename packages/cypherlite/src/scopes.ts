import { randomUUID } from 'node:crypto';

import {
  pageKnowledgeScopeMembers,
  pageKnowledgeScopeNodes,
  parseListKnowledgeScopeMembersInput,
  parseListKnowledgeScopeNodesInput,
} from '@mastra/core/storage';
import type {
  KnowledgeScopeMember,
  KnowledgeScopeNodeSummary,
  KnowledgeStructurePlan,
  KnowledgeStructureReconcileResult,
  ListKnowledgeScopeMembersInput,
  ListKnowledgeScopeMembersOutput,
  ListKnowledgeScopeNodesInput,
  ListKnowledgeScopeNodesOutput,
} from '@mastra/core/storage';

import type { AdapterContext, AdapterRow } from './connection';
import { projectColumns } from './connection';
import { KNOWLEDGE_EDGES } from './edges';
import { NODE_PROPERTIES, toKnowledgeNode } from './nodes';
import { KNOWLEDGE_LABELS, KNOWLEDGE_META_ID } from './schema';

const { node: NODE_LABEL, scope: SCOPE_LABEL } = KNOWLEDGE_LABELS;

/** A structural scope as stored: its node id and whether it was removed. */
interface StoredScopeNode {
  id: string;
  /** Epoch millis when the scope was removed, `null` while it is live. Nothing in the contract removes scopes yet. */
  deletedAt: number | null;
}

function loadScope(ctx: AdapterContext, address: string): StoredScopeNode | null {
  const row = ctx.run(`MATCH (s:${SCOPE_LABEL} {address: $address}) RETURN s.id AS id, s.deletedAt AS deletedAt`, {
    address,
  })[0];
  if (!row) return null;
  return {
    id: String(row.id),
    deletedAt: row.deletedAt === null || row.deletedAt === undefined ? null : Number(row.deletedAt),
  };
}

function hasScopeEdge(ctx: AdapterContext, type: string, fromId: string, toId: string): boolean {
  return (
    ctx.run(`MATCH (a:${SCOPE_LABEL} {id: $fromId})-[:${type}]->(b:${SCOPE_LABEL} {id: $toId}) RETURN a.id AS id`, {
      fromId,
      toId,
    }).length > 0
  );
}

/**
 * Whether another child of `parentId` already carries `name`. Sibling names are unique per parent,
 * compared case-insensitively and ignoring surrounding whitespace.
 */
function hasSiblingScope(ctx: AdapterContext, parentId: string, name: string, scopeNodeId: string): boolean {
  return (
    ctx.run(
      `MATCH (sibling:${SCOPE_LABEL})-[:${KNOWLEDGE_EDGES.scopeParent}]->(parent:${SCOPE_LABEL} {id: $parentId})
       WHERE sibling.id <> $scopeNodeId AND toLower(trim(sibling.name)) = $nameLower
       RETURN sibling.id AS id
       LIMIT 1`,
      { parentId, scopeNodeId, nameLower: name.trim().toLocaleLowerCase() },
    ).length > 0
  );
}

/** The store-wide access epoch: bumped whenever reconciliation changes the structure. */
function readAccessEpoch(ctx: AdapterContext): number {
  const row = ctx.run(`MATCH (meta:${KNOWLEDGE_LABELS.meta} {id: $id}) RETURN meta.accessEpoch AS accessEpoch`, {
    id: KNOWLEDGE_META_ID,
  })[0];
  return typeof row?.accessEpoch === 'number' ? row.accessEpoch : 0;
}

function advanceAccessEpoch(ctx: AdapterContext): number {
  const accessEpoch = readAccessEpoch(ctx) + 1;
  ctx.run(`MATCH (meta:${KNOWLEDGE_LABELS.meta} {id: $id}) SET meta.accessEpoch = $accessEpoch`, {
    id: KNOWLEDGE_META_ID,
    accessEpoch,
  });
  return accessEpoch;
}

/**
 * Applies a plan additively: unknown addresses become `KScope` nodes, and `SCOPE_PARENT` /
 * `SCOPE_GRANT` edges the plan declares but storage lacks are added. Validation happens before the
 * matching edge is written, so a missing reference or a duplicate sibling name throws and the
 * enclosing transaction rolls every creation back.
 */
function reconcileStructureInTransaction(
  ctx: AdapterContext,
  plan: KnowledgeStructurePlan,
): KnowledgeStructureReconcileResult {
  const scopes: Record<string, string> = {};
  const createdScopeIds: string[] = [];
  const createdAddresses = new Set<string>();
  const addedParentEdges = new Set<string>();
  const addedGrantEdges = new Set<string>();
  const deletedScopeAddresses: string[] = [];
  const storedByAddress = new Map<string, StoredScopeNode>();
  const retrofit = plan.retrofit ?? true;
  const now = Date.now();

  for (const scope of plan.scopes) {
    const existing = loadScope(ctx, scope.address);
    if (existing) {
      scopes[scope.address] = existing.id;
      storedByAddress.set(scope.address, existing);
      if (existing.deletedAt !== null) deletedScopeAddresses.push(scope.address);
      continue;
    }
    const id = randomUUID();
    ctx.run(
      `CREATE (s:${SCOPE_LABEL} {
         id: $id, address: $address, name: $name, nameLower: $nameLower,
         kind: $kind, description: $description, createdAt: $now
       })`,
      {
        id,
        address: scope.address,
        name: scope.name,
        nameLower: scope.name.trim().toLocaleLowerCase(),
        kind: scope.kind ?? null,
        description: scope.description ?? null,
        now,
      },
    );
    scopes[scope.address] = id;
    createdAddresses.add(scope.address);
    createdScopeIds.push(id);
    storedByAddress.set(scope.address, { id, deletedAt: null });
  }
  // Plan addresses are already in the map; anything else a plan points at is read once.
  const lookupScope = (address: string) => storedByAddress.get(address) ?? loadScope(ctx, address);

  for (const scope of plan.scopes) {
    const stored = storedByAddress.get(scope.address)!;
    // A scope that already existed keeps the edges it was created with unless the plan retrofits.
    if (!createdAddresses.has(scope.address) && (!retrofit || stored.deletedAt !== null)) continue;
    const scopeNodeId = scopes[scope.address]!;

    for (const parentAddress of scope.parentAddresses ?? []) {
      const parent = lookupScope(parentAddress);
      const edgeExists = parent !== null && hasScopeEdge(ctx, KNOWLEDGE_EDGES.scopeParent, scopeNodeId, parent.id);
      if (!parent || (parent.deletedAt !== null && !edgeExists)) {
        throw new Error(`Knowledge parent scope does not exist: ${parentAddress}`);
      }
      if (parent.deletedAt !== null || edgeExists) continue;
      if (hasSiblingScope(ctx, parent.id, scope.name, scopeNodeId)) {
        throw new Error(`Knowledge scope name ${scope.name} already exists under ${parentAddress}`);
      }
      ctx.run(
        `MATCH (child:${SCOPE_LABEL} {id: $childId}), (parent:${SCOPE_LABEL} {id: $parentId})
         CREATE (child)-[:${KNOWLEDGE_EDGES.scopeParent}]->(parent)`,
        { childId: scopeNodeId, parentId: parent.id },
      );
      addedParentEdges.add(`${scopeNodeId}\u0000${parent.id}`);
    }

    for (const grant of scope.grants ?? []) {
      const granted = lookupScope(grant.scopeRefAddress);
      const edgeExists = granted !== null && hasScopeEdge(ctx, KNOWLEDGE_EDGES.scopeGrant, scopeNodeId, granted.id);
      if (!granted || (granted.deletedAt !== null && !edgeExists)) {
        throw new Error(`Knowledge grant scope does not exist: ${grant.scopeRefAddress}`);
      }
      if (granted.deletedAt !== null || edgeExists) continue;
      ctx.run(
        `MATCH (scope:${SCOPE_LABEL} {id: $scopeNodeId}), (granted:${SCOPE_LABEL} {id: $grantedId})
         CREATE (scope)-[:${KNOWLEDGE_EDGES.scopeGrant} {role: $role, canSuggest: $canSuggest}]->(granted)`,
        { scopeNodeId, grantedId: granted.id, role: grant.role, canSuggest: grant.canSuggest ?? null },
      );
      addedGrantEdges.add(`${scopeNodeId}\u0000${granted.id}`);
    }
  }

  const changed = createdScopeIds.length > 0 || addedParentEdges.size > 0 || addedGrantEdges.size > 0;
  return {
    scopes,
    createdScopeIds,
    deletedScopeAddresses,
    changed,
    accessEpoch: changed ? advanceAccessEpoch(ctx) : readAccessEpoch(ctx),
  };
}

function toScopeNodeSummary(row: AdapterRow): KnowledgeScopeNodeSummary {
  const summary: KnowledgeScopeNodeSummary = {
    id: String(row.id),
    address: String(row.address),
    name: String(row.name),
    parentIds: Array.isArray(row.parentIds) ? row.parentIds.map(String).sort() : [],
  };
  if (row.kind) summary.kind = String(row.kind);
  if (row.description) summary.description = String(row.description);
  return summary;
}

function listScopeNodesInStore(
  ctx: AdapterContext,
  input: ListKnowledgeScopeNodesInput = {},
): ListKnowledgeScopeNodesOutput {
  const { limit, after } = parseListKnowledgeScopeNodesInput(input);
  const where = [`s.deletedAt IS NULL`];
  const params: Record<string, unknown> = { rowLimit: limit + 1 };
  // Descendants follow `SCOPE_PARENT` from the child to its parent, so the subtree is the reverse path.
  let match = `MATCH (s:${SCOPE_LABEL})`;
  if (input.withinAddress !== undefined) {
    match = `MATCH path = (root:${SCOPE_LABEL} {address: $withinAddress})<-[:${KNOWLEDGE_EDGES.scopeParent}*0..]-(s:${SCOPE_LABEL})`;
    params.withinAddress = input.withinAddress;
    where.push('all(node IN nodes(path) WHERE node.deletedAt IS NULL)');
  }
  if (input.addresses) {
    where.push('s.address IN $addresses');
    params.addresses = [...input.addresses];
  }
  if (input.ids) {
    where.push('s.id IN $ids');
    params.ids = [...input.ids];
  }
  if (after) {
    where.push('(s.name > $afterName OR (s.name = $afterName AND s.id > $afterId))');
    params.afterName = after.name;
    params.afterId = after.id;
  }
  const rows = ctx.run(
    `${match}
     WHERE ${where.join(' AND ')}
     OPTIONAL MATCH (s)-[:${KNOWLEDGE_EDGES.scopeParent}]->(parent:${SCOPE_LABEL})
     WITH s, collect(DISTINCT parent.id) AS parentIds
     RETURN s.id AS id, s.address AS address, s.name AS name,
            s.kind AS kind, s.description AS description, parentIds
     ORDER BY s.name ASC, s.id ASC
     LIMIT $rowLimit`,
    params,
  );
  return pageKnowledgeScopeNodes(rows.map(toScopeNodeSummary), limit, input);
}

/** A child scope is a member of its parent scope but has no content scope of its own. */
function toScopeMember(row: AdapterRow): KnowledgeScopeMember {
  const member: KnowledgeScopeMember = {
    id: String(row.id),
    type: 'node',
    name: String(row.name),
    kind: row.kind ? String(row.kind) : '',
    scope: null,
    version: 1,
    createdAt: new Date(Number(row.createdAt)),
    updatedAt: new Date(Number(row.createdAt)),
  };
  if (row.description) member.description = String(row.description);
  return member;
}

/** Newest member first; equal timestamps fall back to name and then id, as the contract pages them. */
function compareScopeMembers(left: KnowledgeScopeMember, right: KnowledgeScopeMember): number {
  const byUpdatedAt = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (byUpdatedAt !== 0) return byUpdatedAt;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * The keyset predicate for one member source, in that source's own column names. Members order
 * newest first, then by name and id ascending, so a page continues strictly after the cursor.
 */
function afterMemberCursorPredicate(
  columns: { updatedAt: string; name: string; id: string },
  after: { updatedAt: Date; name: string; id: string } | null,
): { clause: string; params: Record<string, unknown> } {
  if (!after) return { clause: '', params: {} };
  const { updatedAt, name, id } = columns;
  return {
    clause: `AND (${updatedAt} < $afterUpdatedAt
       OR (${updatedAt} = $afterUpdatedAt AND (${name} > $afterName
       OR (${name} = $afterName AND ${id} > $afterId))))`,
    params: {
      afterUpdatedAt: after.updatedAt.getTime(),
      afterName: after.name,
      afterId: after.id,
    },
  };
}

function listScopeMembersInStore(
  ctx: AdapterContext,
  input: ListKnowledgeScopeMembersInput,
): ListKnowledgeScopeMembersOutput {
  const { limit, after } = parseListKnowledgeScopeMembersInput(input);
  // Each source returns the page size plus one row after the cursor, enough to merge the two.
  const rowsPerSource = limit + 1;
  const nodeCursor = afterMemberCursorPredicate({ updatedAt: 'n.updatedAt', name: 'n.name', id: 'n.id' }, after);
  const nodeRows = ctx.run(
    `MATCH (n:${NODE_LABEL})-[:${KNOWLEDGE_EDGES.inScope}]->(scope:${SCOPE_LABEL} {id: $scopeNodeId})
     WHERE NOT (n)-[:${KNOWLEDGE_EDGES.mergedInto}]->() ${nodeCursor.clause}
     RETURN ${projectColumns('n', NODE_PROPERTIES)}
     ORDER BY n.updatedAt DESC, n.name ASC, n.id ASC
     LIMIT $rowLimit`,
    { scopeNodeId: input.scopeNodeId, rowLimit: rowsPerSource, ...nodeCursor.params },
  );
  const scopeCursor = afterMemberCursorPredicate(
    { updatedAt: 'child.createdAt', name: 'child.name', id: 'child.id' },
    after,
  );
  const scopeRows = ctx.run(
    `MATCH (child:${SCOPE_LABEL})-[:${KNOWLEDGE_EDGES.scopeParent}]->(scope:${SCOPE_LABEL} {id: $scopeNodeId})
     WHERE child.deletedAt IS NULL ${scopeCursor.clause}
     RETURN child.id AS id, child.name AS name, child.kind AS kind,
            child.description AS description, child.createdAt AS createdAt
     ORDER BY child.createdAt DESC, child.name ASC, child.id ASC
     LIMIT $rowLimit`,
    { scopeNodeId: input.scopeNodeId, rowLimit: rowsPerSource, ...scopeCursor.params },
  );
  const members: KnowledgeScopeMember[] = [...nodeRows.map(toKnowledgeNode), ...scopeRows.map(toScopeMember)];
  const ordered = members.sort(compareScopeMembers).slice(0, rowsPerSource);
  return pageKnowledgeScopeMembers(ordered, limit, input);
}

export interface KnowledgeScopeDomain {
  reconcileStructure(plan: KnowledgeStructurePlan): Promise<KnowledgeStructureReconcileResult>;
  listScopeNodes(input?: ListKnowledgeScopeNodesInput): Promise<ListKnowledgeScopeNodesOutput>;
  listScopeMembers(input: ListKnowledgeScopeMembersInput): Promise<ListKnowledgeScopeMembersOutput>;
}

/** Structural scopes over the CypherLite graph; reconciliation is one transaction frame. */
export function createScopeDomain(ctx: AdapterContext): KnowledgeScopeDomain {
  return {
    async reconcileStructure(plan) {
      return ctx.transaction(() => reconcileStructureInTransaction(ctx, plan));
    },
    async listScopeNodes(input) {
      return listScopeNodesInStore(ctx, input);
    },
    async listScopeMembers(input) {
      return listScopeMembersInStore(ctx, input);
    },
  };
}
