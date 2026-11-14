/**
 * Persistent `KnowledgeStorage` on an embedded Relate graph.
 *
 * The graph schema is one label per Knowledge domain (`KPage`, `KNote`, `KPin`, `KActivity`,
 * `KBodyLink`) plus a `KMeta` schema-version marker; all page-store logic lives in
 * {@link RelateKnowledgePageStore}, and this class only wires it into the Mastra storage contract
 * (capabilities, schema inspection, init and reset).
 */

import {
  KNOWLEDGE_STORAGE_CONTRACT_VERSION,
  KNOWLEDGE_STORAGE_SCHEMA_VERSION,
  KnowledgeStorage,
  inspectKnowledgeSchema,
} from '@mastra/core/storage';
import type { KnowledgePageStore, KnowledgeSchemaInspection, KnowledgeSchemaSnapshot } from '@mastra/core/storage';

import type { AdapterContext, RelateStorageConfig } from './connection';
import { createAdapterContext } from './connection';
import { KNOWLEDGE_LABELS, RelateKnowledgePageStore } from './page-store';

// The reset and the incompatible-schema probe sweep the schema-2 labels too, so a store written by
// the pre-rename @mastra/cypherlite adapter is detected as reset-required instead of uninitialized.
const LEGACY_KNOWLEDGE_LABELS = ['KNode', 'KRecord', 'KOutbox', 'KScope'] as const;

export class RelateKnowledgeStorage extends KnowledgeStorage {
  readonly #context: AdapterContext;
  readonly #pageStore: RelateKnowledgePageStore;

