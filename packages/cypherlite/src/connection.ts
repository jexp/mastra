import { Database } from '@neo4j-labs/cypherlite';
import type { Connection as ClientConnection, Row as ClientRow } from '@neo4j-labs/cypherlite';

/** Opens a CypherLite database at `path` (`:memory:`, a file or a directory) and connects to it. */
export interface CypherLitePathConfig {
  path: string;
  connection?: never;
}

/** Uses an already-open CypherLite connection; the caller keeps ownership of the database. */
export interface CypherLiteConnectionConfig {
  connection: ClientConnection;
  path?: never;
}

export type CypherLiteStorageConfig = CypherLitePathConfig | CypherLiteConnectionConfig;

/** One row as a statement returns it: a record of projected columns. Shared by every domain module. */
export type AdapterRow = ClientRow;

/**
 * Everything an adapter domain needs from the engine: the open connection (later domains and tests
 * reach raw Cypher through it) and the one transaction frame every mutating method runs in.
 */
export interface AdapterContext {
  /** The open CypherLite connection. The client is synchronous; every call returns materialized rows. */
  readonly connection: ClientConnection;
  /** Runs one statement and returns its materialized rows. */
  run(statement: string, params?: Record<string, unknown>): AdapterRow[];
  /**
   * Runs `operation` inside `begin`/`commit` and rolls back when it throws. CypherLite has no
   * nested transactions, so domains call this exactly once per public mutating method; helpers
   * inside the frame must not open their own. The callback is synchronous on purpose: the engine
   * is synchronous, and an `await` inside the frame would commit before the work finished.
   */
  transaction<T>(operation: () => T): T;
}

class CypherLiteContext implements AdapterContext {
  readonly connection: ClientConnection;

  constructor(connection: ClientConnection) {
    this.connection = connection;
  }

  run(statement: string, params: Record<string, unknown> = {}): AdapterRow[] {
    return this.connection.query(statement, params).rows;
  }

  transaction<T>(operation: () => T): T {
    this.connection.begin();
    try {
      const value = operation();
      this.connection.commit();
      return value;
    } catch (error) {
      try {
        this.connection.rollback();
      } catch {
        // The operation's error is the one that explains the failure; a rollback error is secondary.
      }
      throw error;
    }
  }
}

/** A projected column: a property name, or `[property, name]` to read it under another name. */
export type ColumnProjection = string | readonly [property: string, name: string];

/**
 * The one column list a statement returns: `alias.property AS property` for every column, so the
 * `RETURN` list and the row mapper stay in step. A `[property, name]` pair renames a column; `extras`
 * appends derived fragments (labels, computed values) the alias form cannot express.
 */
export function projectColumns(
  alias: string,
  columns: readonly ColumnProjection[],
  extras: readonly string[] = [],
): string {
  const projected = columns.map(column =>
    typeof column === 'string' ? `${alias}.${column} AS ${column}` : `${alias}.${column[0]} AS ${column[1]}`,
  );
  return [...projected, ...extras].join(', ');
}

/** Builds the adapter context, opening the database when the config names a path. */
export function createAdapterContext(config: CypherLiteStorageConfig): AdapterContext {
  const { connection, path } = config;
  if (connection !== undefined && path !== undefined) {
    throw new TypeError('CypherLite knowledge storage takes either { path } or { connection }, not both');
  }
  if (connection !== undefined) return new CypherLiteContext(connection);
  if (path !== undefined) return new CypherLiteContext(Database.open(path).connect());
  throw new TypeError('CypherLite knowledge storage requires { path } or { connection }');
}
