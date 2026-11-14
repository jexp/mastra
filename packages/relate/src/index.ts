/**
 * @mastra/relate — Relate-backed knowledge storage for Mastra.
 *
 * The public surface is the storage class and its config; the domain modules below it are
 * package-internal and their tests import them directly.
 */
export const RELATE_PACKAGE_NAME = '@mastra/relate';

export type { RelateStorageConfig } from './connection';
export { RelateKnowledgeStorage } from './storage';
