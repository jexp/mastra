import {
  createKnowledgeUlid,
  knowledgeSemanticDocumentId,
  knowledgeSemanticIdempotencyKey,
} from '@mastra/core/storage';
import type {
  KnowledgeActivityAction,
  KnowledgeScope,
  KnowledgeSemanticDocumentType,
  KnowledgeSemanticOperation,
} from '@mastra/core/storage';

import type { AdapterContext } from './connection';
import { KNOWLEDGE_LABELS } from './schema';
import { storeScope } from './scope';

const { activity: ACTIVITY_LABEL, outbox: OUTBOX_LABEL } = KNOWLEDGE_LABELS;

/** Appends one activity event. Callers run inside a mutation's transaction. */
export function recordKnowledgeActivity(
  ctx: AdapterContext,
  input: {
    action: KnowledgeActivityAction;
    recordType: KnowledgeSemanticDocumentType;
    recordId: string;
    scope: KnowledgeScope;
    sourceThreadId?: string;
    importRunId?: string;
  },
): void {
  const { scope, scopeKey } = storeScope(input.scope);
  ctx.run(
    `CREATE (event:${ACTIVITY_LABEL} {
       id: $id, action: $action, recordType: $recordType, recordId: $recordId,
       scope: $scope, scopeKey: $scopeKey, createdAt: $createdAt,
       sourceThreadId: $sourceThreadId, importRunId: $importRunId
     })`,
    {
      id: createKnowledgeUlid(),
      action: input.action,
      recordType: input.recordType,
      recordId: input.recordId,
      scope,
      scopeKey,
      createdAt: Date.now(),
      sourceThreadId: input.sourceThreadId ?? null,
      importRunId: input.importRunId ?? null,
    },
  );
}

/**
 * Enqueues one semantic outbox entry. The idempotency key `(document, operation, version)` is the
 * uniqueness constraint, so replaying the same mutation keeps a single entry. Callers run inside a
 * mutation's transaction.
 */
export function enqueueSemanticOutbox(
  ctx: AdapterContext,
  input: {
    documentType: KnowledgeSemanticDocumentType;
    id: string;
    operation: KnowledgeSemanticOperation;
    version: number | string;
    scope: KnowledgeScope;
  },
): void {
  const documentId = knowledgeSemanticDocumentId(input.documentType, input.id);
  const { scope, scopeKey } = storeScope(input.scope);
  const now = Date.now();
  ctx.run(
    `MERGE (entry:${OUTBOX_LABEL} {idempotencyKey: $idempotencyKey})
     ON CREATE SET entry.id = $id, entry.documentId = $documentId, entry.documentType = $documentType,
       entry.operation = $operation, entry.scope = $scope, entry.scopeKey = $scopeKey,
       entry.status = 'pending', entry.attempts = 0, entry.availableAt = $now, entry.createdAt = $now`,
    {
      idempotencyKey: knowledgeSemanticIdempotencyKey(documentId, input.operation, input.version),
      id: createKnowledgeUlid(),
      documentId,
      documentType: input.documentType,
      operation: input.operation,
      scope,
      scopeKey,
      now,
    },
  );
}
