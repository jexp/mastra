---
'@mastra/cypherlite': minor
---

Added `@mastra/cypherlite`, a storage adapter that keeps knowledge nodes and records in an embedded [CypherLite](https://github.com/neo4j-labs/cypherlite) graph database. No database server is required.

```ts title="src/mastra/index.ts"
import { MastraCompositeStore } from '@mastra/core/storage';
import { CypherLiteKnowledgeStorage } from '@mastra/cypherlite';

const storage = new MastraCompositeStore({
  id: 'storage',
  domains: {
    knowledge: new CypherLiteKnowledgeStorage({ path: './knowledge.db' }),
  },
});
```

**What it stores**

- Knowledge nodes, records, mentions, activity and the semantic outbox, with merges as `MERGED_INTO` edges and structural scopes as `IN_SCOPE` edges.
- Records removed with `removeKnowledge()` stay in the graph under a `Deleted` label with `deletedAt` and `deletedBy`, and reads skip them unless you ask for removed records.
- `dangerouslyReset()` removes only the knowledge labels, so application nodes in the same database survive a reset.
