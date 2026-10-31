/**
 * Relationship types the Knowledge adapter writes. Structural placement and merge resolution are
 * shared by more than one domain module, so the names live here rather than in whichever domain
 * happens to query them.
 */
export const KNOWLEDGE_EDGES = {
  /** Placement: a content node or a child scope sits inside a structural scope (`KNode`/`KScope` -> `KScope`). */
  inScope: 'IN_SCOPE',
  /** Scope hierarchy: a child scope declares a parent scope (`KScope` -> `KScope`). */
  scopeParent: 'SCOPE_PARENT',
  /** Access grant: a scope grants a role on another scope (`KScope` -> `KScope`). */
  scopeGrant: 'SCOPE_GRANT',
  /** Terminal resolution: a merged node points at the node it was merged into (`KNode` -> `KNode`). */
  mergedInto: 'MERGED_INTO',
  /** Wikilink derivation: a record or node names a node in its text (`KRecord`/`KNode` -> `KNode`). */
  mentions: 'MENTIONS',
} as const;
