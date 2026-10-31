import {
  assertKnowledgeRecordTextWithinBound,
  canonicalizeKnowledgeScope,
  createKnowledgeUlid,
  KnowledgeNotFoundError,
} from '@mastra/core/storage';
import type {
  AppendKnowledgeInput,
  KnowledgeNodeReference,
  KnowledgeRecord,
  KnowledgeScope,
  QueryKnowledgeBySourceInput,
  QueryKnowledgeInput,
  QueryKnowledgeOutput,
} from '@mastra/core/storage';

import type { AdapterContext, AdapterRow } from './connection';
import { projectColumns } from './connection';
import { KNOWLEDGE_EDGES } from './edges';
import { enqueueSemanticOutbox, recordKnowledgeActivity } from './events';
import { loadTerminalRow, syncMentions } from './nodes';
import { DELETED_LABEL, KNOWLEDGE_LABELS } from './schema';
import { readScope, scopeVisibleTo, storeScope } from './scope';

const { record: RECORD_LABEL, node: NODE_LABEL } = KNOWLEDGE_LABELS;

/** Mention edge derived from a document's `[[wikilinks]]`; the target is a terminal content node. */
const MENTIONS_EDGE = KNOWLEDGE_EDGES.mentions;

/** Default page size of the record views and the source view. */
const DEFAULT_RECORD_LIMIT = 100;

/** The stored `KnowledgeRecord` properties every record projection reads, in contract order. */
const RECORD_PROPERTIES = [
  'id',
  'node',
  'text',
  'scope',
  'sourceThreadId',
  'capturedAt',
  'when',
  'metadataJson',
  'deletedAt',
  'deletedBy',
] as const;

const RECORD_PROJECTION = projectColumns('r', RECORD_PROPERTIES, [`r:${DELETED_LABEL} AS deleted`]);

/**
 * Metadata is free-form and may nest, while graph properties must stay flat, so it is stored as one
 * JSON string property and parsed back on read. Records are immutable, so there is nothing to merge.
 */
function encodeMetadata(metadata: Record<string, unknown> | undefined): string | null {
  return metadata === undefined ? null : JSON.stringify(metadata);
}

function decodeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return JSON.parse(value) as Record<string, unknown>;
}

function toKnowledgeRecord(row: AdapterRow): KnowledgeRecord {
  const record: KnowledgeRecord = {
    id: String(row.id),
    node: String(row.node),
    text: String(row.text),
    scope: readScope(row.scope),
    sourceThreadId: String(row.sourceThreadId),
    capturedAt: new Date(Number(row.capturedAt)),
  };
  if (row.when !== null && row.when !== undefined) record.when = new Date(Number(row.when));
  const metadata = decodeMetadata(row.metadataJson);
  if (metadata !== undefined) record.metadata = metadata;
  if (row.deletedAt !== null && row.deletedAt !== undefined) {
    record.deletedAt = new Date(Number(row.deletedAt));
    if (row.deletedBy !== null && row.deletedBy !== undefined) record.deletedBy = String(row.deletedBy);
  }
  return record;
}

function isDeletedRow(row: AdapterRow): boolean {
  return row.deleted === true;
}

function loadRecordRow(ctx: AdapterContext, id: string): AdapterRow | null {
  return ctx.run(`MATCH (r:${RECORD_LABEL} {id: $id}) RETURN ${RECORD_PROJECTION}`, { id })[0] ?? null;
}

function nodeReferenceId(node: KnowledgeNodeReference): string {
  return typeof node === 'string' ? node : node.id;
}

