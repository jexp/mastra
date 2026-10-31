# Knowledge storage on CypherLite: Cypher versus an object API

This is an internal engineering note, not a published documentation route. It records the decision behind the `@mastra/cypherlite` package.

`@mastra/cypherlite` implements the `KnowledgeStorage` contract on top of CypherLite, an in-process openCypher engine. The contract declares 22 abstract methods in `packages/core/src/storage/domains/knowledge/base.ts` (`base.ts:947`), plus the schema and structural-scope hooks the base class answers itself. `InMemoryKnowledgeStorage` in `inmemory.ts` defines the behavior every adapter has to match. Before writing the adapter, one question decides its shape: implement the contract methods as Cypher statements, or as object-API code over node and relationship handles, the way Neo4j embedded or Blueprints would have you write it?

Each axis below is rated from the Cypher side as **easier**, **harder**, or **neutral** relative to an object API implementing the same contract. CypherLite exposes no object API. Its JavaScript client offers `query(cypher, params)`, `begin()`, `commit()`, and `rollback()` (`clients/javascript/index.d.ts:198-210` in the CypherLite repository), so the object column describes a counterfactual rather than an option in this repository. It is worth stating because the handle API is the more familiar shape, and its costs are easy to overlook.

## Summary

| Axis                        | Cypher verdict | Reason                                                                                                                    |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Per-method logic            | Easier         | Scope subset, outbox claim, and CAS update are one statement each; only merge-chain resolution is more natural as a loop  |
| Transactional unit          | Neutral        | Both bind one adapter method to one transaction; CypherLite adds explicit begin, commit, and rollback handling            |
| Schema and constraints      | Neutral        | Constraint and index DDL is Cypher, and the Schema builder declares the same things; Blueprints has no constraints at all |
| Testing story               | Harder         | Logic moves into query strings that type-checking does not cover, so mistakes surface only at execution                   |
| Persistence and concurrency | Neutral        | Durability, locking, and writer count are engine properties and do not change with access style                           |
| Migration and lock-in       | Easier         | `resolveNode`'s walk and `updateNode`'s predicate are query text that ports; object code binds to handle and lock types   |
| Performance shape           | Easier         | Set-shaped work runs in-engine behind one call; an object API scans and makes N+1 calls                                   |

## Per-method logic

Most contract methods map to a single parameterized statement, and the ones that do not map to two.

`listNodes` (`base.ts:951`) filters by scope visibility, which `isKnowledgeScopeVisible` (`base.ts:728`) defines as a subset test: every entry in the record scope must appear in the query scope. The Cypher form is a list predicate, and `coalesce` matters because `all()` over a missing property evaluates to null and drops the row:

```cypher
MATCH (n:KNode)
WHERE all(entry IN coalesce(n.scope, []) WHERE entry IN $queryScope)
RETURN n
ORDER BY n.name, n.id
LIMIT $limit
```

`updateNode` (`base.ts:952`) is a compare-and-set. `InMemoryKnowledgeStorage` checks `existing.version !== input.version` and throws `KnowledgeConflictError` (`inmemory.ts:440-448`). The statement does the same with a version predicate:

```cypher
MATCH (n:KNode {id: $id})
WHERE n.version = $version
SET n.version = n.version + 1,
    n.name = $name,
    n.updatedAt = $now
RETURN n
```

Zero rows is ambiguous between a missing node and a stale version, so the adapter reads the node once inside the same transaction to choose between `KnowledgeNotFoundError` and `KnowledgeConflictError`.

`claimSemanticOutbox` (`base.ts:997`) is the most valuable single-statement win. `inmemory.ts:753-785` filters pending or stale entries, filters on `availableAt`, applies the scope subset test, and then drops every entry that has an earlier non-completed entry for the same document. All of that is expressible together, with the ordering and the mutation in the same statement:

