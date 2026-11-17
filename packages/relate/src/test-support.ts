import { Database } from '@relate/relate';
import type { ParamValue } from '@relate/relate';

import type { RelateStorageConfig } from './connection';
import { RelateKnowledgeStorage } from './storage';

/** Opens the adapter over a fresh `:memory:` database unless the test passes its own config. */
export function openStorage(config?: RelateStorageConfig): RelateKnowledgeStorage {
  return new RelateKnowledgeStorage(config ?? { connection: Database.open(':memory:').connect() });
}

/** Opens the adapter over a fresh `:memory:` database and initializes its schema marker. */
export async function openInitializedStorage(config?: RelateStorageConfig): Promise<RelateKnowledgeStorage> {
  const storage = openStorage(config);
  await storage.init();
  return storage;
}

/** Counts the nodes carrying `label`, defaulting to `KPage`. */
export function countNodes(storage: RelateKnowledgeStorage, label = 'KPage'): number {
  const row = storage.connection.query(`MATCH (n:${label}) RETURN count(n) AS count`).rows[0];
  return Number(row?.count ?? 0);
}

/** Counts the rows a statement returns under the `count` alias. */
export function countRows(
  storage: RelateKnowledgeStorage,
  statement: string,
  params: Record<string, ParamValue> = {},
): number {
  return Number(storage.connection.query(statement, params).rows[0]?.count ?? 0);
}
