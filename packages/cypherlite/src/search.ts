import { canonicalizeKnowledgeScope, isKnowledgeScopeVisible } from '@mastra/core/storage';
import type { SearchKnowledgeInput, SearchKnowledgeResult } from '@mastra/core/storage';

import type { AdapterContext, AdapterRow } from './connection';
import { projectColumns } from './connection';
import { KNOWLEDGE_EDGES } from './edges';
import { KNOWLEDGE_LABELS } from './schema';
import { readScope, scopeVisibleTo } from './scope';

const { node: NODE_LABEL, record: RECORD_LABEL } = KNOWLEDGE_LABELS;
const { mergedInto: MERGED_INTO_EDGE } = KNOWLEDGE_EDGES;

const DEFAULT_SEARCH_LIMIT = 20;
/** A record whose terminal node is outside the caller's scope is reported under this name. */
const PRIVATE_NODE_NAME = '(private node)';

const NODE_COLUMNS = projectColumns('n', ['id', 'name', 'content', 'description', 'scope']);

const RECORD_COLUMNS = [
  projectColumns('r', ['id', 'text', 'scope']),
  projectColumns('terminal', [
    ['id', 'parentId'],
    ['name', 'parentName'],
    ['scope', 'parentScope'],
  ]),
].join(', ');

/**
 * The lexical predicate of the contract: every searchable property is lowercased and matched as a
 * substring, so `%`, `_` and `=` stay literal. `coalesce` keeps an absent property from turning the
 * whole `OR` into null.
 */
function matchesQuery(alias: string, properties: string[]): string {
  return properties.map(property => `toLower(coalesce(${alias}.${property}, '')) CONTAINS $query`).join(' OR ');
}

function toNodeResult(row: AdapterRow): SearchKnowledgeResult {
  const name = String(row.name);
  return {
    type: 'node',
    id: String(row.id),
    recordId: String(row.id),
    name,
    // Description joins the snippet only when present so description-less results stay byte-identical.
    text: [
      name,
      ...(row.description ? [String(row.description)] : []),
      ...(row.content ? [String(row.content)] : []),
    ].join('\n'),
    scope: readScope(row.scope),
  };
}

/**
 * Lexical search over the Knowledge graph, in two statements: visible unmerged nodes matched on
 * name/kind/content/description, then undeleted records matched on text with their terminal parent
 * resolved through the merge chain. Node hits fill the page first, exactly like the reference
 * implementation.
 */
export function searchKnowledge(ctx: AdapterContext, input: SearchKnowledgeInput): SearchKnowledgeResult[] {
  const queryScope = canonicalizeKnowledgeScope(input.scope);
  const query = input.query.trim().toLocaleLowerCase();
  if (!query) return [];
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  const params = { query, queryScope, limit };

  const nodes = ctx.run(
    `MATCH (n:${NODE_LABEL})
     WHERE NOT (n)-[:${MERGED_INTO_EDGE}]->()
       AND ${scopeVisibleTo('n')}
       AND (${matchesQuery('n', ['name', 'kind', 'content', 'description'])})
     RETURN ${NODE_COLUMNS}
     ORDER BY n.updatedAt DESC, n.name ASC, n.id ASC
     LIMIT $limit`,
    params,
  );

  const results = nodes.map(toNodeResult);
  const remaining = limit - results.length;
  if (remaining <= 0) return results;

  const records = ctx.run(
    `MATCH (r:${RECORD_LABEL})
     WHERE r.deletedAt IS NULL
       AND ${scopeVisibleTo('r')}
       AND ${matchesQuery('r', ['text'])}
     MATCH (parent:${NODE_LABEL} {id: r.node})
     MATCH (parent)-[:${MERGED_INTO_EDGE}*0..]->(terminal:${NODE_LABEL})
     WHERE NOT (terminal)-[:${MERGED_INTO_EDGE}]->()
     RETURN ${RECORD_COLUMNS}
     ORDER BY r.id DESC
     LIMIT $limit`,
    { ...params, limit: remaining },
  );
  // A record whose parent node is gone is not attributable to a name and is skipped, like the reference.
  for (const row of records) {
    const parentVisible = isKnowledgeScopeVisible(readScope(row.parentScope), queryScope);
    results.push({
      type: 'record',
      id: String(row.id),
      recordId: parentVisible ? String(row.parentId) : String(row.id),
      name: parentVisible ? String(row.parentName) : PRIVATE_NODE_NAME,
      text: String(row.text),
      scope: readScope(row.scope),
    });
  }
  return results;
}