```cypher
MATCH (e:KOutbox)
WHERE (e.status = 'pending'
   OR (e.status = 'processing' AND e.claimedAt <= $staleBefore))
  AND e.availableAt <= $now
  AND all(entry IN coalesce(e.scope, []) WHERE entry IN $queryScope)
  AND NOT EXISTS {
    MATCH (earlier:KOutbox {documentId: e.documentId})
    WHERE earlier.status <> 'completed'
      AND (earlier.createdAt < e.createdAt
        OR (earlier.createdAt = e.createdAt AND earlier.id < e.id))
  }
WITH e
ORDER BY e.createdAt, e.id
LIMIT $limit
SET e.status = 'processing',
    e.claimedAt = $now,
    e.claimedBy = $workerId,
    e.attempts = e.attempts + 1
RETURN e
```

Store `claimedAt`, `availableAt`, and `createdAt` as `datetime` values, not strings. CypherLite round-trips ISO-8601 with milliseconds and keeps comparison and `ORDER BY` on the datetime type; `toString(datetime(...))` drops zero seconds, so compare the values or use `epochMillis` instead of string output.

Merge-chain resolution is the one place where the object API reads better. `resolveNode` (`base.ts:950`) and `mergeNodes` (`base.ts:953`) both need the terminal node of a `mergedInto` chain, which `InMemoryKnowledgeStorage` walks with a `seen` set (`inmemory.ts:854-863`). A variable-length path with the zero-hop lower bound covers the chain, and CypherLite verified this form:

```cypher
MATCH p = (n:KNode {id: $id})-[:MERGED_INTO*0..]->(t:KNode)
WHERE NOT (t)-[:MERGED_INTO]->()
RETURN t AS terminal, length(p) AS hops
ORDER BY hops DESC
LIMIT 1
```

`*0..` resolves a node that is already terminal to itself; `*1..` returns no row for it. The walk is bounded by relationship uniqueness, so no hop limit is required, and a cycle returns no terminal row at all. The adapter keeps a fallback to the start id and raises the same merge-cycle error the in-memory implementation raises.

## Transactional unit

The unit of atomicity is one adapter method in both designs. `appendKnowledge` (`base.ts:955`) writes a knowledge record and its mentions, records an activity event, and enqueues outbox work. `updateNode` changes a node, replaces mentions, records activity, and enqueues outbox entries. `InMemoryKnowledgeStorage` wraps each of those in `#runAtomicMutation` (`inmemory.ts:817-852`), which snapshots every map and restores the snapshot on throw.

CypherLite provides single-level explicit transactions over an autocommit default, with no nested transactions and no savepoints. A failing statement does not roll back on its own, and closing the connection does not roll back. Every adapter method therefore needs the same explicit frame:

```ts
conn.begin()
try {
  // one or two statements for the method
  conn.commit()
} catch (error) {
  conn.rollback()
  throw error
}
```

Reads inside the transaction see its own uncommitted writes, and `rollback` discards them, both verified against the engine. Helper methods must not open their own transaction, because nesting is unsupported. That constraint is easy to follow here since the in-memory implementation already keeps mutation helpers private and non-transactional.

## Schema and constraints

Constraint and index declarations are Cypher statements that ship with the adapter, not typed builder objects. `createNode` (`base.ts:947`) and `getNodeByName` (`base.ts:949`) both need `(name, scope)` uniqueness, and `recordKey` (`inmemory.ts:87`) already derives a single comparable key from the two values. Reusing that derivation lets a single-property unique constraint carry the rule:

```cypher
CREATE CONSTRAINT knowledge_node_id IF NOT EXISTS
  FOR (n:KNode) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT knowledge_node_key IF NOT EXISTS
  FOR (n:KNode) REQUIRE n.key IS UNIQUE;
CREATE INDEX knowledge_node_name IF NOT EXISTS
  FOR (n:KNode) ON (n.name);
CREATE FULLTEXT INDEX knowledge_record_search IF NOT EXISTS
  FOR (r:KRecord) ON EACH [r.title, r.text];
```

