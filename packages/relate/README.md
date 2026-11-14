# @mastra/cypherlite

CypherLite-backed knowledge storage for Mastra.

The package implements Mastra's experimental Knowledge storage domain on top of
[CypherLite](https://github.com/neo4j-labs/cypherlite), an in-process openCypher graph engine. It reaches the
engine through `@neo4j-labs/cypherlite`, the Node.js client that wraps the C ABI with koffi.

## Usage

```ts
import { MastraCompositeStore } from '@mastra/core/storage';
import { CypherLiteKnowledgeStorage } from '@mastra/cypherlite';

const storage = new MastraCompositeStore({
  id: 'storage',
  domains: {
    knowledge: new CypherLiteKnowledgeStorage({ path: './knowledge.db' }),
  },
});
```

Pass `path` for an embedded database (`:memory:`, a file, or a directory) or `connection` for a CypherLite
connection you opened yourself. Pass exactly one. The constructor opens the database synchronously; call `init()`
once to create the constraints and the schema version marker. `init()` is idempotent and refuses to write over a
store that already holds Knowledge labels but carries a missing or incompatible schema version marker.

## Constructor options

- `path` (string): Path opened with `Database.open(path).connect()`. Use `:memory:` for an embedded database.
- `connection` (`Connection`): An already-open CypherLite connection. The caller keeps ownership of the database.

`storage.connection` exposes the open connection, so application code can run raw Cypher against the same
database. Knowledge data uses the labels `KNode`, `KRecord`, `KActivity`, `KOutbox`, and `KScope`, plus a `KMeta`
schema marker. Merges are `MERGED_INTO` edges (the source points at the terminal node) and structural placement
is `IN_SCOPE` edges. Timestamps are stored as epoch milliseconds.

## Soft delete

`removeKnowledge()` marks a record instead of deleting it:

- The record node keeps its `KRecord` label and gains the `Deleted` label, with `deletedAt` (epoch milliseconds)
  and `deletedBy` properties. The API exposes both as a `Date` and a string.
- Every read filters on `NOT r:Deleted` unless you pass `includeDeleted`, and `getKnowledge({ includeDeleted })`
  returns a removed record.
- `restoreKnowledge()` removes the label and clears both properties. The record's `MENTIONS` edges survive the
  delete and restore cycle because only labels and properties change.
- Removing an already removed record is a no-op that returns the stored record.

`Deleted` is deliberately not one of the Knowledge data labels. Schema inspection and
`dangerouslyReset()` key off `KRecord`, so an application node that happens to carry a `Deleted` label is never
treated as Knowledge structure or removed by a reset. A reset deletes the Knowledge labels and the edges between
them and leaves the `KMeta` marker and all application data in place.

## Local development

The package depends on the CypherLite JavaScript client through a `file:` link to a CypherLite checkout:

```json
"dependencies": {
  "@neo4j-labs/cypherlite": "file:/path/to/cypherlite/clients/javascript"
}
```

Install the workspace with the filter so pnpm links that client, and build the CypherLite native library first:

```bash
pnpm install --filter "@mastra/cypherlite..."
cargo build --release -p cypherlite-ffi --manifest-path /path/to/cypherlite/Cargo.toml
```

The client loads a platform native library. For a CypherLite checkout, point `CYPHERLITE_LIB` at the built
`libcypherlite_ffi` before running the tests:

```bash
CYPHERLITE_LIB=/path/to/cypherlite/target/release/libcypherlite_ffi.dylib pnpm --filter @mastra/cypherlite test
```

Use the platform suffix for your system: `.dylib` on macOS, `.so` on Linux, `.dll` on Windows.

## Documentation

The adapter is documented at [CypherLite Storage](https://mastra.ai/reference/storage/cypherlite).

## Support

We have an [open community Discord](https://discord.gg/mastra-ai). Come and say hello and let us know if you have any questions or need any help getting things running.
