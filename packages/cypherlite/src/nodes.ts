import { randomUUID } from 'node:crypto';

import {
  assertKnowledgeDescriptionWithinBound,
  canonicalizeKnowledgeScope,
  createKnowledgeUlid,
  isKnowledgeScopeVisible,
  KnowledgeConflictError,
  KnowledgeNotFoundError,
  parseKnowledgeNodeCursor,
  parseKnowledgeWikilinks,
} from '@mastra/core/storage';
import type {
  CreateKnowledgeNodeInput,
  KnowledgeNode,
  KnowledgeScope,
  ListKnowledgeNodesInput,
  UpdateKnowledgeNodeInput,
} from '@mastra/core/storage';

import type { AdapterContext, AdapterRow } from './connection';
import { projectColumns } from './connection';
import { KNOWLEDGE_EDGES } from './edges';
import { enqueueSemanticOutbox, recordKnowledgeActivity } from './events';
import { KNOWLEDGE_LABELS } from './schema';
import { readScope, scopeVisibleTo, storeScope } from './scope';

const { node: NODE_LABEL, record: RECORD_LABEL, scope: SCOPE_LABEL } = KNOWLEDGE_LABELS;
const { inScope: IN_SCOPE_EDGE, mergedInto: MERGED_INTO_EDGE, mentions: MENTIONS_EDGE } = KNOWLEDGE_EDGES;

/** The stored `KnowledgeNode` properties every node projection reads, in contract order. */
export const NODE_PROPERTIES = [
  'id',
  'name',
  'kind',
  'content',
  'description',
  'scope',
  'version',
  'createdAt',
  'updatedAt',
] as const;

/** Full node projection, including the derived `mergedInto` (null for an unmerged node). */
const NODE_PROJECTION = projectColumns('n', NODE_PROPERTIES, ['merged.id AS mergedInto']);
/** Projection for statements that already know the row is not merged. */
const UNMERGED_PROJECTION = projectColumns('n', NODE_PROPERTIES);
const MERGED_EDGE = `OPTIONAL MATCH (n)-[:${MERGED_INTO_EDGE}]->(merged:${NODE_LABEL})`;

/**
 * Maps a row produced by {@link projectColumns} onto a `KnowledgeNode`. Time values are stored as
 * epoch milliseconds so comparisons and range scans stay integer math.
 */
export function toKnowledgeNode(row: AdapterRow): KnowledgeNode {
  const node: KnowledgeNode = {
    id: String(row.id),
    type: 'node',
    name: String(row.name),
    kind: String(row.kind),
    scope: readScope(row.scope),
    version: Number(row.version),
    createdAt: new Date(Number(row.createdAt)),
    updatedAt: new Date(Number(row.updatedAt)),
  };
  if (row.content !== null && row.content !== undefined) node.content = String(row.content);
  if (row.description !== null && row.description !== undefined) node.description = String(row.description);
  if (row.mergedInto !== null && row.mergedInto !== undefined) node.mergedInto = String(row.mergedInto);
  return node;
}

function loadNodeRow(ctx: AdapterContext, id: string): AdapterRow | null {
  return ctx.run(`MATCH (n:${NODE_LABEL} {id: $id}) ${MERGED_EDGE} RETURN ${NODE_PROJECTION}`, { id })[0] ?? null;
}

function loadNodeByKeyRow(ctx: AdapterContext, scopeKey: string, nameLower: string): AdapterRow | null {
  return (
    ctx.run(
      `MATCH (n:${NODE_LABEL} {scopeKey: $scopeKey, nameLower: $nameLower}) ${MERGED_EDGE} RETURN ${NODE_PROJECTION}`,
      { scopeKey, nameLower },
    )[0] ?? null
  );
}

/**
 * Resolves the terminal node of a `MERGED_INTO` chain. `*0..` covers a node that is already
 * terminal (including a node that was never merged); a chain with no terminal is a merge cycle,
 * which the in-memory reference rejects as well.
 */
