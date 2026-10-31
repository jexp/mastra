import type {
  AppendKnowledgeInput,
  ClaimKnowledgeSemanticOutboxInput,
  CreateKnowledgeNodeInput,
  KnowledgeActivityEvent,
  KnowledgeNode,
  KnowledgeRecord,
  KnowledgeSchemaInspection,
  KnowledgeScope,
  KnowledgeSemanticOutboxEntry,
  KnowledgeStorageCapabilities,
  KnowledgeStructurePlan,
  KnowledgeStructureReconcileResult,
  ListKnowledgeNodesInput,
  ListKnowledgeScopeMembersInput,
  ListKnowledgeScopeMembersOutput,
  ListKnowledgeScopeNodesInput,
  ListKnowledgeScopeNodesOutput,
  QueryKnowledgeBySourceInput,
  QueryKnowledgeInput,
  QueryKnowledgeOutput,
  SearchKnowledgeInput,
  SearchKnowledgeResult,
  UpdateKnowledgeNodeInput,
} from '@mastra/core/storage';
import {
  KNOWLEDGE_STORAGE_CONTRACT_VERSION,
  KNOWLEDGE_STORAGE_SCHEMA_VERSION,
  KnowledgeStorage,
} from '@mastra/core/storage';
import type { Connection } from '@neo4j-labs/cypherlite';

import { listKnowledgeActivity } from './activity';
import type { AdapterContext, CypherLiteStorageConfig } from './connection';
import { createAdapterContext } from './connection';
import type { KnowledgeNodeDomain } from './nodes';
import { createNodeDomain } from './nodes';
import { claimSemanticOutbox, completeSemanticOutbox, listSemanticOutbox, releaseSemanticOutbox } from './outbox';
import type { KnowledgeRecordDomain } from './records';
import { createRecordDomain } from './records';
import { initializeKnowledgeSchema, inspectKnowledgeSchemaStore, resetKnowledgeData } from './schema';
import type { KnowledgeScopeDomain } from './scopes';
import { createScopeDomain } from './scopes';
import { searchKnowledge } from './search';

/**
 * Persistent `KnowledgeStorage` on an embedded CypherLite graph.
 *
 * The graph schema is one label per Knowledge domain (`KNode`, `KRecord`, `KActivity`, `KOutbox`,
 * `KScope`) plus a `KMeta` version marker; merges are `MERGED_INTO` edges and structural placement
 * is `IN_SCOPE` edges. Time values are stored as epoch milliseconds.
 *
 * Each domain lives in its own module and is wired here; this class adds no query text of its own.
 */
export class CypherLiteKnowledgeStorage extends KnowledgeStorage {
  readonly #context: AdapterContext;
  readonly #nodes: KnowledgeNodeDomain;
  readonly #records: KnowledgeRecordDomain;
  readonly #scopes: KnowledgeScopeDomain;

  constructor(config: CypherLiteStorageConfig) {
    super();
    this.#context = createAdapterContext(config);
    this.#nodes = createNodeDomain(this.#context);
    this.#records = createRecordDomain(this.#context);
    this.#scopes = createScopeDomain(this.#context);
  }

  /** The open CypherLite connection (the client is synchronous). */
  get connection(): Connection {
    return this.#context.connection;
  }

  override getCapabilities(): KnowledgeStorageCapabilities {
    return {
      contractVersion: KNOWLEDGE_STORAGE_CONTRACT_VERSION,
      schemaVersion: KNOWLEDGE_STORAGE_SCHEMA_VERSION,
      supportsV2: true,
      supportsSchemaInspection: true,
      supportsExplicitReset: true,
    };
  }

