/**
 * Persistent `KnowledgeStorage` on an embedded Relate graph.
 *
 * The graph schema is one label per Knowledge domain (`KPage`, `KNote`, `KPin`, `KActivity`,
 * `KBodyLink`) plus a `KMeta` schema-version marker; all page-store logic lives in
 * {@link RelateKnowledgePageStore}, and this class only wires it into the Mastra storage contract
 * (capabilities, schema inspection, init and reset).
 */

import { resolve } from 'node:path';

import {
  KNOWLEDGE_STORAGE_CONTRACT_VERSION,
  KNOWLEDGE_STORAGE_SCHEMA_VERSION,
  KnowledgeSchemaResetRequiredError,
  KnowledgeStorage,
  inspectKnowledgeSchema,
} from '@mastra/core/storage';
import type { KnowledgePageStore, KnowledgeSchemaInspection, KnowledgeSchemaSnapshot } from '@mastra/core/storage';
import type { Connection as ClientConnection } from '@relate/relate';

import type { AdapterContext, RelateStorageConfig } from './connection';
import { createAdapterContext } from './connection';
import { KNOWLEDGE_LABELS, LEGACY_KNOWLEDGE_LABELS, RelateKnowledgePageStore } from './page-store';

// Lookup indexes for the hot per-id and per-parent queries; created idempotently on init.
const KNOWLEDGE_INDEX_DDL = [
  'CREATE INDEX kpage_id IF NOT EXISTS FOR (p:KPage) ON (p.id)',
  'CREATE INDEX kpage_parent IF NOT EXISTS FOR (p:KPage) ON (p.parentId)',
  'CREATE INDEX knote_id IF NOT EXISTS FOR (n:KNote) ON (n.id)',
  'CREATE INDEX knote_page IF NOT EXISTS FOR (n:KNote) ON (n.pageId)',
  'CREATE INDEX kpin_page_kind IF NOT EXISTS FOR (n:KPin) ON (n.kind, n.pageId)',
  'CREATE INDEX kbodylink_page IF NOT EXISTS FOR (l:KBodyLink) ON (l.pageId)',
] as const;

const connectionIsolationKeys = new WeakMap<ClientConnection, string>();

/**
 * One key per physical backend, so Mastra's shared-storage guard sees two Knowledge domains over
 * the same Relate file (or the same connection) as one store. `:memory:` is a fresh ephemeral
 * database per open, so each handle gets its own key.
 */
function relateIsolationKey(config: RelateStorageConfig): string {
  if (config.path !== undefined) {
    return config.path === ':memory:' ? `relate:memory:${crypto.randomUUID()}` : `relate:file:${resolve(config.path)}`;
  }
  let key = connectionIsolationKeys.get(config.connection);
  if (key === undefined) {
    key = `relate:connection:${crypto.randomUUID()}`;
    connectionIsolationKeys.set(config.connection, key);
  }
  return key;
}

export class RelateKnowledgeStorage extends KnowledgeStorage {
  readonly #context: AdapterContext;
  readonly #pageStore: RelateKnowledgePageStore;

  constructor(config: RelateStorageConfig) {
    super({ storageIsolationKey: config.storageIsolationKey ?? relateIsolationKey(config) });
    this.#context = createAdapterContext(config);
    this.#pageStore = new RelateKnowledgePageStore(this.#context);
  }

  /** The open engine connection; tests and later domains reach raw Cypher through it. */
  get connection(): AdapterContext['connection'] {
    return this.#context.connection;
  }

  override getCapabilities() {
    return {
      contractVersion: KNOWLEDGE_STORAGE_CONTRACT_VERSION,
      schemaVersion: KNOWLEDGE_STORAGE_SCHEMA_VERSION,
      supportsSchemaInspection: true,
      supportsExplicitReset: true,
      supportsPinKinds: true,
    } as const;
  }