export function loadTerminalRow(ctx: AdapterContext, id: string): AdapterRow | null {
  const terminal = ctx.run(
    `MATCH p = (n:${NODE_LABEL} {id: $id})-[:${MERGED_INTO_EDGE}*0..]->(terminal:${NODE_LABEL})
     WHERE NOT (terminal)-[:${MERGED_INTO_EDGE}]->()
     RETURN ${projectColumns('terminal', NODE_PROPERTIES)}, length(p) AS hops
     ORDER BY hops DESC
     LIMIT 1`,
    { id },
  )[0];
  if (terminal) return terminal;
  if (ctx.run(`MATCH (n:${NODE_LABEL} {id: $id}) RETURN n.id AS id`, { id }).length > 0) {
    throw new Error(`Knowledge merge cycle detected at ${id}`);
  }
  return null;
}

/**
 * Resolves a name narrow-to-broad inside an open transaction. Only visible nodes and merged aliases
 * (whose terminal may be visible) are candidates; the most specific visible scope wins. The records
 * domain calls this to turn wikilinks into nodes without opening a nested transaction.
 */
export function resolveNodeInTransaction(
  ctx: AdapterContext,
  input: { name: string; scope: KnowledgeScope },
): KnowledgeNode | null {
  const queryScope = canonicalizeKnowledgeScope(input.scope);
  const candidates = ctx.run(
    `MATCH (n:${NODE_LABEL} {nameLower: $nameLower})
     WHERE (n)-[:${MERGED_INTO_EDGE}]->() OR ${scopeVisibleTo('n')}
     RETURN n.id AS id`,
    { nameLower: input.name.trim().toLocaleLowerCase(), queryScope },
  );
  // An unmerged node outside the caller's scope resolves to itself and can never be visible,
  // so only visible nodes and merged aliases (whose terminal may be visible) are candidates.
  const visible: KnowledgeNode[] = [];
  for (const candidate of candidates) {
    const terminal = loadTerminalRow(ctx, String(candidate.id));
    if (!terminal) continue;
    const node = toKnowledgeNode(terminal);
    if (!isKnowledgeScopeVisible(node.scope, queryScope)) continue;
    visible.push(node);
  }
  visible.sort((left, right) => right.scope.length - left.scope.length);
  return visible[0] ?? null;
}

/**
 * Derives a document's `MENTIONS` edges from the `[[wikilinks]]` in its text, for a node's content
 * and a record's text alike. Each name resolves narrow-to-broad in `resolutionScope`, and a name no
 * visible node carries is materialized in `defaultScope`. `replaceExisting` drops the document's
 * previous edges first, which a node needs because its content changes and a record does not.
 * Runs inside the caller's transaction, so a resolution failure (an empty scope, say) rolls the
 * whole mutation back.
 */
export function syncMentions(
  ctx: AdapterContext,
  fromLabel: string,
  fromId: string,
  text: string,
  resolutionScope: KnowledgeScope,
  defaultScope: KnowledgeScope,
  replaceExisting: boolean,
): void {
  if (replaceExisting) {
    ctx.run(`MATCH (from:${fromLabel} {id: $fromId})-[mention:${MENTIONS_EDGE}]->() DELETE mention`, { fromId });
  }
  for (const name of parseKnowledgeWikilinks(text)) {
    const resolved = resolveNodeInTransaction(ctx, { name, scope: resolutionScope });
    const target = resolved ?? createNodeInTransaction(ctx, { name, kind: 'node', scope: defaultScope });
    ctx.run(
      `MATCH (from:${fromLabel} {id: $fromId}), (mentioned:${NODE_LABEL} {id: $targetId})
       MERGE (from)-[:${MENTIONS_EDGE}]->(mentioned)`,
      { fromId, targetId: target.id },
    );
  }
}