  override async inspectSchema(): Promise<KnowledgeSchemaInspection> {
    return inspectKnowledgeSchemaStore(this.#context);
  }

  /** Creates the constraints and the schema marker; idempotent. */
  override async init(): Promise<void> {
    this.#context.transaction(() => initializeKnowledgeSchema(this.#context));
  }

  /** Deletes every Knowledge row and edge, keeping the schema marker and application data. */
  override async dangerouslyReset(): Promise<void> {
    this.#context.transaction(() => resetKnowledgeData(this.#context));
  }

  override async dangerouslyClearAll(): Promise<void> {
    return this.dangerouslyReset();
  }

  /** Applies a structural scope plan additively; the scope ids of every plan address come back in `scopes`. */
  override async reconcileStructure(plan: KnowledgeStructurePlan): Promise<KnowledgeStructureReconcileResult> {
    return this.#scopes.reconcileStructure(plan);
  }

  override async listScopeNodes(input?: ListKnowledgeScopeNodesInput): Promise<ListKnowledgeScopeNodesOutput> {
    return this.#scopes.listScopeNodes(input);
  }

  override async listScopeMembers(input: ListKnowledgeScopeMembersInput): Promise<ListKnowledgeScopeMembersOutput> {
    return this.#scopes.listScopeMembers(input);
  }

  override async createNode(input: CreateKnowledgeNodeInput): Promise<KnowledgeNode> {
    return this.#nodes.createNode(input);
  }

  override async getNode(id: string): Promise<KnowledgeNode | null> {
    return this.#nodes.getNode(id);
  }

  override async getNodeByName(input: { name: string; scope: KnowledgeScope }): Promise<KnowledgeNode | null> {
    return this.#nodes.getNodeByName(input);
  }

  override async resolveNode(input: { name: string; scope: KnowledgeScope }): Promise<KnowledgeNode | null> {
    return this.#nodes.resolveNode(input);
  }

  override async listNodes(input: ListKnowledgeNodesInput): Promise<KnowledgeNode[]> {
    return this.#nodes.listNodes(input);
  }

  override async updateNode(input: UpdateKnowledgeNodeInput): Promise<KnowledgeNode> {
    return this.#nodes.updateNode(input);
  }

  override async mergeNodes(input: {
    sourceId: string;
    targetId: string;
    sourceVersion: number;
  }): Promise<KnowledgeNode> {
    return this.#nodes.mergeNodes(input);
  }

  override async appendKnowledge(input: AppendKnowledgeInput): Promise<KnowledgeRecord> {
    return this.#records.appendKnowledge(input);
  }

  override async getKnowledge(input: { id: string; includeDeleted?: boolean }): Promise<KnowledgeRecord | null> {
    return this.#records.getKnowledge(input);
  }

  override async listKnowledgeAbout(input: QueryKnowledgeInput): Promise<QueryKnowledgeOutput> {
    return this.#records.listKnowledgeAbout(input);
  }

  override async listKnowledgeMentioning(input: QueryKnowledgeInput): Promise<QueryKnowledgeOutput> {
    return this.#records.listKnowledgeMentioning(input);
  }

  override async listKnowledgeRelatedTo(input: QueryKnowledgeInput): Promise<QueryKnowledgeOutput> {
    return this.#records.listKnowledgeRelatedTo(input);
  }

  override async knowledgeBySource(input: QueryKnowledgeBySourceInput): Promise<QueryKnowledgeOutput> {
    return this.#records.knowledgeBySource(input);
  }

  override async removeKnowledge(input: { id: string; deletedBy: string }): Promise<KnowledgeRecord> {
    return this.#records.removeKnowledge(input);
  }

  override async restoreKnowledge(input: { id: string }): Promise<KnowledgeRecord> {
    return this.#records.restoreKnowledge(input);
  }

  override async rescopeKnowledge(input: { id: string; scope: KnowledgeScope }): Promise<KnowledgeRecord> {
    return this.#records.rescopeKnowledge(input);
  }

  override async search(input: SearchKnowledgeInput): Promise<SearchKnowledgeResult[]> {
    return searchKnowledge(this.#context, input);
  }

  override async listActivity(input: {
    scope: KnowledgeScope;
    after?: string;
    limit?: number;
  }): Promise<KnowledgeActivityEvent[]> {
    return listKnowledgeActivity(this.#context, input);
  }

  override async listSemanticOutbox(
    input: {
      status?: KnowledgeSemanticOutboxEntry['status'];
      scope?: KnowledgeScope;
      limit?: number;
    } = {},
  ): Promise<KnowledgeSemanticOutboxEntry[]> {
    return listSemanticOutbox(this.#context, input);
  }

  override async claimSemanticOutbox(
    input: ClaimKnowledgeSemanticOutboxInput,
  ): Promise<KnowledgeSemanticOutboxEntry[]> {
    return claimSemanticOutbox(this.#context, input);
  }

  override async completeSemanticOutbox(input: { ids: string[]; workerId: string }): Promise<void> {
    completeSemanticOutbox(this.#context, input);
  }

  override async releaseSemanticOutbox(input: { ids: string[]; workerId: string; retryAt?: Date }): Promise<void> {
    releaseSemanticOutbox(this.#context, input);
  }
}