  /**
   * Idempotent. Knowledge before schema 4 was experimental and is not migrated: its nodes are
   * dropped, rows included. A schema-4 version marker from another release is never migrated or
   * mutated over: `init()` refuses with `KnowledgeSchemaResetRequiredError` until
   * `dangerouslyReset()` explicitly replaces the store.
   */
  override async init(): Promise<void> {
    this.#context.transaction(() => {
      this.#dropLegacy();
      const inspection = this.#inspect();
      if (inspection.status === 'incompatible-reset-required') throw new KnowledgeSchemaResetRequiredError(inspection);
    });
    for (const statement of KNOWLEDGE_INDEX_DDL) this.#context.run(statement);
    this.#stampMarker();
  }

  /** Schema-2 nodes and markers (labelled `KNode`…`KScope`, `KMeta` without a `kind`). */
  #dropLegacy(): void {
    this.#context.run('MATCH (n) WHERE any(label IN labels(n) WHERE label IN $labels) DETACH DELETE n', {
      labels: [...LEGACY_KNOWLEDGE_LABELS],
    });
    this.#context.run('MATCH (m:KMeta) WHERE m.kind IS NULL DETACH DELETE m');
  }

  #stampMarker(): void {
    this.#context.run('MERGE (m:KMeta {kind: $kind}) ON CREATE SET m.schemaVersion = $version', {
      kind: 'knowledge',
      version: KNOWLEDGE_STORAGE_SCHEMA_VERSION,
    });
  }

  #inspect(): KnowledgeSchemaInspection {
    const marker = this.#context.run('MATCH (m:KMeta {kind: $kind}) RETURN m.schemaVersion AS version', {
      kind: 'knowledge',
    });
    const tableNames = this.#context
      .run('MATCH (n) UNWIND labels(n) AS label WITH label WHERE label IN $labels RETURN DISTINCT label AS label', {
        labels: [...KNOWLEDGE_LABELS, ...LEGACY_KNOWLEDGE_LABELS],
      })
      .map(row => row.label as string);
    const snapshot: KnowledgeSchemaSnapshot = {
      available: true,
      tableNames,
      schemaVersion: marker[0] === undefined ? undefined : Number(marker[0]!.version),
    };
    return inspectKnowledgeSchema(snapshot);
  }

  override async inspectSchema(): Promise<KnowledgeSchemaInspection> {
    try {
      return this.#inspect();
    } catch (error) {
      return inspectKnowledgeSchema({ available: false, tableNames: [], reason: String(error) });
    }
  }

  override async dangerouslyReset(): Promise<void> {
    this.#pageStore.dangerouslyClearAll();
    this.#stampMarker();
  }

  override async dangerouslyClearAll(): Promise<void> {
    // Keeps the version marker, so a cleared store stays initialized (the composite store only
    // calls `init()` once).
    this.#pageStore.dangerouslyClearAll({ keepMarker: true });
  }

  // Schema-4 page store: every method delegates to the page store.
  override materializeScope(
    input: Parameters<KnowledgePageStore['materializeScope']>[0],
  ): ReturnType<KnowledgePageStore['materializeScope']> {
    return this.#pageStore.materializeScope(input);
  }
  override getScopesByAddress(addresses: string[]): ReturnType<KnowledgePageStore['getScopesByAddress']> {
    return this.#pageStore.getScopesByAddress(addresses);
  }
  override listScopeDeclarations(): ReturnType<KnowledgePageStore['listScopeDeclarations']> {
    return this.#pageStore.listScopeDeclarations();
  }
  override renameScopeDeclaration(
    input: Parameters<KnowledgePageStore['renameScopeDeclaration']>[0],
  ): ReturnType<KnowledgePageStore['renameScopeDeclaration']> {
    return this.#pageStore.renameScopeDeclaration(input);
  }
  override listChildScopes(
    input: Parameters<KnowledgePageStore['listChildScopes']>[0],
  ): ReturnType<KnowledgePageStore['listChildScopes']> {
    return this.#pageStore.listChildScopes(input);
  }
  override countChildScopes(
    input: Parameters<KnowledgePageStore['countChildScopes']>[0],
  ): ReturnType<KnowledgePageStore['countChildScopes']> {
    return this.#pageStore.countChildScopes(input);
  }
  override getPage(input: Parameters<KnowledgePageStore['getPage']>[0]): ReturnType<KnowledgePageStore['getPage']> {
    return this.#pageStore.getPage(input);
  }
  override getPages(input: Parameters<KnowledgePageStore['getPages']>[0]): ReturnType<KnowledgePageStore['getPages']> {
    return this.#pageStore.getPages(input);
  }
  override getPageByPath(
    input: Parameters<KnowledgePageStore['getPageByPath']>[0],
  ): ReturnType<KnowledgePageStore['getPageByPath']> {
    return this.#pageStore.getPageByPath(input);
  }
  override findPagesByName(
    input: Parameters<KnowledgePageStore['findPagesByName']>[0],
  ): ReturnType<KnowledgePageStore['findPagesByName']> {
    return this.#pageStore.findPagesByName(input);
  }
  override listChildPages(
    input: Parameters<KnowledgePageStore['listChildPages']>[0],
  ): ReturnType<KnowledgePageStore['listChildPages']> {
    return this.#pageStore.listChildPages(input);
  }
  override countChildPages(
    input: Parameters<KnowledgePageStore['countChildPages']>[0],
  ): ReturnType<KnowledgePageStore['countChildPages']> {
    return this.#pageStore.countChildPages(input);
  }
  override listPages(
    input: Parameters<KnowledgePageStore['listPages']>[0],
  ): ReturnType<KnowledgePageStore['listPages']> {
    return this.#pageStore.listPages(input);
  }
  override createPage(
    input: Parameters<KnowledgePageStore['createPage']>[0],
  ): ReturnType<KnowledgePageStore['createPage']> {
    return this.#pageStore.createPage(input);
  }
  override updatePage(
    input: Parameters<KnowledgePageStore['updatePage']>[0],
  ): ReturnType<KnowledgePageStore['updatePage']> {
    return this.#pageStore.updatePage(input);
  }
  override movePage(input: Parameters<KnowledgePageStore['movePage']>[0]): ReturnType<KnowledgePageStore['movePage']> {
    return this.#pageStore.movePage(input);
  }
  override mergePages(
    input: Parameters<KnowledgePageStore['mergePages']>[0],
  ): ReturnType<KnowledgePageStore['mergePages']> {
    return this.#pageStore.mergePages(input);
  }
  override deletePage(
    input: Parameters<KnowledgePageStore['deletePage']>[0],
  ): ReturnType<KnowledgePageStore['deletePage']> {
    return this.#pageStore.deletePage(input);
  }
  override replacePageBodyLinks(
    input: Parameters<KnowledgePageStore['replacePageBodyLinks']>[0],
  ): ReturnType<KnowledgePageStore['replacePageBodyLinks']> {
    return this.#pageStore.replacePageBodyLinks(input);
  }
  override listPageBodyLinkSources(
    input: Parameters<KnowledgePageStore['listPageBodyLinkSources']>[0],
  ): ReturnType<KnowledgePageStore['listPageBodyLinkSources']> {
    return this.#pageStore.listPageBodyLinkSources(input);
  }
  override countPageLinks(
    input: Parameters<KnowledgePageStore['countPageLinks']>[0],
  ): ReturnType<KnowledgePageStore['countPageLinks']> {
    return this.#pageStore.countPageLinks(input);
  }
  override listPageLinks(
    input: Parameters<KnowledgePageStore['listPageLinks']>[0],
  ): ReturnType<KnowledgePageStore['listPageLinks']> {
    return this.#pageStore.listPageLinks(input);
  }
  override getNote(input: Parameters<KnowledgePageStore['getNote']>[0]): ReturnType<KnowledgePageStore['getNote']> {
    return this.#pageStore.getNote(input);
  }
  override countNotes(
    input: Parameters<KnowledgePageStore['countNotes']>[0],
  ): ReturnType<KnowledgePageStore['countNotes']> {
    return this.#pageStore.countNotes(input);
  }
  override listNotes(
    input: Parameters<KnowledgePageStore['listNotes']>[0],
  ): ReturnType<KnowledgePageStore['listNotes']> {
    return this.#pageStore.listNotes(input);
  }
  override listNotesMentioning(
    input: Parameters<KnowledgePageStore['listNotesMentioning']>[0],
  ): ReturnType<KnowledgePageStore['listNotesMentioning']> {
    return this.#pageStore.listNotesMentioning(input);
  }
  override addNote(input: Parameters<KnowledgePageStore['addNote']>[0]): ReturnType<KnowledgePageStore['addNote']> {
    return this.#pageStore.addNote(input);
  }
  override restampNote(
    input: Parameters<KnowledgePageStore['restampNote']>[0],
  ): ReturnType<KnowledgePageStore['restampNote']> {
    return this.#pageStore.restampNote(input);
  }
  override removeNote(
    input: Parameters<KnowledgePageStore['removeNote']>[0],
  ): ReturnType<KnowledgePageStore['removeNote']> {
    return this.#pageStore.removeNote(input);
  }
  override restoreNote(
    input: Parameters<KnowledgePageStore['restoreNote']>[0],
  ): ReturnType<KnowledgePageStore['restoreNote']> {
    return this.#pageStore.restoreNote(input);
  }
  override searchPages(
    input: Parameters<KnowledgePageStore['searchPages']>[0],
  ): ReturnType<KnowledgePageStore['searchPages']> {
    return this.#pageStore.searchPages(input);
  }
  override listPageActivity(
    input: Parameters<KnowledgePageStore['listPageActivity']>[0],
  ): ReturnType<KnowledgePageStore['listPageActivity']> {
    return this.#pageStore.listPageActivity(input);
  }
  override addPinAudience(
    input: Parameters<KnowledgePageStore['addPinAudience']>[0],
  ): ReturnType<KnowledgePageStore['addPinAudience']> {
    return this.#pageStore.addPinAudience(input);
  }
  override removePinAudience(
    input: Parameters<KnowledgePageStore['removePinAudience']>[0],
  ): ReturnType<KnowledgePageStore['removePinAudience']> {
    return this.#pageStore.removePinAudience(input);
  }
  override listPins(input: Parameters<KnowledgePageStore['listPins']>[0]): ReturnType<KnowledgePageStore['listPins']> {
    return this.#pageStore.listPins(input);
  }
}