/** Validates structural placement addresses against live scope nodes before any write happens. */
function resolveScopePlacement(ctx: AdapterContext, addresses: string[] | undefined): string[] {
  if (!addresses || addresses.length === 0) return [];
  return addresses.map(address => {
    const scope = ctx.run(
      `MATCH (scope:${SCOPE_LABEL} {address: $address}) WHERE scope.deletedAt IS NULL RETURN scope.id AS id`,
      { address },
    )[0];
    if (!scope) throw new KnowledgeNotFoundError('scope', address);
    return String(scope.id);
  });
}

function placeInScopes(ctx: AdapterContext, nodeId: string, scopeIds: string[]): void {
  if (scopeIds.length === 0) return;
  ctx.run(
    `MATCH (n:${NODE_LABEL} {id: $nodeId})
     UNWIND $scopeIds AS scopeId
     MATCH (scope:${SCOPE_LABEL} {id: scopeId})
     MERGE (n)-[:${IN_SCOPE_EDGE}]->(scope)`,
    { nodeId, scopeIds },
  );
}

/** Creates (or reuses) a node inside an open transaction; other domains call this, not the async API. */
export function createNodeInTransaction(ctx: AdapterContext, input: CreateKnowledgeNodeInput): KnowledgeNode {
  assertKnowledgeDescriptionWithinBound(input.description);
  const { scope, scopeKey } = storeScope(input.scope);
  const name = input.name.trim();
  const nameLower = name.toLocaleLowerCase();
  const placementIds = resolveScopePlacement(ctx, input.scopeAddresses);

  const existing = loadNodeByKeyRow(ctx, scopeKey, nameLower);
  if (existing) {
    const existingId = String(existing.id);
    const terminal = loadTerminalRow(ctx, existingId);
    if (!terminal) throw new KnowledgeNotFoundError('node', existingId);
    if (!isKnowledgeScopeVisible(readScope(terminal.scope), scope)) {
      throw new Error(`Merged knowledge node is not visible from scope: ${input.name}`);
    }
    // Writing about a node that already exists still places it where the caller asked.
    placeInScopes(ctx, String(terminal.id), placementIds);
    return toKnowledgeNode(terminal);
  }

  const id = input.id ?? randomUUID();
  if (loadNodeRow(ctx, id)) throw new Error(`Knowledge node already exists: ${id}`);

  const now = Date.now();
  const created = ctx.run(
    `CREATE (n:${NODE_LABEL} {
       id: $id, name: $name, nameLower: $nameLower, kind: $kind,
       content: $content, description: $description,
       scope: $scope, scopeKey: $scopeKey, version: 1, createdAt: $now, updatedAt: $now
     })
     RETURN ${UNMERGED_PROJECTION}`,
    {
      id,
      name,
      nameLower,
      kind: input.kind,
      content: input.content ?? null,
      description: input.description ?? null,
      scope,
      scopeKey,
      now,
    },
  )[0]!;
  placeInScopes(ctx, id, placementIds);
  // Node content carries wikilinks just like record text, so it derives mentions on write.
  syncMentions(ctx, NODE_LABEL, id, input.content ?? '', input.resolutionScope ?? scope, scope, false);
  recordKnowledgeActivity(ctx, { action: 'node-created', recordType: 'node', recordId: id, scope });
  enqueueSemanticOutbox(ctx, { documentType: 'node', id, operation: 'upsert', version: 1, scope });

  return toKnowledgeNode(created);
}

