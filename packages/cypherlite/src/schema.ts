import {
  assertKnowledgeSchemaCompatible,
  inspectKnowledgeSchema,
  KNOWLEDGE_STORAGE_SCHEMA_VERSION,
} from '@mastra/core/storage';
import type { KnowledgeSchemaInspection } from '@mastra/core/storage';

import type { AdapterContext } from './connection';

/**
 * The Knowledge labels this adapter owns. Every other node in the database belongs to the
 * application, so the schema probe, the reset and every domain query touch only these.
 */
export const KNOWLEDGE_LABELS = {
  node: 'KNode',
  record: 'KRecord',
  activity: 'KActivity',
  outbox: 'KOutbox',
  scope: 'KScope',
  meta: 'KMeta',
} as const;

/**
 * Label attached alongside `KRecord` on a soft-deleted record. It is deliberately not a Knowledge
 * data label: reset and schema inspection key off `KRecord`, so an application node that happens to
 * carry `Deleted` is never treated as Knowledge structure or deleted by a reset.
 */
export const DELETED_LABEL = 'Deleted';

/** Labels that hold Knowledge data; `KMeta` is the version marker and outlives a reset. */
export const KNOWLEDGE_DATA_LABELS = [
  KNOWLEDGE_LABELS.node,
  KNOWLEDGE_LABELS.record,
  KNOWLEDGE_LABELS.activity,
  KNOWLEDGE_LABELS.outbox,
  KNOWLEDGE_LABELS.scope,
] as const;

/** Every label the schema probe reports as Knowledge structure. */
const KNOWLEDGE_SCHEMA_LABELS = [...KNOWLEDGE_DATA_LABELS, KNOWLEDGE_LABELS.meta] as const;

/** The `KMeta` row that carries the store-wide Knowledge schema marker and adapter bookkeeping. */
export const KNOWLEDGE_META_ID = 'knowledge';

/**
 * Schema object names are part of the schema version: `init()` re-creates them by name, so a
 * changed definition means a new schema version, not a silent migration.
 */
export const KNOWLEDGE_SCHEMA_STATEMENTS = [
  `CREATE CONSTRAINT knowledge_node_scope_name IF NOT EXISTS FOR (n:${KNOWLEDGE_LABELS.node}) REQUIRE (n.scopeKey, n.nameLower) IS UNIQUE`,
  `CREATE CONSTRAINT knowledge_outbox_idempotency_key IF NOT EXISTS FOR (n:${KNOWLEDGE_LABELS.outbox}) REQUIRE n.idempotencyKey IS UNIQUE`,
  `CREATE CONSTRAINT knowledge_record_id IF NOT EXISTS FOR (n:${KNOWLEDGE_LABELS.record}) REQUIRE n.id IS UNIQUE`,
  `CREATE CONSTRAINT knowledge_activity_id IF NOT EXISTS FOR (n:${KNOWLEDGE_LABELS.activity}) REQUIRE n.id IS UNIQUE`,
  `CREATE CONSTRAINT knowledge_scope_address IF NOT EXISTS FOR (n:${KNOWLEDGE_LABELS.scope}) REQUIRE n.address IS UNIQUE`,
] as const;

/**
 * Creates the constraints and the version marker. Idempotent; refuses to write over a store whose
 * marker is missing or carries another schema version (the caller resets).
 */
export function initializeKnowledgeSchema(ctx: AdapterContext): void {
  assertKnowledgeSchemaCompatible(inspectKnowledgeSchemaStore(ctx));
  for (const statement of KNOWLEDGE_SCHEMA_STATEMENTS) ctx.run(statement);
  ctx.run(`MERGE (meta:${KNOWLEDGE_LABELS.meta} {id: $id}) ON CREATE SET meta.schemaVersion = $schemaVersion`, {
    id: KNOWLEDGE_META_ID,
    schemaVersion: KNOWLEDGE_STORAGE_SCHEMA_VERSION,
  });
}

/**
 * Probes the physical schema read-only: which Knowledge labels exist and what version the `KMeta`
 * marker declares. Version negotiation belongs to `inspectKnowledgeSchema`.
 */
export function inspectKnowledgeSchemaStore(ctx: AdapterContext): KnowledgeSchemaInspection {
  try {
    const labels = new Set(ctx.run(`CALL db.labels() YIELD label RETURN label`).map(row => String(row.label)));
    const tableNames = KNOWLEDGE_SCHEMA_LABELS.filter(label => labels.has(label));
    if (tableNames.length === 0) return inspectKnowledgeSchema({ available: true, tableNames });

    const marker = ctx.run(
      `MATCH (meta:${KNOWLEDGE_LABELS.meta} {id: $id}) RETURN meta.schemaVersion AS schemaVersion`,
      {
        id: KNOWLEDGE_META_ID,
      },
    )[0];
    const schemaVersion = typeof marker?.schemaVersion === 'number' ? marker.schemaVersion : undefined;
    return inspectKnowledgeSchema({
      available: true,
      tableNames,
      ...(schemaVersion === undefined ? {} : { schemaVersion }),
      reason: 'Knowledge schema version marker is missing or incompatible',
    });
  } catch (error) {
    return inspectKnowledgeSchema({
      available: false,
      tableNames: [],
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Deletes every Knowledge row and the edges between them, and nothing else. The `KMeta` marker and
 * application data outside the Knowledge labels stay untouched.
 */
export function resetKnowledgeData(ctx: AdapterContext): void {
  for (const label of KNOWLEDGE_DATA_LABELS) {
    ctx.run(`MATCH (n:${label}) DETACH DELETE n`);
  }
}
