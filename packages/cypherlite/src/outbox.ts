import { canonicalizeKnowledgeScope } from '@mastra/core/storage';
import type {
  ClaimKnowledgeSemanticOutboxInput,
  KnowledgeSemanticDocumentType,
  KnowledgeSemanticOperation,
  KnowledgeSemanticOutboxEntry,
  KnowledgeScope,
} from '@mastra/core/storage';

import type { AdapterContext, AdapterRow } from './connection';
import { projectColumns } from './connection';
import { KNOWLEDGE_LABELS } from './schema';
import { readScope, scopeVisibleTo } from './scope';

const OUTBOX_LABEL = KNOWLEDGE_LABELS.outbox;

/** Claim leases run out after one minute unless the caller asks for another timeout. */
const DEFAULT_CLAIM_TIMEOUT_MS = 60_000;
const DEFAULT_LIMIT = 100;

const OUTBOX_PROJECTION = projectColumns('e', [
  'id',
  'idempotencyKey',
  'documentId',
  'documentType',
  'operation',
  'scope',
  'status',
  'attempts',
  'availableAt',
  'claimedAt',
  'claimedBy',
  'createdAt',
  'completedAt',
]);

/** Time values are stored as epoch milliseconds; absent claim fields stay absent on the entry. */
function toSemanticOutboxEntry(row: AdapterRow): KnowledgeSemanticOutboxEntry {
  const entry: KnowledgeSemanticOutboxEntry = {
    id: String(row.id),
    idempotencyKey: String(row.idempotencyKey),
    documentId: String(row.documentId),
    documentType: String(row.documentType) as KnowledgeSemanticDocumentType,
    operation: String(row.operation) as KnowledgeSemanticOperation,
    scope: readScope(row.scope),
    status: String(row.status) as KnowledgeSemanticOutboxEntry['status'],
    attempts: Number(row.attempts ?? 0),
    availableAt: new Date(Number(row.availableAt)),
    createdAt: new Date(Number(row.createdAt)),
  };
  if (row.claimedAt !== null && row.claimedAt !== undefined) entry.claimedAt = new Date(Number(row.claimedAt));
  if (row.claimedBy !== null && row.claimedBy !== undefined) entry.claimedBy = String(row.claimedBy);
  if (row.completedAt !== null && row.completedAt !== undefined) entry.completedAt = new Date(Number(row.completedAt));
  return entry;
}

/** Lists outbox entries oldest first, optionally narrowed by status and by visible scope. */
export function listSemanticOutbox(
  ctx: AdapterContext,
  input: { status?: KnowledgeSemanticOutboxEntry['status']; scope?: KnowledgeScope; limit?: number } = {},
): KnowledgeSemanticOutboxEntry[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: input.limit ?? DEFAULT_LIMIT };
  if (input.status) {
    where.push('e.status = $status');
    params.status = input.status;
  }
  if (input.scope) {
    where.push(scopeVisibleTo('e'));
    params.queryScope = canonicalizeKnowledgeScope(input.scope);
  }
  const rows = ctx.run(
    `MATCH (e:${OUTBOX_LABEL})
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     RETURN ${OUTBOX_PROJECTION}
     ORDER BY e.createdAt ASC, e.id ASC
     LIMIT $limit`,
    params,
  );
  return rows.map(toSemanticOutboxEntry);
}

/**
 * Claims up to `limit` due entries for one worker in a single statement.
 *
 * An entry is due when it is `pending`, or `processing` with a lease older than the claim timeout,
 * and its `availableAt` has arrived. The `NOT EXISTS` guard is the contract's per-document
 * serialization: an entry stays unclaimable while any earlier non-completed entry for the same
 * document is outstanding, so successive versions of one document are indexed in order. Claiming
 * flips the entry to `processing`, stamps the lease and bumps `attempts`.
 */
export function claimSemanticOutbox(
  ctx: AdapterContext,
  input: ClaimKnowledgeSemanticOutboxInput,
): KnowledgeSemanticOutboxEntry[] {
  const now = input.now ?? new Date();
  const staleBefore = now.getTime() - (input.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS);
  const params: Record<string, unknown> = {
    now: now.getTime(),
    staleBefore,
    workerId: input.workerId,
    limit: input.limit ?? DEFAULT_LIMIT,
  };
  const due = [
    `(e.status = 'pending' OR (e.status = 'processing' AND e.claimedAt <= $staleBefore))`,
    'e.availableAt <= $now',
    `NOT EXISTS {
       MATCH (earlier:${OUTBOX_LABEL} {documentId: e.documentId})
       WHERE earlier.status <> 'completed'
         AND (earlier.createdAt < e.createdAt OR (earlier.createdAt = e.createdAt AND earlier.id < e.id))
     }`,
  ];
  if (input.scope) {
    due.push(scopeVisibleTo('e'));
    params.queryScope = canonicalizeKnowledgeScope(input.scope);
  }
  return ctx.transaction(() =>
    ctx
      .run(
        `MATCH (e:${OUTBOX_LABEL})
         WHERE ${due.join(' AND ')}
         WITH e
         ORDER BY e.createdAt ASC, e.id ASC
         LIMIT $limit
         SET e.status = 'processing', e.claimedAt = $now, e.claimedBy = $workerId, e.attempts = e.attempts + 1
         RETURN ${OUTBOX_PROJECTION}`,
        params,
      )
      .map(toSemanticOutboxEntry),
  );
}

/**
 * Marks claimed entries completed. An entry only completes while it is `processing` and still held
 * by `workerId`, so a worker whose lease expired cannot overwrite another worker's claim.
 */
export function completeSemanticOutbox(ctx: AdapterContext, input: { ids: string[]; workerId: string }): void {
  if (input.ids.length === 0) return;
  ctx.transaction(() =>
    ctx.run(
      `UNWIND $ids AS id
       MATCH (e:${OUTBOX_LABEL} {id: id})
       WHERE e.status = 'processing' AND e.claimedBy = $workerId
       SET e.status = 'completed', e.completedAt = $now`,
      { ids: input.ids, workerId: input.workerId, now: Date.now() },
    ),
  );
}

/**
 * Hands claimed entries back as `pending`, due at `retryAt` (now by default) and without a lease.
 * Like `complete`, the ownership guard keeps a worker from releasing someone else's claim.
 */
export function releaseSemanticOutbox(
  ctx: AdapterContext,
  input: { ids: string[]; workerId: string; retryAt?: Date },
): void {
  if (input.ids.length === 0) return;
  ctx.transaction(() =>
    ctx.run(
      `UNWIND $ids AS id
       MATCH (e:${OUTBOX_LABEL} {id: id})
       WHERE e.status = 'processing' AND e.claimedBy = $workerId
       SET e.status = 'pending', e.availableAt = $retryAt, e.claimedAt = null, e.claimedBy = null`,
      { ids: input.ids, workerId: input.workerId, retryAt: (input.retryAt ?? new Date()).getTime() },
    ),
  );
}