`search` (`base.ts:965`) uses those indexes. Keyword search goes through `SEARCH ... IN (FULLTEXT INDEX ...)`, which returns no relevance score: `score()` is not a function in this engine. Ranked results need `CALL db.index.fulltext.queryNodes('knowledge_record_search', $term) YIELD node, score`, which takes exactly two arguments. Vector search uses a vector index on the embedding property with `WITH [...]` for the filterable properties.

Uniqueness is enforced per statement, not across concurrent transactions (`docs/limitations.md:68-85` in the CypherLite repository). Two transactions that each create the same unique value can both commit when neither runs a later statement, because commit conflict detection compares element ids only. Keeping the lookup and the create in one transaction, and serializing writers, is what closes that gap; the adapter should not rely on the constraint alone.

The remaining schema hooks stay honest. `getCapabilities` reports the v2 contract with `supportsSchemaInspection: true`, `inspectSchema` reads the label list and the `KMeta` version marker, and `dangerouslyReset` deletes only the Knowledge labels. The structural scope methods live on the same graph: `reconcileStructure` creates one `KScope` per address and writes the `SCOPE_PARENT` and `SCOPE_GRANT` edges a plan declares, and `listScopeNodes` and `listScopeMembers` page over `KScope` nodes and `IN_SCOPE` placement edges.

## Testing story

Contract tests can run synchronously against `Database.open(':memory:')`, with no server to start and no async teardown, and they can assert on `result.rows`, `result.stats`, and `result.columnTypes`. `EXPLAIN` and `PROFILE` add plan-level assertions through `result.plan` and `result.notifications`.

The cost is where the logic lives. The scope predicate in `listNodes`, the earliest-blocking guard in `claimSemanticOutbox`, the version predicate in `updateNode`, and the merge path in `resolveNode` all become query text. TypeScript cannot check a label name, a property key, or a list predicate, so a typo surfaces only when the native engine parses the statement. The mirrored contract suite becomes the real safety net, and every statement deserves a focused test against a small fixture. `InMemoryKnowledgeStorage` stays useful as a fake for higher-level tests, but it cannot validate query text.

## Persistence and concurrency

Persistence is an engine property, so the access style does not change it. CypherLite supports `:memory:`, a single file, or a directory, with WAL plus one snapshot codec and the whole graph in RAM. A directory database is single process: concurrent threads may read together, and overlapping writers get `write-write conflict` at WAL append with no silent retry. The adapter keeps one writer handle and retries that error.

Two contract methods lean on those semantics. `claimSemanticOutbox` (`base.ts:997`) assumes a claim is atomic for a worker, which a single statement plus the serialized writer provides. `updateNode` (`base.ts:952`) retries its version-predicated statement on a write-write conflict. Neo4j embedded offers a page cache, thread-bound transactions, write locks, and index population to await at startup, but it offers the same one-process model. Blueprints promises nothing portable at all: its documentation leaves durability and isolation to the implementation.

## Migration and lock-in

The adapter's logic is Cypher text over a thin `query(cypher, params)` surface, so moving to Neo4j server or embedded means swapping the client and fixing dialect details. Two contract methods show what travels. `resolveNode` (`base.ts:950`) keeps the merge-chain walk as data: the `MATCH p = (n:KNode {id: $id})-[:MERGED_INTO*0..]->(t) WHERE NOT (t)-[:MERGED_INTO]->()` path from the Per-method logic section is openCypher, and Neo4j server and embedded both parse it unchanged. `updateNode` (`base.ts:952`) keeps its compare-and-set in the `WHERE n.version = $version` predicate of its `SET`. The constraint DDL is Neo4j's own syntax. What remains coupled is narrow and documented: CypherLite's dialect, its single-level transaction API, and its per-statement constraint checking. None of it is a handle type.