function appendKnowledgeInTransaction(ctx: AdapterContext, input: AppendKnowledgeInput): KnowledgeRecord {
  assertKnowledgeRecordTextWithinBound(input.text);
  const nodeId = nodeReferenceId(input.node);
  const terminal = loadTerminalRow(ctx, nodeId);
  if (!terminal) throw new KnowledgeNotFoundError('node', nodeId);

  const { scope, scopeKey } = storeScope(input.scope);
  const id = input.id ?? createKnowledgeUlid();
  if (loadRecordRow(ctx, id)) throw new Error(`Knowledge already exists: ${id}`);

  const now = Date.now();
  ctx.run(
    `CREATE (r:${RECORD_LABEL} {
       id: $id, node: $node, text: $text, scope: $scope, scopeKey: $scopeKey,
       sourceThreadId: $sourceThreadId, capturedAt: $now, when: $when, metadataJson: $metadataJson
     })`,
    {
      id,
      node: String(terminal.id),
      text: input.text,
      scope,
      scopeKey,
      sourceThreadId: input.sourceThreadId,
      now,
      when: input.when ? input.when.getTime() : null,
      metadataJson: encodeMetadata(input.metadata),
    },
  );
  // Records are immutable, so their mentions are derived once and never replaced.
  syncMentions(ctx, RECORD_LABEL, id, input.text, input.resolutionScope, input.defaultScope, false);
  // Appending keeps the node's "last touched" position fresh, like every other write about it.
  ctx.run(`MATCH (n:${NODE_LABEL} {id: $id}) SET n.updatedAt = $now`, { id: String(terminal.id), now });

  recordKnowledgeActivity(ctx, {
    action: 'record-created',
    recordType: 'record',
    recordId: id,
    scope,
    sourceThreadId: input.sourceThreadId,
  });
  enqueueSemanticOutbox(ctx, { documentType: 'record', id, operation: 'upsert', version: id, scope });
  return toKnowledgeRecord(loadRecordRow(ctx, id)!);
}

function getKnowledgeInTransaction(
  ctx: AdapterContext,
  input: { id: string; includeDeleted?: boolean },
): KnowledgeRecord | null {
  const filter = input.includeDeleted ? '' : ` WHERE NOT r:${DELETED_LABEL}`;
  const row = ctx.run(`MATCH (r:${RECORD_LABEL} {id: $id})${filter} RETURN ${RECORD_PROJECTION}`, { id: input.id })[0];
  return row ? toKnowledgeRecord(row) : null;
}

function pageRecords(rows: AdapterRow[], limit: number): QueryKnowledgeOutput {
  const records = rows.slice(0, limit).map(toKnowledgeRecord);
  return rows.length > limit && records.length > 0
    ? { records, nextCursor: records[records.length - 1]!.id }
    : { records };
}

/** The cursor order of a record page: newest-first views walk down with `<`, oldest-first ones up with `>`. */
type RecordPageOrder = 'ASC' | 'DESC';

/**
 * The shared page of a record view: visible records (undeleted unless asked otherwise) narrowed by
 * `filters`, one row past the limit to detect a next page. `after` is the last id of the previous
 * page and continues strictly past it in the view's own direction.
 */
function recordPageInTransaction(
  ctx: AdapterContext,
  input: { scope: KnowledgeScope; includeDeleted?: boolean; after?: string; limit?: number },
  options: { filters: string[]; params?: Record<string, unknown>; order: RecordPageOrder },
): QueryKnowledgeOutput {
  const limit = input.limit ?? DEFAULT_RECORD_LIMIT;
  const where = [...options.filters, scopeVisibleTo('r')];
  if (!input.includeDeleted) where.push(`NOT r:${DELETED_LABEL}`);
  const params: Record<string, unknown> = {
    ...options.params,
    queryScope: canonicalizeKnowledgeScope(input.scope),
    limit: limit + 1,
  };
  if (input.after) {
    where.push(`r.id ${options.order === 'DESC' ? '<' : '>'} $after`);
    params.after = input.after;
  }
  const rows = ctx.run(
    `MATCH (r:${RECORD_LABEL})
     WHERE ${where.join(' AND ')}
     RETURN ${RECORD_PROJECTION}
     ORDER BY r.id ${options.order}
     LIMIT $limit`,
    params,
  );
  return pageRecords(rows, limit);
}