function updateNodeInTransaction(ctx: AdapterContext, input: UpdateKnowledgeNodeInput): KnowledgeNode {
  assertKnowledgeDescriptionWithinBound(input.description);
  const existing = loadNodeRow(ctx, input.id);
  if (!existing) throw new KnowledgeNotFoundError('node', input.id);
  if (Number(existing.version) !== input.version) throw new KnowledgeConflictError(input.id);
  if (existing.mergedInto !== null && existing.mergedInto !== undefined) {
    throw new Error(`Cannot update merged knowledge node: ${input.id}`);
  }

  const previousScope = readScope(existing.scope);
  const { scope, scopeKey } = storeScope(input.scope ?? previousScope);
  const name = (input.name ?? String(existing.name)).trim();
  const nameLower = name.toLocaleLowerCase();

  const collision = ctx.run(`MATCH (n:${NODE_LABEL} {scopeKey: $scopeKey, nameLower: $nameLower}) RETURN n.id AS id`, {
    scopeKey,
    nameLower,
  })[0];
  if (collision && String(collision.id) !== input.id) {
    throw new Error(`Knowledge node already exists in scope: ${name}`);
  }

  const properties: Record<string, unknown> = { name, nameLower, scope, scopeKey };
  if (input.kind !== undefined) properties.kind = input.kind;
  if (input.content !== undefined) properties.content = input.content;
  if (input.description !== undefined) properties.description = input.description;

  const updated = ctx.run(
    `MATCH (n:${NODE_LABEL} {id: $id})
     WHERE n.version = $expectedVersion
     SET n += $properties, n.version = n.version + 1, n.updatedAt = $now
     RETURN ${UNMERGED_PROJECTION}`,
    { id: input.id, expectedVersion: input.version, properties, now: Date.now() },
  )[0];
  if (!updated) {
    // The version predicate matched nothing: re-read to tell a vanished node from a raced version.
    if (!loadNodeRow(ctx, input.id)) throw new KnowledgeNotFoundError('node', input.id);
    throw new KnowledgeConflictError(input.id);
  }

  if (input.content !== undefined || input.name !== undefined || input.scope !== undefined) {
    const content = updated.content === null || updated.content === undefined ? '' : String(updated.content);
    syncMentions(ctx, NODE_LABEL, input.id, content, input.resolutionScope ?? scope, scope, true);
  }
  recordKnowledgeActivity(ctx, { action: 'node-updated', recordType: 'node', recordId: input.id, scope });
  if (String(existing.scopeKey) !== scopeKey) {
    enqueueSemanticOutbox(ctx, {
      documentType: 'node',
      id: input.id,
      operation: 'delete',
      version: createKnowledgeUlid(),
      scope: previousScope,
    });
    // Records attached to the node are re-enqueued by the records domain.
  }
  enqueueSemanticOutbox(ctx, {
    documentType: 'node',
    id: input.id,
    operation: 'upsert',
    version: Number(updated.version),
    scope,
  });
  return toKnowledgeNode(updated);
}

/**
 * Re-points the documents that named the merged source at its terminal, mirroring the reference: a
 * record attached to the source moves to the target, and every `MENTIONS` edge to the source from a
 * node or record now points at the target. Each affected document is re-enqueued because its
 * semantic document changed identity, not just its text.
 */
function repointMergedDocuments(ctx: AdapterContext, sourceId: string, targetId: string): void {
  const attached = ctx.run(
    `MATCH (r:${RECORD_LABEL} {node: $sourceId})
     RETURN r.id AS id, r.scope AS scope, r.deletedAt AS deletedAt`,
    { sourceId },
  );
  for (const row of attached) {
    ctx.run(`MATCH (r:${RECORD_LABEL} {id: $id}) SET r.node = $targetId`, { id: String(row.id), targetId });
    enqueueSemanticOutbox(ctx, {
      documentType: 'record',
      id: String(row.id),
      operation: row.deletedAt === null || row.deletedAt === undefined ? 'upsert' : 'delete',
      version: createKnowledgeUlid(),
      scope: readScope(row.scope),
    });
  }

  const mentioning = ctx.run(
    `MATCH (m)-[:${MENTIONS_EDGE}]->(:${NODE_LABEL} {id: $sourceId})
     RETURN m.id AS id, m.scope AS scope, m.deletedAt AS deletedAt, m:${RECORD_LABEL} AS isRecord`,
    { sourceId },
  );
  for (const row of mentioning) {
    const id = String(row.id);
    const isRecord = row.isRecord === true;
    const label = isRecord ? RECORD_LABEL : NODE_LABEL;
    ctx.run(
      `MATCH (m:${label} {id: $id})-[mention:${MENTIONS_EDGE}]->(:${NODE_LABEL} {id: $sourceId}) DELETE mention`,
      { id, sourceId },
    );
    ctx.run(
      `MATCH (m:${label} {id: $id}), (target:${NODE_LABEL} {id: $targetId})
       MERGE (m)-[:${MENTIONS_EDGE}]->(target)`,
      { id, targetId },
    );
    const deleted = row.deletedAt !== null && row.deletedAt !== undefined;
    enqueueSemanticOutbox(ctx, {
      documentType: isRecord ? 'record' : 'node',
      id,
      operation: isRecord && deleted ? 'delete' : 'upsert',
      version: createKnowledgeUlid(),
      scope: readScope(row.scope),
    });
  }
}

