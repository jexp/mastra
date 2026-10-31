/**
 * @mastra/cypherlite — CypherLite-backed knowledge storage for Mastra.
 *
 * The public surface is the storage class and its config; the domain modules below it are
 * package-internal and their tests import them directly.
 */
export const CYPHERLITE_PACKAGE_NAME = '@mastra/cypherlite';

export type { CypherLiteStorageConfig } from './connection';
export { CypherLiteKnowledgeStorage } from './storage';