/**
 * The three record views of a node, mirroring the in-memory reference:
 * `about` is the record's own node, `mentioning` is a `MENTIONS` edge to it, `related` is either.
 * Pages run newest-first by ULID (`after` is the last id of the previous page).
 */
function queryKnowledgeInTransaction(
  ctx: AdapterContext,
  input: QueryKnowledgeInput,
  relationship: 'about' | 'mentioning' | 'related',
): QueryKnowledgeOutput {
  const terminal = loadTerminalRow(ctx, nodeReferenceId(input.node));
  if (!terminal) return { records: [] };
  return recordPageInTransaction(ctx, input, {
    filters: [relationshipWhere(relationship)],
    params: { terminalId: String(terminal.id) },
    order: 'DESC',
  });
}

function relationshipWhere(relationship: 'about' | 'mentioning' | 'related'): string {
  const about = 'r.node = $terminalId';
  const mentioning = `EXISTS { (r)-[:${MENTIONS_EDGE}]->(:${NODE_LABEL} {id: $terminalId}) }`;
  if (relationship === 'about') return about;
  if (relationship === 'mentioning') return mentioning;
  return `(${about} OR ${mentioning})`;
}

function knowledgeBySourceInTransaction(ctx: AdapterContext, input: QueryKnowledgeBySourceInput): QueryKnowledgeOutput {
  // A source reads oldest-first, so its cursor advances with `>`.
  return recordPageInTransaction(ctx, input, {
    filters: ['r.sourceThreadId = $sourceThreadId'],
    params: { sourceThreadId: input.sourceThreadId },
    order: 'ASC',
  });
}

function removeKnowledgeInTransaction(ctx: AdapterContext, input: { id: string; deletedBy: string }): KnowledgeRecord {
  const row = loadRecordRow(ctx, input.id);
  if (!row) throw new KnowledgeNotFoundError('record', input.id);
  // Removing twice is a no-op that returns the stored record; a second event would be noise.
  if (isDeletedRow(row)) return toKnowledgeRecord(row);

  const now = Date.now();
  ctx.run(
    `MATCH (r:${RECORD_LABEL} {id: $id})
     SET r:${DELETED_LABEL}, r.deletedAt = $now, r.deletedBy = $deletedBy`,
    { id: input.id, now, deletedBy: input.deletedBy },
  );
  const record = toKnowledgeRecord(loadRecordRow(ctx, input.id)!);
  recordKnowledgeActivity(ctx, {
    action: 'record-deleted',
    recordType: 'record',
    recordId: input.id,
    scope: record.scope,
    sourceThreadId: record.sourceThreadId,
  });
  enqueueSemanticOutbox(ctx, {
    documentType: 'record',
    id: input.id,
    operation: 'delete',
    version: record.deletedAt!.toISOString(),
    scope: record.scope,
  });
  return record;
}

function restoreKnowledgeInTransaction(ctx: AdapterContext, input: { id: string }): KnowledgeRecord {
  const row = loadRecordRow(ctx, input.id);
  if (!row) throw new KnowledgeNotFoundError('record', input.id);
  if (!isDeletedRow(row)) return toKnowledgeRecord(row);

  // The `MENTIONS` edges survive a delete/restore cycle: soft delete only toggles the label.
  ctx.run(
    `MATCH (r:${RECORD_LABEL} {id: $id})
     REMOVE r:${DELETED_LABEL}
     SET r.deletedAt = null, r.deletedBy = null`,
    { id: input.id },
  );
  const record = toKnowledgeRecord(loadRecordRow(ctx, input.id)!);
  recordKnowledgeActivity(ctx, {
    action: 'record-restored',
    recordType: 'record',
    recordId: input.id,
    scope: record.scope,
    sourceThreadId: record.sourceThreadId,
  });
  enqueueSemanticOutbox(ctx, {
    documentType: 'record',
    id: input.id,
    operation: 'upsert',
    version: createKnowledgeUlid(),
    scope: record.scope,
  });
  return record;
}