function mergeNodesInTransaction(
  ctx: AdapterContext,
  input: { sourceId: string; targetId: string; sourceVersion: number },
): KnowledgeNode {
  if (input.sourceId === input.targetId) throw new Error('Cannot merge a knowledge node into itself');
  const source = loadNodeRow(ctx, input.sourceId);
  if (!source) throw new KnowledgeNotFoundError('node', input.sourceId);
  if (Number(source.version) !== input.sourceVersion) throw new KnowledgeConflictError(input.sourceId);

  const target = loadTerminalRow(ctx, input.targetId);
  if (!target) throw new KnowledgeNotFoundError('node', input.targetId);
  if (String(target.id) === input.sourceId) throw new Error('Cannot create a knowledge merge cycle');

  const sourceScope = readScope(source.scope);
  const targetScope = readScope(target.scope);
  if (!isKnowledgeScopeVisible(targetScope, sourceScope)) {
    throw new Error('Cannot merge a knowledge node into a target that is narrower than its source scope');
  }

  const now = Date.now();
  // Records and mentions that named the source move to the terminal before the tombstone lands.
  repointMergedDocuments(ctx, input.sourceId, String(target.id));
  // A source keeps a single target: merging it again replaces its previous edge.
  ctx.run(`MATCH (s:${NODE_LABEL} {id: $sourceId})-[previous:${MERGED_INTO_EDGE}]->() DELETE previous`, {
    sourceId: input.sourceId,
  });
  const merged = ctx.run(
    `MATCH (s:${NODE_LABEL} {id: $sourceId})
     WHERE s.version = $sourceVersion
     MATCH (t:${NODE_LABEL} {id: $targetId})
     MERGE (s)-[:${MERGED_INTO_EDGE}]->(t)
     SET s.version = s.version + 1, s.updatedAt = $now
     RETURN s.version AS version`,
    { sourceId: input.sourceId, sourceVersion: input.sourceVersion, targetId: String(target.id), now },
  )[0];
  if (!merged) {
    if (!loadNodeRow(ctx, input.sourceId)) throw new KnowledgeNotFoundError('node', input.sourceId);
    throw new KnowledgeConflictError(input.sourceId);
  }

  let result = toKnowledgeNode(target);
  // Merge matrix: a target that never had a description (absent — '' is an explicit curator clear
  // and wins) adopts the source's; otherwise the target's state is preserved.
  if ((target.description === null || target.description === undefined) && source.description) {
    const adopted = ctx.run(
      `MATCH (t:${NODE_LABEL} {id: $targetId})
       WHERE t.description IS NULL
       SET t.description = $description, t.version = t.version + 1, t.updatedAt = $now
       RETURN ${projectColumns('t', NODE_PROPERTIES)}`,
      { targetId: String(target.id), description: String(source.description), now },
    )[0];
    if (adopted) {
      result = toKnowledgeNode(adopted);
      recordKnowledgeActivity(ctx, {
        action: 'node-updated',
        recordType: 'node',
        recordId: String(target.id),
        scope: targetScope,
      });
    }
  }

  recordKnowledgeActivity(ctx, {
    action: 'node-merged',
    recordType: 'node',
    recordId: input.sourceId,
    scope: sourceScope,
  });
  enqueueSemanticOutbox(ctx, {
    documentType: 'node',
    id: input.sourceId,
    operation: 'delete',
    version: Number(merged.version),
    scope: sourceScope,
  });
  enqueueSemanticOutbox(ctx, {
    documentType: 'node',
    id: String(target.id),
    operation: 'upsert',
    version: createKnowledgeUlid(),
    scope: targetScope,
  });
  return result;
}