  constructor(config: RelateStorageConfig) {
    super();
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
   * Idempotent: stamps the schema-4 version marker. A store that already carries a different
   * (e.g. schema-2) marker is left alone, so `inspectSchema()` can report it reset-required
   * instead of silently upgrading over incompatible data.
   */
  override async init(): Promise<void> {
    this.#context.run('MERGE (m:KMeta {kind: $kind}) ON CREATE SET m.schemaVersion = $version', {
      kind: 'knowledge',
      version: KNOWLEDGE_STORAGE_SCHEMA_VERSION,
    });
  }

  override async inspectSchema(): Promise<KnowledgeSchemaInspection> {
    const versions = this.#context.run('MATCH (m:KMeta) RETURN m.schemaVersion AS version').map(row => Number(row.version));
    const tableNames = this.#context.run('MATCH (n) UNWIND labels(n) AS label WHERE label IN $labels RETURN DISTINCT label AS label', {
      labels: [...KNOWLEDGE_LABELS, ...LEGACY_KNOWLEDGE_LABELS],
    }).map(row => row.label as string);
    // shortcut: a legacy marker with another version must win over a fresh one, never the reverse.
    const schemaVersion = versions.length === 0 ? null : Math.min(...versions);
    const snapshot: KnowledgeSchemaSnapshot = { available: true, tableNames, schemaVersion: schemaVersion ?? undefined };
    return inspectKnowledgeSchema(snapshot);
  }

  override async dangerouslyReset(): Promise<void> {
    await this.dangerouslyClearAll();
  }

  override async dangerouslyClearAll(): Promise<void> {
    this.#pageStore.dangerouslyClearAll();
  }

  // Schema-4 page store: every method delegates to the page store.
  override materializeScope(input: Parameters<KnowledgePageStore['materializeScope']>[0]): ReturnType<KnowledgePageStore['materializeScope']> {
    return this.#pageStore.materializeScope(input);
  }
  override getScopesByAddress(addresses: string[]): ReturnType<KnowledgePageStore['getScopesByAddress']> {
    return this.#pageStore.getScopesByAddress(addresses);
  }
  override listScopeDeclarations(): ReturnType<KnowledgePageStore['listScopeDeclarations']> {
    return this.#pageStore.listScopeDeclarations();
  }
  override renameScopeDeclaration(input: Parameters<KnowledgePageStore['renameScopeDeclaration']>[0]): ReturnType<KnowledgePageStore['renameScopeDeclaration']> {
    return this.#pageStore.renameScopeDeclaration(input);
  }
  override listChildScopes(input: Parameters<KnowledgePageStore['listChildScopes']>[0]): ReturnType<KnowledgePageStore['listChildScopes']> {
    return this.#pageStore.listChildScopes(input);
  }
  override countChildScopes(input: Parameters<KnowledgePageStore['countChildScopes']>[0]): ReturnType<KnowledgePageStore['countChildScopes']> {
    return this.#pageStore.countChildScopes(input);
  }
  override getPage(input: Parameters<KnowledgePageStore['getPage']>[0]): ReturnType<KnowledgePageStore['getPage']> {
    return this.#pageStore.getPage(input);
  }
  override getPages(input: Parameters<KnowledgePageStore['getPages']>[0]): ReturnType<KnowledgePageStore['getPages']> {
    return this.#pageStore.getPages(input);
  }
  override getPageByPath(input: Parameters<KnowledgePageStore['getPageByPath']>[0]): ReturnType<KnowledgePageStore['getPageByPath']> {
    return this.#pageStore.getPageByPath(input);
  }
  override findPagesByName(input: Parameters<KnowledgePageStore['findPagesByName']>[0]): ReturnType<KnowledgePageStore['findPagesByName']> {
    return this.#pageStore.findPagesByName(input);
  }
  override listChildPages(input: Parameters<KnowledgePageStore['listChildPages']>[0]): ReturnType<KnowledgePageStore['listChildPages']> {
    return this.#pageStore.listChildPages(input);
  }
  override countChildPages(input: Parameters<KnowledgePageStore['countChildPages']>[0]): ReturnType<KnowledgePageStore['countChildPages']> {
    return this.#pageStore.countChildPages(input);
  }
  override listPages(input: Parameters<KnowledgePageStore['listPages']>[0]): ReturnType<KnowledgePageStore['listPages']> {
    return this.#pageStore.listPages(input);
  }
  override createPage(input: Parameters<KnowledgePageStore['createPage']>[0]): ReturnType<KnowledgePageStore['createPage']> {
    return this.#pageStore.createPage(input);
  }
  override updatePage(input: Parameters<KnowledgePageStore['updatePage']>[0]): ReturnType<KnowledgePageStore['updatePage']> {
    return this.#pageStore.updatePage(input);
  }
  override movePage(input: Parameters<KnowledgePageStore['movePage']>[0]): ReturnType<KnowledgePageStore['movePage']> {
    return this.#pageStore.movePage(input);
  }
  override mergePages(input: Parameters<KnowledgePageStore['mergePages']>[0]): ReturnType<KnowledgePageStore['mergePages']> {
    return this.#pageStore.mergePages(input);
  }
  override deletePage(input: Parameters<KnowledgePageStore['deletePage']>[0]): ReturnType<KnowledgePageStore['deletePage']> {
    return this.#pageStore.deletePage(input);
  }
  override replacePageBodyLinks(input: Parameters<KnowledgePageStore['replacePageBodyLinks']>[0]): ReturnType<KnowledgePageStore['replacePageBodyLinks']> {
    return this.#pageStore.replacePageBodyLinks(input);
  }
  override listPageBodyLinkSources(input: Parameters<KnowledgePageStore['listPageBodyLinkSources']>[0]): ReturnType<KnowledgePageStore['listPageBodyLinkSources']> {
    return this.#pageStore.listPageBodyLinkSources(input);
  }
  override countPageLinks(input: Parameters<KnowledgePageStore['countPageLinks']>[0]): ReturnType<KnowledgePageStore['countPageLinks']> {
    return this.#pageStore.countPageLinks(input);
  }
  override listPageLinks(input: Parameters<KnowledgePageStore['listPageLinks']>[0]): ReturnType<KnowledgePageStore['listPageLinks']> {
    return this.#pageStore.listPageLinks(input);
  }
  override getNote(input: Parameters<KnowledgePageStore['getNote']>[0]): ReturnType<KnowledgePageStore['getNote']> {
    return this.#pageStore.getNote(input);
  }
  override countNotes(input: Parameters<KnowledgePageStore['countNotes']>[0]): ReturnType<KnowledgePageStore['countNotes']> {
    return this.#pageStore.countNotes(input);
  }
  override listNotes(input: Parameters<KnowledgePageStore['listNotes']>[0]): ReturnType<KnowledgePageStore['listNotes']> {
    return this.#pageStore.listNotes(input);
  }
  override listNotesMentioning(input: Parameters<KnowledgePageStore['listNotesMentioning']>[0]): ReturnType<KnowledgePageStore['listNotesMentioning']> {
    return this.#pageStore.listNotesMentioning(input);
  }
  override addNote(input: Parameters<KnowledgePageStore['addNote']>[0]): ReturnType<KnowledgePageStore['addNote']> {
    return this.#pageStore.addNote(input);
  }
  override restampNote(input: Parameters<KnowledgePageStore['restampNote']>[0]): ReturnType<KnowledgePageStore['restampNote']> {
    return this.#pageStore.restampNote(input);
  }
  override removeNote(input: Parameters<KnowledgePageStore['removeNote']>[0]): ReturnType<KnowledgePageStore['removeNote']> {
    return this.#pageStore.removeNote(input);
  }
  override restoreNote(input: Parameters<KnowledgePageStore['restoreNote']>[0]): ReturnType<KnowledgePageStore['restoreNote']> {
    return this.#pageStore.restoreNote(input);
  }
  override searchPages(input: Parameters<KnowledgePageStore['searchPages']>[0]): ReturnType<KnowledgePageStore['searchPages']> {
    return this.#pageStore.searchPages(input);
  }
  override listPageActivity(input: Parameters<KnowledgePageStore['listPageActivity']>[0]): ReturnType<KnowledgePageStore['listPageActivity']> {
    return this.#pageStore.listPageActivity(input);
  }
  override addPinAudience(input: Parameters<KnowledgePageStore['addPinAudience']>[0]): ReturnType<KnowledgePageStore['addPinAudience']> {
    return this.#pageStore.addPinAudience(input);
  }
  override removePinAudience(input: Parameters<KnowledgePageStore['removePinAudience']>[0]): ReturnType<KnowledgePageStore['removePinAudience']> {
    return this.#pageStore.removePinAudience(input);
  }
  override listPins(input: Parameters<KnowledgePageStore['listPins']>[0]): ReturnType<KnowledgePageStore['listPins']> {
    return this.#pageStore.listPins(input);
  }
}
