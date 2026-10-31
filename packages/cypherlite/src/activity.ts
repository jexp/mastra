import { canonicalizeKnowledgeScope } from '@mastra/core/storage';
import type {
  KnowledgeActivityAction,
  KnowledgeActivityEvent,
  KnowledgeScope,
  KnowledgeSemanticDocumentType,
} from '@mastra/core/storage';

import type { AdapterContext, AdapterRow } from './connection';
import { projectColumns } from './connection';
import { KNOWLEDGE_LABELS } from './schema';
import { readScope, scopeVisibleTo } from './scope';

const ACTIVITY_LABEL = KNOWLEDGE_LABELS.activity;
const DEFAULT_ACTIVITY_LIMIT = 100;

/** Activity ids are ULIDs, so descending id order is newest first. */
const ACTIVITY_PROJECTION = projectColumns('event', [
  'id',
  'action',
  'recordType',
  'recordId',
  'scope',
  'sourceThreadId',
  'importRunId',
  'createdAt',
]);

function toActivityEvent(row: AdapterRow): KnowledgeActivityEvent {
  const event: KnowledgeActivityEvent = {
    id: String(row.id),
    action: String(row.action) as KnowledgeActivityAction,
    recordType: String(row.recordType) as KnowledgeSemanticDocumentType,
    recordId: String(row.recordId),
    scope: readScope(row.scope),
    createdAt: new Date(Number(row.createdAt)),
  };
  if (row.sourceThreadId !== null && row.sourceThreadId !== undefined) {
    event.sourceThreadId = String(row.sourceThreadId);
  }
  if (row.importRunId !== null && row.importRunId !== undefined) event.importRunId = String(row.importRunId);
  return event;
}

/**
 * Reads the activity feed newest first. `after` is the id of the last event of the previous page;
 * the page holds at most `limit` events (100 by default) the caller's scope can see.
 */
export function listKnowledgeActivity(
  ctx: AdapterContext,
  input: { scope: KnowledgeScope; after?: string; limit?: number },
): KnowledgeActivityEvent[] {
  const params: Record<string, unknown> = {
    queryScope: canonicalizeKnowledgeScope(input.scope),
    limit: input.limit ?? DEFAULT_ACTIVITY_LIMIT,
  };
  const where = [scopeVisibleTo('event')];
  if (input.after) {
    where.push('event.id < $after');
    params.after = input.after;
  }
  return ctx
    .run(
      `MATCH (event:${ACTIVITY_LABEL})
       WHERE ${where.join(' AND ')}
       RETURN ${ACTIVITY_PROJECTION}
       ORDER BY event.id DESC
       LIMIT $limit`,
      params,
    )
    .map(toActivityEvent);
}
