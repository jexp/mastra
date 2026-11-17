---
'@mastra/relate': minor
---

Added `@mastra/relate`, a storage adapter that keeps the Knowledge page store in an embedded [Relate](https://relatedb.ai) graph database. No database server is required.

```ts title="src/mastra/index.ts"
import { MastraCompositeStore } from '@mastra/core/storage';
import { RelateKnowledgeStorage } from '@mastra/relate';

const storage = new MastraCompositeStore({
  id: 'storage',
  domains: {
    knowledge: new RelateKnowledgeStorage({ path: './knowledge.db' }),
  },
});
```

**What it stores**

- The Knowledge schema-4 page store: scope pages and declarations, pages with bodies and `[[wikilink]]` body links, notes with mentions, page activity, and page search — the full `KnowledgePageStore` contract over openCypher.
- Pages removed with `deletePage()` stay in the graph with `deletedAt`/`deletedBy` set; listings and searches skip them, and `getPage` still returns them, per the schema-4 contract.
- `init()` drops stores left behind by the earlier experimental schema-2 release instead of migrating them, and refuses a schema-4 marker from a newer release until `dangerouslyReset()` is called. `dangerouslyReset()` removes only the Knowledge labels, so application nodes in the same database survive a reset.
- The store can be opened as a Relate **markdown vault** (`relate --snapshot-format markdown`): pages round-trip as `KPage/<name>.md` files with frontmatter and `[[wikilinks]]`, readable in Obsidian, with body edits picked up on the next open (the frontmatter itself is generated and not safe to edit).
