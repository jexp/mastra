import { canonicalizeKnowledgeScope, knowledgeScopeKey } from '@mastra/core/storage';
import type { KnowledgeScope } from '@mastra/core/storage';

/**
 * The two properties every Knowledge label stores for scope handling: the canonical scope list
 * (kept as a LIST so visibility is a set predicate) and its key (kept as a scalar so `(scopeKey,
 * nameLower)` can carry one uniqueness constraint).
 */
export interface StoredScope {
  scope: KnowledgeScope;
  scopeKey: string;
}

/** Canonicalizes a caller scope and derives the stored `scope` / `scopeKey` properties from it. */
export function storeScope(scope: KnowledgeScope): StoredScope {
  const canonical = canonicalizeKnowledgeScope(scope);
  return { scope: canonical, scopeKey: knowledgeScopeKey(canonical) };
}

/** Reads a stored `scope` LIST property back into a scope; a missing property is an empty scope. */
export function readScope(value: unknown): KnowledgeScope {
  return Array.isArray(value) ? value.map(entry => String(entry)) : [];
}

/**
 * The `WHERE` predicate that keeps a row visible to the caller: the row's scope is a subset of
 * `$queryScope`. `coalesce` keeps a row without a stored scope from being dropped by `all()` over
 * null (Knowledge rows always store one; the guard costs nothing).
 */
export function scopeVisibleTo(alias: string, parameter = 'queryScope'): string {
  return `all(entry IN coalesce(${alias}.scope, []) WHERE entry IN $${parameter})`;
}
