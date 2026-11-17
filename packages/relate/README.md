# @mastra/relate

Relate-backed knowledge storage for Mastra.

The package implements Mastra's experimental Knowledge storage domain (the schema-4 page store) on top of
[Relate](https://relatedb.ai), an embedded openCypher graph engine, through the published Node.js client
[`@relate/relate`](https://www.npmjs.com/package/@relate/relate) (platform native libraries ship as optional
dependencies — no C toolchain, no env vars).

## Usage

```ts
import { MastraCompositeStore } from '@mastra/core/storage';
import { RelateKnowledgeStorage } from '@mastra/relate';

const storage = new MastraCompositeStore({
  id: 'storage',
  domains: {
    knowledge: new RelateKnowledgeStorage({ path: './knowledge.db' }),
  },
});
```

Pass `path` for an embedded database (`:memory:`, a `.rl` file, or a directory) or `connection` for a Relate
connection you opened yourself. Pass exactly one. Constructing the store is side-effect free — the database
connects lazily on first use — and the composite store calls `init()` before first use, which stamps the
schema-4 version marker idempotently.

## Constructor options

- `path` (string): Path opened with `Database.open(path).connect()`. Use `:memory:` for an ephemeral store.
- `connection` (`Connection`): An already-open Relate connection. The caller keeps ownership of the database.
- `storageIsolationKey` (string): Overrides the derived storage-isolation key. Two Knowledge domains over
  the same file (or the same connection) report the same key, so Mastra's shared-storage guard can reject
  them; `:memory:` handles each count as their own backend.

`storage.connection` exposes the open connection, so application code can run raw Cypher against the same
database. Knowledge data uses one label per domain — `KPage` (pages and scope pages), `KNote`, `KPin`,
`KActivity`, `KBodyLink` — plus a `KMeta` schema marker. Timestamps are stored as epoch milliseconds.

## Graph schema

Everything the contract stores is a node property; pages reference parents and scopes by id, notes carry
stamp scopes and resolved mentions as id lists, and body links are one `KBodyLink` node per (page, ref):

```cypher
MATCH (p:KPage {isScope: false}) RETURN p.name, p.key, p.body LIMIT 10
MATCH (scope:KPage {isScope: true}) RETURN scope.address, scope.declaration
```

The label layout is vault-friendly: pages keep their body in one `body` property, so a store can be opened
as a Relate **markdown vault** (`relate --snapshot-format markdown --database ./knowledge-vault`, created on
an empty directory) and the pages round-trip as `KPage/<name>.md` files (one per page, named after the page
name) with YAML frontmatter and `[[wikilinks]]`, readable in Obsidian. Edits to a file's body are picked up
at the next open; editing the YAML frontmatter itself is not supported by `@relate/relate` 1.0.1 and can
make the next open fail — treat the frontmatter as generated.

## Soft delete

`deletePage()` marks a page instead of deleting it: the page keeps its `KPage` label, gains `deletedAt` and
`deletedBy` properties, and listings and searches skip it. `getPage` still returns a removed page (with
`deletedAt` set) — that is the schema-4 contract — while `getPages`, `getPageByPath` and the list/find
methods treat it as gone. `getNote({ includeDeleted })` and `listNotes` with `includeDeleted` return removed
notes; `restoreNote()` brings them back. `mergePages()` soft-deletes the source with `mergedInto` pointing
at the target.

`init()` drops a pre-schema-4 (schema-2, CypherLite-era) store on first use — that data was experimental and
is not migrated — while a schema-4 marker from a newer release makes `init()` refuse until
`dangerouslyReset()` is called. `dangerouslyReset()` deletes only the Knowledge labels (including the legacy
`KNode`, `KRecord`, `KOutbox`, `KScope`) and leaves every application node in the same database in place.

## Local development

```bash
pnpm install --filter "@mastra/relate..."
pnpm turbo build --filter=@mastra/relate   # builds @mastra/core and the other dependencies first
pnpm --filter @mastra/relate test          # contract suite against the reference scenarios
pnpm --filter @mastra/relate typecheck
pnpm --filter @mastra/relate lint
```

## Documentation

The adapter is documented at [Relate Storage](https://mastra.ai/reference/storage/relate).

## Support

We have an [open community Discord](https://discord.gg/mastra-ai). Come and say hello and let us know if you have any questions or need any help getting things running.