The same two methods written against an object API bind to handles instead. As handles, `resolveNode`'s walk is a loop over `node.getSingleRelationship(MERGED_INTO, Direction.OUTGOING)` and `relationship.getEndNode()`, with a `seen` set for cycles, so the method needs a `Direction` enum, a single-relationship accessor with its throw-on-multiple rule, and a relationship-type object from the target engine. Blueprints offers none of those shapes: it exposes `getEdges(Direction, labels)` on a vertex and has no typed single-relationship accessor, so the method is rewritten rather than recompiled. `updateNode` is worse off: with no statement to carry the version predicate, the object form has to call `tx.acquireWriteLock(node)`, read `node.getProperty('version')`, compare, then write, and Blueprints has no lock API at all, so the compare-and-set has no portable expression.

The handle types themselves moved across Neo4j releases. Version 3.5 put `createNode`, `findNodes`, `schema`, `traversalDescription`, and `execute` on `GraphDatabaseService`. Version 4.4 moved node, schema, and traversal access to `Transaction` and put `executeTransactionally` on `GraphDatabaseService`. Java Cypher entry points moved from `org.neo4j.cypher.javacompat.ExecutionEngine` through `GraphDatabaseService.execute` to `Transaction.execute`. Blueprints 2.6.0 shipped in 2014 and is marked no longer active, superseded by Apache TinkerPop 3.

## Performance shape

One `conn.query` call per contract method crosses the JavaScript to C boundary once. Matching, scope filtering, ordering, pagination, and mutation all happen inside the in-RAM typed-CSR engine, and an index or constraint on `id` and the derived key keeps `getNode` and `getNodeByName` off a scan.

Two costs are worth designing around. Result rows are fully materialized, with no cursor, so wide pages from `listKnowledgeMentioning`, `listActivity`, or `search` pay a full marshal. And `MERGE`-per-row upserts measured quadratic in CypherLite even with a uniqueness constraint: 10k rows in 0.16s, 50k in 3.1s, 100k in 12.2s, measured 2026-09-20. Hot write paths should anchor on an indexed `MATCH` followed by `CREATE`, and reserve `MERGE ... ON CREATE ... ON MATCH` for statements that need both branches.

An object API has no boundary crossing for per-node pointer walks, which is what makes it cheap for that shape. Set-shaped work is where it degrades: `findNodes` supports only label plus property equality, and `findNode` throws when more than one node matches. A method such as `listNodes` or `claimSemanticOutbox` then becomes an adapter-side loop over every labeled node, one call per node.

## Adapter shape

Implement the adapter in Cypher. Each contract method becomes one or two parameterized statements inside one `begin` and `commit` unit. Use `all(entry IN coalesce(n.scope, []) WHERE entry IN $queryScope)` for visible-scope filtering, a `NOT EXISTS` earliest-blocking guard plus `SET` for outbox claims, a version predicate plus `SET` for compare-and-set, and the `*0..` path plus a fallback for merge terminals.

Two costs are accepted. Query text is not compile-checked, so the mirrored contract suite carries the correctness burden. And the single-writer, per-statement constraint model means lookups and uniqueness checks stay in one transaction.

## Sources

- Contract and reference behavior: `packages/core/src/storage/domains/knowledge/base.ts`, `packages/core/src/storage/domains/knowledge/inmemory.ts`.
- CypherLite client and engine behavior: `clients/javascript/index.d.ts`, `docs/api/javascript/spec.md`, `docs/limitations.md`, and `docs/reference/cypher-syntax.md` in the CypherLite repository. Statement behavior above was verified against `cypherlite query -d :memory:` on 2026-10-29.
- Neo4j embedded API: the [Neo4j 3.5 Java reference](https://neo4j.com/docs/java-reference/3.5/javadocs/) and the [Neo4j 4.4 Java reference](https://neo4j.com/docs/java-reference/4.4/javadocs/), plus the [Neo4j migration guide](https://neo4j.com/docs/migration-guide/current/).
- Object-API predecessor: the [Blueprints repository](https://github.com/tinkerpop/blueprints), including its 2.6.0 release notes and Graph Indices and Graph Transactions wiki pages.
