import { Database } from '@relate/relate';

import type { RelateStorageConfig } from './connection';
import { RelateKnowledgeStorage } from './storage';

/** Opens the adapter over a fresh `:memory:` database unless the test passes its own config. */
export function openStorage(config?: RelateStorageConfig): RelateKnowledgeStorage {
  return new RelateKnowledgeStorage(config ?? { connection: Database.open(':memory:').connect() });
}

/** Counts the nodes carrying `label`, defaulting to `KNode`. */
export function countNodes(storage: RelateKnowledgeStorage, label = 'KNode'): number {
  const row = storage.connection.query(`MATCH (n:${label}) RETURN count(n) AS count`).rows[0];
  return Number(row?.count ?? 0);
}

/** Counts the rows a statement returns under the `count` alias. */
export function countRows(
  storage: RelateKnowledgeStorage,
  statement: string,
  params: Record<string, unknown> = {},
): number {
  return Number(storage.connection.query(statement, params).rows[0]?.count ?? 0);
}

/** Backdates a knowledge node so ordering tests do not depend on wall-clock resolution. */
export function setUpdatedAt(storage: RelateKnowledgeStorage, id: string, updatedAt: number): void {
  storage.connection.query(`MATCH (n:KNode {id: $id}) SET n.updatedAt = $updatedAt`, { id, updatedAt });
}