export interface KnowledgeNodeDomain {
  createNode(input: CreateKnowledgeNodeInput): Promise<KnowledgeNode>;
  getNode(id: string): Promise<KnowledgeNode | null>;
  getNodeByName(input: { name: string; scope: KnowledgeScope }): Promise<KnowledgeNode | null>;
  resolveNode(input: { name: string; scope: KnowledgeScope }): Promise<KnowledgeNode | null>;
  listNodes(input: ListKnowledgeNodesInput): Promise<KnowledgeNode[]>;
  updateNode(input: UpdateKnowledgeNodeInput): Promise<KnowledgeNode>;
  mergeNodes(input: { sourceId: string; targetId: string; sourceVersion: number }): Promise<KnowledgeNode>;
}

/** Node lifecycle over the CypherLite graph; every mutation is one transaction frame. */
export function createNodeDomain(ctx: AdapterContext): KnowledgeNodeDomain {
  return {
    async createNode(input) {
      return ctx.transaction(() => createNodeInTransaction(ctx, input));
    },

    async getNode(id) {
      const row = loadNodeRow(ctx, id);
      return row ? toKnowledgeNode(row) : null;
    },

    async getNodeByName({ name, scope }) {
      const { scopeKey } = storeScope(scope);
      const row = loadNodeByKeyRow(ctx, scopeKey, name.trim().toLocaleLowerCase());
      return row ? toKnowledgeNode(row) : null;
    },

    async resolveNode({ name, scope }) {
      return resolveNodeInTransaction(ctx, { name, scope });
    },

    async listNodes(input) {
      const queryScope = canonicalizeKnowledgeScope(input.scope);
      const cursor = input.cursor
        ? parseKnowledgeNodeCursor(input.cursor, {
            namePrefix: input.namePrefix,
            kind: input.kind,
            hasContent: input.hasContent,
          })
        : undefined;
      const where = [`NOT (n)-[:${MERGED_INTO_EDGE}]->()`, scopeVisibleTo('n')];
      const params: Record<string, unknown> = { queryScope, limit: input.limit ?? 100 };
      if (input.namePrefix) {
        where.push('n.nameLower STARTS WITH $namePrefix');
        params.namePrefix = input.namePrefix.toLocaleLowerCase();
      }
      if (input.kind) {
        where.push('n.kind = $kind');
        params.kind = input.kind;
      }
      if (input.hasContent !== undefined) {
        where.push(
          input.hasContent ? `n.content IS NOT NULL AND n.content <> ''` : `(n.content IS NULL OR n.content = '')`,
        );
      }
      if (cursor) {
        where.push(
          `(n.updatedAt < $cursorUpdatedAt OR (n.updatedAt = $cursorUpdatedAt AND (n.name > $cursorName OR (n.name = $cursorName AND n.id > $cursorId))))`,
        );
        params.cursorUpdatedAt = cursor.updatedAt.getTime();
        params.cursorName = cursor.name;
        params.cursorId = cursor.id;
      }
      const rows = ctx.run(
        `MATCH (n:${NODE_LABEL})
         WHERE ${where.join(' AND ')}
         ${MERGED_EDGE}
         RETURN ${NODE_PROJECTION}
         ORDER BY n.updatedAt DESC, n.name ASC, n.id ASC
         LIMIT $limit`,
        params,
      );
      return rows.map(toKnowledgeNode);
    },

    async updateNode(input) {
      return ctx.transaction(() => updateNodeInTransaction(ctx, input));
    },

    async mergeNodes(input) {
      return ctx.transaction(() => mergeNodesInTransaction(ctx, input));
    },
  };
}