function rescopeKnowledgeInTransaction(
  ctx: AdapterContext,
  input: { id: string; scope: KnowledgeScope },
): KnowledgeRecord {
  const row = loadRecordRow(ctx, input.id);
  if (!row) throw new KnowledgeNotFoundError('record', input.id);

  const previousScope = readScope(row.scope);
  const { scope, scopeKey } = storeScope(input.scope);
  const { scopeKey: previousScopeKey } = storeScope(previousScope);
  ctx.run(
    `MATCH (r:${RECORD_LABEL} {id: $id})
     SET r.scope = $scope, r.scopeKey = $scopeKey`,
    { id: input.id, scope, scopeKey },
  );
  const record = toKnowledgeRecord(loadRecordRow(ctx, input.id)!);
  recordKnowledgeActivity(ctx, {
    action: 'record-rescoped',
    recordType: 'record',
    recordId: input.id,
    scope,
    sourceThreadId: record.sourceThreadId,
  });
  if (previousScopeKey !== scopeKey) {
    // The old scope's semantic document must disappear, keyed by the old scope, before the new one lands.
    enqueueSemanticOutbox(ctx, {
      documentType: 'record',
      id: input.id,
      operation: 'delete',
      version: createKnowledgeUlid(),
      scope: previousScope,
    });
  }
  if (!isDeletedRow(row)) {
    enqueueSemanticOutbox(ctx, {
      documentType: 'record',
      id: input.id,
      operation: 'upsert',
      version: createKnowledgeUlid(),
      scope,
    });
  }
  return record;
}

export interface KnowledgeRecordDomain {
  appendKnowledge(input: AppendKnowledgeInput): Promise<KnowledgeRecord>;
  getKnowledge(input: { id: string; includeDeleted?: boolean }): Promise<KnowledgeRecord | null>;
  listKnowledgeAbout(input: QueryKnowledgeInput): Promise<QueryKnowledgeOutput>;
  listKnowledgeMentioning(input: QueryKnowledgeInput): Promise<QueryKnowledgeOutput>;
  listKnowledgeRelatedTo(input: QueryKnowledgeInput): Promise<QueryKnowledgeOutput>;
  knowledgeBySource(input: QueryKnowledgeBySourceInput): Promise<QueryKnowledgeOutput>;
  removeKnowledge(input: { id: string; deletedBy: string }): Promise<KnowledgeRecord>;
  restoreKnowledge(input: { id: string }): Promise<KnowledgeRecord>;
  rescopeKnowledge(input: { id: string; scope: KnowledgeScope }): Promise<KnowledgeRecord>;
}

/** Record and mention domain over the CypherLite graph; every mutation is one transaction frame. */
export function createRecordDomain(ctx: AdapterContext): KnowledgeRecordDomain {
  return {
    async appendKnowledge(input) {
      return ctx.transaction(() => appendKnowledgeInTransaction(ctx, input));
    },

    async getKnowledge(input) {
      return getKnowledgeInTransaction(ctx, input);
    },

    async listKnowledgeAbout(input) {
      return queryKnowledgeInTransaction(ctx, input, 'about');
    },

    async listKnowledgeMentioning(input) {
      return queryKnowledgeInTransaction(ctx, input, 'mentioning');
    },

    async listKnowledgeRelatedTo(input) {
      return queryKnowledgeInTransaction(ctx, input, 'related');
    },

    async knowledgeBySource(input) {
      return knowledgeBySourceInTransaction(ctx, input);
    },

    async removeKnowledge(input) {
      return ctx.transaction(() => removeKnowledgeInTransaction(ctx, input));
    },

    async restoreKnowledge(input) {
      return ctx.transaction(() => restoreKnowledgeInTransaction(ctx, input));
    },

    async rescopeKnowledge(input) {
      return ctx.transaction(() => rescopeKnowledgeInTransaction(ctx, input));
    },
  };
}
