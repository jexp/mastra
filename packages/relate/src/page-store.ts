/**
 * Relate-backed schema-4 Knowledge page store.
 *
 * A port of `InMemoryKnowledgePageStore` (packages/core, the reference implementation the shared
 * contract suite checks) over the embedded Relate engine: every entity is a graph node (`KPage`,
 * `KNote`, `KPin`, `KActivity`, `KBodyLink`), every public method runs inside one engine
 * transaction, and mutated objects are written back whole (`MERGE … SET n = $props`, where a null
 * property value removes the property — verified against the engine). Reads fetch candidate rows
 * with Cypher and apply the reference's exact JS filters, sorts and pagination, so the semantics
 * (read-scope visibility, ordering, cursors, bounds) match the reference rather than re-deriving
 * them in Cypher. The contract explicitly allows this: `knowledgeScopeReadable` exists for
 * "adapters that filter in memory".
 *
 * Within a frame a per-transaction cache gives the reference's object identity: `#fetchPage`
 * returns the same object a mutation changed, and only the dirty set is flushed. Public methods
 * never call each other (the same discipline as the reference), so frames never nest.
 */

import {
  KnowledgeConflictError,
  KnowledgeNotFoundError,
  assertKnowledgeNoteTextWithinBound,
  assertKnowledgePageDescriptionWithinBound,
  canonicalKnowledgeName,
  knowledgePinDepth,
  knowledgePositionBetween,
  knowledgeScopeReadable,
  KnowledgeMoveTooLargeError,
  KnowledgePageDepthError,
  KnowledgePageHasChildrenError,
  KnowledgePageKeyConflictError,
  MAX_KNOWLEDGE_MOVE_PAGES,
  MAX_KNOWLEDGE_PAGE_DEPTH,
  MAX_KNOWLEDGE_PAGE_LINKS,
  MAX_KNOWLEDGE_PAGE_LIST_LIMIT,
} from '@mastra/core/storage';
import type {
  KnowledgeListedPin,
  KnowledgeNote,
  KnowledgePage,
  KnowledgePageActivityAction,
  KnowledgePageActivityEvent,
  KnowledgePageBodyLink,
  KnowledgePageLinkCounts,
  KnowledgePageLinkEdge,
  KnowledgePageLinkKind,
  KnowledgePageListOutput,
  KnowledgePageSearchHit,
  KnowledgePageStore,
  KnowledgeNoteListOutput,
  KnowledgePin,
  KnowledgePinKind,
  KnowledgeProvenance,
  KnowledgeReadScope,
} from '@mastra/core/storage';

import type { ParamValue } from '@relate/relate';
import type { AdapterContext } from './connection';
import { projectColumns } from './connection';

// Ported from @internal/core/knowledge-compat (an unpublished workspace package, so adapters copy
// these three; keep them byte-identical to the reference's behavior).
const KNOWLEDGE_SEARCH_MAX_WORDS = 16;
const KNOWLEDGE_SEARCH_WEIGHTS = { name: 3, description: 2, body: 1 } as const;
function knowledgeSearchWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, KNOWLEDGE_SEARCH_MAX_WORDS);
}
function knowledgePageKeyProblem(key: string): string | undefined {
  if (!key) return 'Knowledge page key must not be empty';
  if (/[/#%]/.test(key)) return `Knowledge page key "${key}" must not contain "/", "#" or "%"`;
  return undefined;
}

type Store = KnowledgePageStore;
type Subtree = Array<{ page: KnowledgePage; relativeDepth: number }>;

const DEFAULT_SEARCH_LIMIT = 20;

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return MAX_KNOWLEDGE_PAGE_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`Knowledge list limit must be a positive integer`);
  return Math.min(limit, MAX_KNOWLEDGE_PAGE_LIST_LIMIT);
}

function paginate<T>(items: T[], cursor: string | undefined, limit: number | undefined) {
  const start = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(start) || start < 0) throw new RangeError(`Invalid Knowledge cursor: ${cursor}`);
  const size = pageSize(limit);
  const slice = items.slice(start, start + size);
  return { items: slice, nextCursor: start + size < items.length ? String(start + size) : undefined };
}

const compareCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const byPosition = (a: KnowledgePage, b: KnowledgePage) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const byName = (a: KnowledgePage, b: KnowledgePage) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const newestFirst = <T extends { createdAt: Date; id: string }>(a: T, b: T) =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const oldestFirst = <T extends { createdAt: Date; id: string }>(a: T, b: T) => newestFirst(b, a);

const clone = <T>(value: T): T => structuredClone(value);

const PIN_KINDS: KnowledgePinKind[] = ['page', 'list'];

// Column lists shared by every fetch and write of one label, so the RETURN list and the row
// mapper stay in step (projectColumns renders them as `alias.property AS property`).
const PAGE_COLUMNS = [
  'id',
  'scopeId',
  'parentId',
  'isScope',
  'address',
  'declaration',
  'key',
  'position',
  'name',
  'description',
  'body',
  'version',
  'mergedInto',
  'createdByAuthor',
  'createdBySourceThreadId',
  'updatedByAuthor',
  'updatedBySourceThreadId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'deletedBy',
] as const;
// Relate stores scalar and list properties only (no maps), so provenance maps are flattened into
// `<role>Author` / `<role>SourceThreadId` string columns.
const NOTE_COLUMNS = [
  'id',
  'pageId',
  'text',
  'when',
  'stampScopeIds',
  'mentions',
  'provenanceAuthor',
  'provenanceSourceThreadId',
  'version',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'deletedBy',
] as const;
const PIN_COLUMNS = ['id', 'pageId', 'kind', 'depth', 'audience', 'createdBy', 'createdAt', 'updatedAt'] as const;

const pageProjection = projectColumns('p', PAGE_COLUMNS);
const noteProjection = projectColumns('n', NOTE_COLUMNS);
const pinProjection = projectColumns('n', PIN_COLUMNS);

function provenanceProps(prefix: string, provenance: KnowledgeProvenance): Record<string, string | null> {
  return {
    [`${prefix}Author`]: provenance.author,
    [`${prefix}SourceThreadId`]: provenance.sourceThreadId ?? null,
  };
}

function provenanceOf(props: Record<string, unknown> | null | undefined): KnowledgeProvenance {
  const author = typeof props?.author === 'string' ? props.author : '';
  const sourceThreadId = typeof props?.sourceThreadId === 'string' ? props.sourceThreadId : undefined;
  return { author, ...(sourceThreadId !== undefined ? { sourceThreadId } : {}) };
}

function rowToPage(row: Record<string, unknown>): KnowledgePage {
  return {
    id: row.id as string,
    scopeId: row.scopeId as string,
    parentId: (row.parentId as string | null) ?? null,
    isScope: Boolean(row.isScope),
    ...(row.address != null ? { address: row.address as string } : {}),
    ...(row.declaration != null ? { declaration: row.declaration as string } : {}),
    ...(row.key != null ? { key: row.key as string } : {}),
    position: row.position as string,
    name: row.name as string,
    ...(row.description != null ? { description: row.description as string } : {}),
    ...(row.body != null ? { body: row.body as string } : {}),
    version: Number(row.version),
    ...(row.mergedInto != null ? { mergedInto: row.mergedInto as string } : {}),
    createdBy: provenanceOf({ author: row.createdByAuthor, sourceThreadId: row.createdBySourceThreadId }),
    updatedBy: provenanceOf({ author: row.updatedByAuthor, sourceThreadId: row.updatedBySourceThreadId }),
    createdAt: new Date(Number(row.createdAt)),
    updatedAt: new Date(Number(row.updatedAt)),
    ...(row.deletedAt != null ? { deletedAt: new Date(Number(row.deletedAt)) } : {}),
    ...(row.deletedBy != null ? { deletedBy: row.deletedBy as string } : {}),
  };
}

function pageProps(page: KnowledgePage): Record<string, ParamValue> {
  return {
    id: page.id,
    scopeId: page.scopeId,
    parentId: page.parentId ?? null,
    isScope: page.isScope,
    address: page.address ?? null,
    declaration: page.declaration ?? null,
    key: page.key ?? null,
    position: page.position,
    name: page.name,
    description: page.description ?? null,
    body: page.body ?? null,
    version: page.version,
    mergedInto: page.mergedInto ?? null,
    ...provenanceProps('createdBy', page.createdBy),
    ...provenanceProps('updatedBy', page.updatedBy),
    createdAt: page.createdAt.getTime(),
    updatedAt: page.updatedAt.getTime(),
    deletedAt: page.deletedAt?.getTime() ?? null,
    deletedBy: page.deletedBy ?? null,
  };
}

function rowToNote(row: Record<string, unknown>): KnowledgeNote {
  return {
    id: row.id as string,
    pageId: row.pageId as string,
    text: row.text as string,
    ...(row.when != null ? { when: new Date(Number(row.when)) } : {}),
    stampScopeIds: (row.stampScopeIds as string[]) ?? [],
    mentions: (row.mentions as string[]) ?? [],
    provenance: provenanceOf({ author: row.provenanceAuthor, sourceThreadId: row.provenanceSourceThreadId }),
    version: Number(row.version),
    createdAt: new Date(Number(row.createdAt)),
    updatedAt: new Date(Number(row.updatedAt)),
    ...(row.deletedAt != null ? { deletedAt: new Date(Number(row.deletedAt)) } : {}),
    ...(row.deletedBy != null ? { deletedBy: row.deletedBy as string } : {}),
  };
}

function noteProps(note: KnowledgeNote): Record<string, ParamValue> {
  return {
    id: note.id,
    pageId: note.pageId,
    text: note.text,
    when: note.when?.getTime() ?? null,
    stampScopeIds: note.stampScopeIds,
    mentions: note.mentions,
    ...provenanceProps('provenance', note.provenance),
    version: note.version,
    createdAt: note.createdAt.getTime(),
    updatedAt: note.updatedAt.getTime(),
    deletedAt: note.deletedAt?.getTime() ?? null,
    deletedBy: note.deletedBy ?? null,
  };
}

function rowToPin(row: Record<string, unknown>): KnowledgePin {
  return {
    id: row.id as string,
    pageId: row.pageId as string,
    kind: row.kind as KnowledgePinKind,
    ...(row.depth != null ? { depth: Number(row.depth) } : {}),
    audience: (row.audience as string[]) ?? [],
    createdBy: row.createdBy as string,
    createdAt: new Date(Number(row.createdAt)),
    updatedAt: new Date(Number(row.updatedAt)),
  };
}

function pinProps(pin: KnowledgePin): Record<string, ParamValue> {
  return {
    id: pin.id,
    pageId: pin.pageId,
    kind: pin.kind,
    depth: pin.depth ?? null,
    audience: pin.audience,
    createdBy: pin.createdBy,
    createdAt: pin.createdAt.getTime(),
    updatedAt: pin.updatedAt.getTime(),
  };
}

/** One label per Knowledge domain; the schema probe sweeps exactly these (plus legacy schema-2 labels). */
export const KNOWLEDGE_LABELS = ['KPage', 'KNote', 'KPin', 'KActivity', 'KBodyLink', 'KMeta'] as const;

/** Schema-2 labels (the pre-schema-4 adapter): their presence means reset/drop, never migration. */
export const LEGACY_KNOWLEDGE_LABELS = ['KNode', 'KRecord', 'KOutbox', 'KScope'] as const;

export class RelateKnowledgePageStore implements KnowledgePageStore {
  readonly #ctx: AdapterContext;
  #clock = 0;

  // Per-frame state, allocated by #frame: an identity cache so reads inside a mutation see the
  // reference's object semantics, and dirty sets flushed before commit. Undefined outside a frame.
  #cachedPages?: Map<string, KnowledgePage | null>;
  #dirtyPages?: Map<string, KnowledgePage>;
  #cachedNotes?: Map<string, KnowledgeNote | null>;
  #dirtyNotes?: Map<string, KnowledgeNote>;
  #cachedPins?: Map<string, KnowledgePin | null>;
  #dirtyPins?: Map<string, KnowledgePin | null>;
  #dirtyBodyLinks?: Map<string, KnowledgePageBodyLink[] | null>;
  #appendedActivity?: KnowledgePageActivityEvent[];
  // Set after the first full KPage scan in a frame: the frame's transaction sees no external
  // writes and every mutation lands in the cache, so the cache is the whole working set then.
  #allPagesLoaded?: boolean;

  constructor(context: AdapterContext) {
    this.#ctx = context;
  }

  /**
   * Runs `operation` inside one engine transaction with a fresh working set; on success the dirty
   * set is flushed before commit, on throw the engine rolls back and the working set is dropped.
   * The callback is synchronous: the engine is synchronous, and an `await` inside the frame would
   * commit before the work finished.
   */
  #frame<T>(operation: () => T): T {
    if (this.#cachedPages !== undefined) throw new Error('Relate knowledge frames must not nest');
    this.#cachedPages = new Map();
    this.#dirtyPages = new Map();
    this.#cachedNotes = new Map();
    this.#dirtyNotes = new Map();
    this.#cachedPins = new Map();
    this.#dirtyPins = new Map();
    this.#dirtyBodyLinks = new Map();
    this.#appendedActivity = [];
    this.#allPagesLoaded = false;
    try {
      return this.#ctx.transaction(() => {
        const value = operation();
        this.#flush();
        return value;
      });
    } finally {
      this.#cachedPages = undefined;
      this.#dirtyPages = undefined;
      this.#cachedNotes = undefined;
      this.#dirtyNotes = undefined;
      this.#cachedPins = undefined;
      this.#dirtyPins = undefined;
      this.#dirtyBodyLinks = undefined;
      this.#appendedActivity = undefined;
      this.#allPagesLoaded = undefined;
    }
  }

  /** Writes every dirty entity back whole; a null property removes the property (engine-verified). */
  #flush(): void {
    for (const [id, page] of this.#dirtyPages!) {
      this.#ctx.run('MERGE (n:KPage {id: $id}) SET n = $props', { id, props: pageProps(page) });
    }
    for (const [id, note] of this.#dirtyNotes!) {
      this.#ctx.run('MERGE (n:KNote {id: $id}) SET n = $props', { id, props: noteProps(note) });
    }
    for (const [pinKey, pin] of this.#dirtyPins!) {
      const separator = pinKey.indexOf('\u0000');
      const kind = pinKey.slice(0, separator);
      const pageId = pinKey.slice(separator + 1);
      if (pin === null) this.#ctx.run('MATCH (n:KPin {kind: $kind, pageId: $pageId}) DELETE n', { kind, pageId });
      else
        this.#ctx.run('MERGE (n:KPin {kind: $kind, pageId: $pageId}) SET n = $props', {
          kind,
          pageId,
          props: pinProps(pin),
        });
    }
    for (const [pageId, links] of this.#dirtyBodyLinks!) {
      this.#ctx.run('MATCH (l:KBodyLink {pageId: $pageId}) DELETE l', { pageId });
      if (links && links.length > 0) {
        this.#ctx.run(
          'UNWIND $links AS link CREATE (l:KBodyLink {pageId: $pageId, ref: link.ref, toPageId: link.toPageId, count: link.count})',
          { pageId, links: links.map(link => ({ ref: link.ref, toPageId: link.toPageId, count: link.count })) },
        );
      }
    }
    if (this.#appendedActivity!.length > 0) {
      this.#ctx.run(
        'UNWIND $events AS event CREATE (:KActivity {id: event.id, action: event.action, scopeId: event.scopeId, pageId: event.pageId, noteId: event.noteId, author: event.author, sourceThreadId: event.sourceThreadId, createdAt: event.createdAt})',
        {
          events: this.#appendedActivity!.map(event => ({
            id: event.id,
            action: event.action,
            scopeId: event.scopeId,
            pageId: event.pageId,
            noteId: event.noteId ?? null,
            author: event.provenance.author,
            sourceThreadId: event.provenance.sourceThreadId ?? null,
            createdAt: event.createdAt.getTime(),
          })),
        },
      );
    }
  }

  // Fetch helpers: the cache first (so reads inside a frame see this frame's writes), the engine
  // otherwise; `#fetchAll*` overlays the cache on the engine rows.

  #fetchPage(id: string): KnowledgePage | undefined {
    if (this.#cachedPages?.has(id)) {
      const cached = this.#cachedPages.get(id);
      return cached === null ? undefined : cached;
    }
    const rows = this.#ctx.run(`MATCH (p:KPage {id: $id}) RETURN ${pageProjection}`, { id });
    const page = rows[0] ? rowToPage(rows[0]) : undefined;
    this.#cachedPages?.set(id, page ?? null);
    return page;
  }

  #fetchAllPages(): KnowledgePage[] {
    // One engine scan per frame is enough: after it the identity cache holds every page (the scan
    // registers engine rows, mutations go through #putPage), so later calls read the cache only.
    if (!this.#allPagesLoaded) {
      const rows = this.#ctx.run(`MATCH (p:KPage) RETURN ${pageProjection}`);
      for (const row of rows) {
        const id = row.id as string;
        if (!this.#cachedPages?.has(id)) this.#cachedPages?.set(id, rowToPage(row));
      }
      this.#allPagesLoaded = true;
    }
    const pages: KnowledgePage[] = [];
    for (const page of this.#cachedPages?.values() ?? []) if (page !== null) pages.push(page);
    return pages;
  }

  /**
   * Only the children of one parent, for the per-parent helpers (#children, #childByKey,
   * #nextPosition) that bulk paths call once per page: a parentId-scoped indexed query instead of
   * the full scan. Cache entries are filtered by their current parentId, so pages moved or created
   * this frame land on the right side.
   */
  #fetchChildren(parentId: string | null): KnowledgePage[] {
    if (!this.#allPagesLoaded) {
      const rows =
        parentId === null
          ? this.#ctx.run(`MATCH (p:KPage) WHERE p.parentId IS NULL RETURN ${pageProjection}`)
          : this.#ctx.run(`MATCH (p:KPage {parentId: $parentId}) RETURN ${pageProjection}`, { parentId });
      for (const row of rows) {
        const id = row.id as string;
        if (!this.#cachedPages?.has(id)) this.#cachedPages?.set(id, rowToPage(row));
      }
    }
    const pages: KnowledgePage[] = [];
    for (const page of this.#cachedPages?.values() ?? [])
      if (page !== null && page.parentId === parentId) pages.push(page);
    return pages;
  }

  #fetchNote(id: string): KnowledgeNote | undefined {
    if (this.#cachedNotes?.has(id)) {
      const cached = this.#cachedNotes.get(id);
      return cached === null ? undefined : cached;
    }
    const rows = this.#ctx.run(`MATCH (n:KNote {id: $id}) RETURN ${noteProjection}`, { id });
    const note = rows[0] ? rowToNote(rows[0]) : undefined;
    this.#cachedNotes?.set(id, note ?? null);
    return note;
  }

  #fetchAllNotes(): KnowledgeNote[] {
    const rows = this.#ctx.run(`MATCH (n:KNote) RETURN ${noteProjection}`);
    const notes = new Map<string, KnowledgeNote>(rows.map(row => [row.id as string, rowToNote(row)]));
    for (const [id, note] of this.#cachedNotes ?? []) {
      if (note === null) notes.delete(id);
      else notes.set(id, note);
    }
    for (const [id, note] of notes) if (!this.#cachedNotes?.has(id)) this.#cachedNotes?.set(id, note);
    return [...notes.values()];
  }

  #pinKey(pageId: string, kind: KnowledgePinKind): string {
    return `${kind}\u0000${pageId}`;
  }

  #fetchPin(pageId: string, kind: KnowledgePinKind): KnowledgePin | undefined {
    const key = this.#pinKey(pageId, kind);
    if (this.#cachedPins?.has(key)) {
      const cached = this.#cachedPins.get(key);
      return cached === null ? undefined : cached;
    }
    const rows = this.#ctx.run(`MATCH (n:KPin {pageId: $pageId, kind: $kind}) RETURN ${pinProjection}`, {
      pageId,
      kind,
    });
    const pin = rows[0] ? rowToPin(rows[0]) : undefined;
    this.#cachedPins?.set(key, pin ?? null);
    return pin;
  }

  #fetchAllPins(): KnowledgePin[] {
    const rows = this.#ctx.run(`MATCH (n:KPin) RETURN ${pinProjection}`);
    const pins = new Map<string, KnowledgePin>(
      rows.map(row => [this.#pinKey(row.pageId as string, row.kind as KnowledgePinKind), rowToPin(row)]),
    );
    for (const [key, pin] of this.#cachedPins ?? []) {
      if (pin === null) pins.delete(key);
      else pins.set(key, pin);
    }
    for (const [key, pin] of pins) if (!this.#cachedPins?.has(key)) this.#cachedPins?.set(key, pin);
    return [...pins.values()];
  }

  #fetchAllBodyLinks(): Map<string, KnowledgePageBodyLink[]> {
    const links = new Map<string, KnowledgePageBodyLink[]>();
    const rows = this.#ctx.run(
      'MATCH (l:KBodyLink) RETURN l.pageId AS pageId, l.ref AS ref, l.toPageId AS toPageId, l.count AS count',
    );
    for (const row of rows) {
      const pageId = row.pageId as string;
      const list = links.get(pageId) ?? [];
      list.push({
        ref: row.ref as string,
        toPageId: (row.toPageId as string | null) ?? null,
        count: Number(row.count),
      });
      links.set(pageId, list);
    }
    for (const [pageId, dirty] of this.#dirtyBodyLinks ?? []) {
      if (dirty === null || dirty.length === 0) links.delete(pageId);
      else links.set(pageId, dirty);
    }
    return links;
  }

  #fetchAllActivity(): KnowledgePageActivityEvent[] {
    const rows = this.#ctx.run(
      'MATCH (a:KActivity) RETURN a.id AS id, a.action AS action, a.scopeId AS scopeId, a.pageId AS pageId, a.noteId AS noteId, a.author AS author, a.sourceThreadId AS sourceThreadId, a.createdAt AS createdAt',
    );
    const events = rows.map(row => ({
      id: row.id as string,
      action: row.action as KnowledgePageActivityAction,
      scopeId: row.scopeId as string,
      pageId: row.pageId as string,
      ...(row.noteId != null ? { noteId: row.noteId as string } : {}),
      provenance: provenanceOf({ author: row.author, sourceThreadId: row.sourceThreadId }),
      createdAt: new Date(Number(row.createdAt)),
    }));
    return [...events, ...(this.#appendedActivity ?? [])];
  }

  // Mutation marks: cache (for this frame's reads) plus dirty set (for the flush).

  #putPage(page: KnowledgePage): void {
    this.#cachedPages!.set(page.id, page);
    this.#dirtyPages!.set(page.id, page);
  }

  #putNote(note: KnowledgeNote): void {
    this.#cachedNotes!.set(note.id, note);
    this.#dirtyNotes!.set(note.id, note);
  }

  #putPin(pin: KnowledgePin): void {
    const key = this.#pinKey(pin.pageId, pin.kind);
    this.#cachedPins!.set(key, pin);
    this.#dirtyPins!.set(key, pin);
  }

  #dropPin(pageId: string, kind: KnowledgePinKind): void {
    const key = this.#pinKey(pageId, kind);
    this.#cachedPins!.set(key, null);
    this.#dirtyPins!.set(key, null);
  }

  #putBodyLinks(pageId: string, links: KnowledgePageBodyLink[] | null): void {
    this.#dirtyBodyLinks!.set(pageId, links);
  }

  /** Strictly increasing timestamps keep newest-first orderings deterministic within one millisecond. */
  #now(): Date {
    this.#clock = Math.max(Date.now(), this.#clock + 1);
    return new Date(this.#clock);
  }

  #log(
    action: KnowledgePageActivityAction,
    page: KnowledgePage,
    provenance: KnowledgeProvenance,
    noteId?: string,
  ): void {
    this.#appendedActivity!.push({
      id: crypto.randomUUID(),
      action,
      scopeId: page.scopeId,
      pageId: page.id,
      ...(noteId ? { noteId } : {}),
      provenance: clone(provenance),
      createdAt: this.#now(),
    });
  }

  #page(id: string): KnowledgePage {
    const page = this.#fetchPage(id);
    if (!page) throw new KnowledgeNotFoundError('page', id);
    return page;
  }

  #livePage(id: string): KnowledgePage {
    const page = this.#page(id);
    if (page.deletedAt) throw new KnowledgeNotFoundError('page', id);
    return page;
  }

  #note(id: string): KnowledgeNote {
    const note = this.#fetchNote(id);
    if (!note) throw new KnowledgeNotFoundError('note', id);
    return note;
  }

  #scopeReadable(scopeId: string, read: KnowledgeReadScope): boolean {
    if (read === 'all') return true;
    const scope = this.#fetchPage(scopeId);
    return !!scope && knowledgeScopeReadable(scope, read);
  }

  #pageReadable(page: KnowledgePage, read: KnowledgeReadScope): boolean {
    return this.#scopeReadable(page.scopeId, read);
  }

  /** Visibility ignoring the note's own deleted state (activity keeps removed notes' history). */
  #noteVisible(note: KnowledgeNote, read: KnowledgeReadScope): boolean {
    const page = this.#fetchPage(note.pageId);
    if (!page || !this.#pageReadable(page, read)) return false;
    if (!note.stampScopeIds.some(scopeId => this.#scopeReadable(scopeId, read))) return false;
    return note.mentions.every(pageId => {
      const mentioned = this.#fetchPage(pageId);
      return !!mentioned && this.#pageReadable(mentioned, read);
    });
  }

  #children(parentId: string | null): KnowledgePage[] {
    return this.#fetchChildren(parentId).filter(page => !page.deletedAt);
  }

  #nextPosition(parentId: string | null): string {
    // The last child by (position, id) in one row from the engine — bulk inserts call this per
    // page — with the frame's cache overlaying pages created since the last flush.
    const rows =
      parentId === null
        ? this.#ctx.run(
            'MATCH (p:KPage) WHERE p.parentId IS NULL AND p.deletedAt IS NULL RETURN p.position AS position, p.id AS id ORDER BY p.position DESC, p.id DESC LIMIT 1',
          )
        : this.#ctx.run(
            'MATCH (p:KPage {parentId: $parentId}) WHERE p.deletedAt IS NULL RETURN p.position AS position, p.id AS id ORDER BY p.position DESC, p.id DESC LIMIT 1',
            { parentId },
          );
    let last = rows[0] === undefined ? undefined : { position: rows[0]!.position as string, id: rows[0]!.id as string };
    for (const page of this.#cachedPages?.values() ?? []) {
      if (page === null || page.deletedAt || page.parentId !== parentId) continue;
      if (
        last === undefined ||
        page.position > last.position ||
        (page.position === last.position && page.id > last.id)
      ) {
        last = { position: page.position, id: page.id };
      }
    }
    return knowledgePositionBetween(last?.position);
  }

  /** Levels below the home scope: a scope page is 0, a page directly under its scope is 1. */
  #depth(page: KnowledgePage): number {
    let depth = 0;
    let current = page;
    while (!current.isScope) {
      depth++;
      current = this.#page(current.parentId!);
    }
    return depth;
  }

  /**
   * The page and every page under it, with each one's depth relative to it. Soft-deleted pages are
   * included (they move with their parent) but flagged, since size and depth count live pages only.
   */
  #subtree(root: KnowledgePage): Subtree {
    const byParent = new Map<string | null, KnowledgePage[]>();
    for (const page of this.#fetchAllPages()) {
      const list = byParent.get(page.parentId) ?? [];
      list.push(page);
      byParent.set(page.parentId, list);
    }
    const out: Subtree = [];
    const visit = (page: KnowledgePage, relativeDepth: number) => {
      out.push({ page, relativeDepth });
      for (const child of byParent.get(page.id) ?? []) visit(child, relativeDepth + 1);
    };
    visit(root, 0);
    return out;
  }

  #checkVersion(id: string, actual: number, expected: number): void {
    if (actual !== expected) throw new KnowledgeConflictError(id);
  }

  #newPage(fields: {
    id?: string;
    scopeId?: string;
    parentId: string | null;
    isScope: boolean;
    address?: string;
    declaration?: string;
    key?: string;
    position?: string;
    name: string;
    description?: string;
    body?: string;
    provenance: KnowledgeProvenance;
  }): KnowledgePage {
    if (!fields.name.trim()) throw new Error('Knowledge page name must not be empty');
    assertKnowledgePageDescriptionWithinBound(fields.description || undefined);
    const id = fields.id ?? crypto.randomUUID();
    if (this.#fetchPage(id)) throw new KnowledgeConflictError(id);
    const now = this.#now();
    const page: KnowledgePage = {
      id,
      scopeId: fields.isScope ? id : fields.scopeId!,
      parentId: fields.parentId,
      isScope: fields.isScope,
      ...(fields.address !== undefined ? { address: fields.address } : {}),
      ...(fields.declaration !== undefined ? { declaration: fields.declaration } : {}),
      ...(fields.key !== undefined ? { key: fields.key } : {}),
      position: fields.position ?? this.#nextPosition(fields.parentId),
      name: fields.name,
      ...(fields.description ? { description: fields.description } : {}),
      ...(fields.body !== undefined ? { body: fields.body } : {}),
      version: 1,
      createdBy: clone(fields.provenance),
      updatedBy: clone(fields.provenance),
      createdAt: now,
      updatedAt: now,
    };
    this.#putPage(page);
    return page;
  }

  #scopeByAddress(address: string): KnowledgePage | undefined {
    for (const page of this.#fetchAllPages()) if (page.isScope && page.address === address) return page;
    return undefined;
  }

  #childByKey(parentId: string, key: string, except?: string): KnowledgePage | undefined {
    // One indexed (parentId, key) lookup instead of the parent's whole child list; the cache scan
    // covers pages created since the last flush.
    const rows = this.#ctx.run(`MATCH (p:KPage {parentId: $parentId, key: $key}) RETURN ${pageProjection}`, {
      parentId,
      key,
    });
    for (const row of rows) {
      const id = row.id as string;
      if (!this.#cachedPages?.has(id)) this.#cachedPages?.set(id, rowToPage(row));
    }
    for (const page of this.#cachedPages?.values() ?? []) {
      if (
        page !== null &&
        page.parentId === parentId &&
        !page.isScope &&
        page.key === key &&
        !page.deletedAt &&
        page.id !== except
      ) {
        return page;
      }
    }
    return undefined;
  }

  #materializeTemplates(
    scopeId: string,
    parentId: string,
    templates: NonNullable<Parameters<Store['materializeScope']>[0]['pages']>,
    provenance: KnowledgeProvenance,
  ): void {
    for (const template of templates) {
      const problem = knowledgePageKeyProblem(template.key);
      if (problem) throw new Error(problem);
      let page = this.#childByKey(parentId, template.key);
      if (!page) {
        page = this.#newPage({
          scopeId,
          parentId,
          isScope: false,
          key: template.key,
          name: template.name,
          description: template.description,
          provenance,
        });
        this.#log('page-created', page, provenance);
      }
      if (template.pages?.length) this.#materializeTemplates(scopeId, page.id, template.pages, provenance);
    }
  }

  // Scopes

  async materializeScope(input: Parameters<Store['materializeScope']>[0]) {
    return this.#frame(() => {
      let scope = this.#scopeByAddress(input.address);
      const created = !scope;
      let parentConflict: { existingParentId: string | null; requestedParentId: string | null } | undefined;
      if (scope) {
        if (scope.parentId === null && input.parentId != null) {
          if (!this.#page(input.parentId).isScope) {
            throw new Error(`Knowledge scope ${input.address} must be placed under a scope page`);
          }
          if (input.parentId === scope.id || this.#subtree(scope).some(entry => entry.page.id === input.parentId)) {
            throw new Error(`Knowledge scope placement must not form a cycle`);
          }
          scope.parentId = input.parentId;
          scope.position = this.#nextPosition(input.parentId);
          scope.version++;
          scope.updatedAt = this.#now();
          scope.updatedBy = clone(input.provenance);
          this.#putPage(scope);
        } else if (input.parentId != null && input.parentId !== scope.parentId) {
          parentConflict = { existingParentId: scope.parentId, requestedParentId: input.parentId };
        }
      } else {
        const parentId = input.parentId ?? null;
        if (parentId !== null && !this.#page(parentId).isScope) {
          throw new Error(`Knowledge scope ${input.address} must be placed under a scope page`);
        }
        scope = this.#newPage({
          parentId,
          isScope: true,
          address: input.address,
          declaration: input.declaration,
          name: input.name,
          description: input.description,
          provenance: input.provenance,
        });
        this.#log('scope-created', scope, input.provenance);
      }
      for (const child of input.children ?? []) {
        if (this.#scopeByAddress(child.address)) continue;
        const page = this.#newPage({
          parentId: scope.id,
          isScope: true,
          address: child.address,
          declaration: child.declaration,
          name: child.name,
          description: child.description,
          provenance: input.provenance,
        });
        this.#log('scope-created', page, input.provenance);
      }
      this.#materializeTemplates(scope.id, scope.id, input.pages ?? [], input.provenance);
      return { scope: clone(scope), created, ...(parentConflict ? { parentConflict } : {}) };
    });
  }

  async getScopesByAddress(addresses: string[]) {
    return this.#frame(() => {
      const wanted = new Set(addresses);
      return this.#fetchAllPages()
        .filter(page => page.isScope && wanted.has(page.address!))
        .sort(byPosition)
        .map(clone);
    });
  }

  async listScopeDeclarations() {
    return this.#frame(() => {
      const counts = new Map<string, number>();
      for (const page of this.#fetchAllPages()) {
        if (page.isScope && page.declaration) counts.set(page.declaration, (counts.get(page.declaration) ?? 0) + 1);
      }
      return [...counts]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([declaration, scopes]) => ({ declaration, scopes }));
    });
  }

  async renameScopeDeclaration(input: Parameters<Store['renameScopeDeclaration']>[0]) {
    return this.#frame(() => {
      const renamed = this.#fetchAllPages()
        .filter(
          page =>
            page.isScope &&
            page.declaration &&
            (page.declaration === input.from || page.declaration.startsWith(`${input.from}/`)),
        )
        .map(page => ({
          page,
          rename: {
            address: page.address!,
            from: page.declaration!,
            to: input.to + page.declaration!.slice(input.from.length),
          },
        }));
      input.check(renamed.map(({ rename }) => rename));
      for (const { page, rename } of renamed) {
        page.declaration = rename.to;
        this.#putPage(page);
      }
      return renamed.length;
    });
  }

  async listChildScopes(input: Parameters<Store['listChildScopes']>[0]) {
    return this.#frame(() => {
      const scopes = this.#fetchAllPages()
        .filter(
          page =>
            page.isScope && page.parentId === input.parentId && (!input.read || this.#pageReadable(page, input.read)),
        )
        .sort(byPosition);
      const { items, nextCursor } = paginate(scopes, input.cursor, input.limit);
      return { pages: items.map(clone), ...(nextCursor ? { nextCursor } : {}) };
    });
  }

  async countChildScopes(input: Parameters<Store['countChildScopes']>[0]) {
    return this.#frame(() => {
      const counts = new Map(input.parentIds.map(id => [id, 0]));
      for (const page of this.#fetchAllPages()) {
        if (!page.isScope || page.parentId === null || !counts.has(page.parentId)) continue;
        if (!this.#pageReadable(page, input.read)) continue;
        counts.set(page.parentId, counts.get(page.parentId)! + 1);
      }
      return Object.fromEntries(counts);
    });
  }

  // Pages

  async getPage(input: Parameters<Store['getPage']>[0]) {
    return this.#frame(() => {
      const page = this.#fetchPage(input.id);
      return page && this.#pageReadable(page, input.read) ? clone(page) : null;
    });
  }

  async getPages(input: Parameters<Store['getPages']>[0]) {
    return this.#frame(() =>
      [...new Set(input.ids)]
        .map(id => this.#fetchPage(id))
        .filter((page): page is KnowledgePage => !!page && !page.deletedAt && this.#pageReadable(page, input.read))
        .map(clone),
    );
  }

  async getPageByPath(input: Parameters<Store['getPageByPath']>[0]) {
    return this.#frame(() => {
      if (input.path.length === 0) return null;
      let page: KnowledgePage | undefined;
      let parentId = input.scopeId;
      for (const key of input.path) {
        page = this.#childByKey(parentId, key);
        if (!page || !this.#pageReadable(page, input.read)) return null;
        parentId = page.id;
      }
      return page && this.#pageReadable(page, input.read) ? clone(page) : null;
    });
  }

  async findPagesByName(input: Parameters<Store['findPagesByName']>[0]) {
    return this.#frame(() => {
      const name = canonicalKnowledgeName(input.name);
      return this.#fetchAllPages()
        .filter(
          page =>
            !page.deletedAt &&
            canonicalKnowledgeName(page.name) === name &&
            (input.scopeId === undefined || page.scopeId === input.scopeId) &&
            this.#pageReadable(page, input.read),
        )
        .sort(newestFirst)
        .slice(0, pageSize(input.limit))
        .map(clone);
    });
  }

  async listChildPages(input: Parameters<Store['listChildPages']>[0]) {
    return this.#frame(() => {
      const pages = this.#children(input.parentId)
        .filter(page => !page.isScope && this.#pageReadable(page, input.read))
        .sort(byPosition);
      const { items, nextCursor } = paginate(pages, input.cursor, input.limit);
      return { pages: items.map(clone), ...(nextCursor ? { nextCursor } : {}) };
    });
  }

  async countChildPages(input: Parameters<Store['countChildPages']>[0]) {
    return this.#frame(() => {
      const counts: Record<string, number> = Object.fromEntries(input.parentIds.map(id => [id, 0]));
      for (const page of this.#fetchAllPages()) {
        if (page.parentId === null || !(page.parentId in counts)) continue;
        if (page.isScope || page.deletedAt || !this.#pageReadable(page, input.read)) continue;
        counts[page.parentId]! += 1;
      }
      return counts;
    });
  }

  async replacePageBodyLinks(input: Parameters<Store['replacePageBodyLinks']>[0]) {
    return this.#frame(() => {
      this.#putBodyLinks(input.pageId, input.links.length === 0 ? null : input.links.map(link => ({ ...link })));
    });
  }

  async listPageBodyLinkSources(input: Parameters<Store['listPageBodyLinkSources']>[0]) {
    return this.#frame(() => {
      const refs = new Set(input.refs ?? []);
      const targets = new Set(input.toPageIds ?? []);
      const sources: string[] = [];
      for (const [pageId, links] of this.#fetchAllBodyLinks()) {
        const matches = links.some(link => (link.toPageId === null ? refs.has(link.ref) : targets.has(link.toPageId)));
        if (matches) sources.push(pageId);
      }
      return sources;
    });
  }

  /** Every resolved link both of whose ends are live and readable, and not a self-link. */
  #visibleLinks(read: KnowledgeReadScope, kinds: KnowledgePageLinkKind[] | undefined): KnowledgePageLinkEdge[] {
    const wanted = new Set(kinds ?? ['body', 'note']);
    const live = (id: string) => {
      const page = this.#fetchPage(id);
      return !!page && !page.deletedAt && this.#pageReadable(page, read);
    };
    const edges = new Map<string, KnowledgePageLinkEdge>();
    const add = (fromPageId: string, toPageId: string, kind: KnowledgePageLinkKind, count: number) => {
      if (fromPageId === toPageId || !live(fromPageId) || !live(toPageId)) return;
      const key = `${fromPageId}\u0000${toPageId}\u0000${kind}`;
      const edge = edges.get(key);
      if (edge) edge.count += count;
      else edges.set(key, { fromPageId, toPageId, kind, count });
    };
    if (wanted.has('body')) {
      for (const [pageId, links] of this.#fetchAllBodyLinks()) {
        for (const link of links) if (link.toPageId !== null) add(pageId, link.toPageId, 'body', link.count);
      }
    }
    if (wanted.has('note')) {
      for (const note of this.#fetchAllNotes()) {
        if (note.deletedAt || !this.#noteVisible(note, read)) continue;
        for (const pageId of new Set(note.mentions)) add(note.pageId, pageId, 'note', 1);
      }
    }
    return [...edges.values()];
  }

  async countPageLinks(input: Parameters<Store['countPageLinks']>[0]) {
    return this.#frame(() => {
      const linked = new Map<string, { in: Set<string>; out: Set<string> }>(
        input.pageIds.map(id => [id, { in: new Set<string>(), out: new Set<string>() }]),
      );
      for (const edge of this.#visibleLinks(input.read, input.kinds)) {
        linked.get(edge.fromPageId)?.out.add(edge.toPageId);
        linked.get(edge.toPageId)?.in.add(edge.fromPageId);
      }
      return Object.fromEntries(
        [...linked].map(([id, sets]) => [id, { in: sets.in.size, out: sets.out.size }]),
      ) as Record<string, KnowledgePageLinkCounts>;
    });
  }

  async listPageLinks(input: Parameters<Store['listPageLinks']>[0]) {
    return this.#frame(() => {
      const ids = new Set(input.pageIds);
      const direction = input.direction ?? 'both';
      const limit = input.limit ?? 1_000;
      if (!Number.isInteger(limit) || limit < 1)
        throw new RangeError('Knowledge link limit must be a positive integer');
      const kindOrder = (kind: KnowledgePageLinkKind) => (kind === 'body' ? 0 : 1);
      return this.#visibleLinks(input.read, input.kinds)
        .filter(
          edge => (direction !== 'in' && ids.has(edge.fromPageId)) || (direction !== 'out' && ids.has(edge.toPageId)),
        )
        .sort(
          (a, b) =>
            compareCodeUnits(a.fromPageId, b.fromPageId) ||
            compareCodeUnits(a.toPageId, b.toPageId) ||
            kindOrder(a.kind) - kindOrder(b.kind),
        )
        .slice(0, Math.min(limit, MAX_KNOWLEDGE_PAGE_LINKS));
    });
  }

  async listPages(input: Parameters<Store['listPages']>[0]) {
    return this.#frame(() => {
      const prefix = input.namePrefix === undefined ? undefined : canonicalKnowledgeName(input.namePrefix);
      const pages = this.#fetchAllPages()
        .filter(
          page =>
            !page.isScope &&
            !page.deletedAt &&
            (input.scopeId === undefined || page.scopeId === input.scopeId) &&
            (prefix === undefined || canonicalKnowledgeName(page.name).startsWith(prefix)) &&
            this.#pageReadable(page, input.read),
        )
        .sort(byName);
      const { items, nextCursor } = paginate(pages, input.cursor, input.limit);
      return { pages: items.map(clone), ...(nextCursor ? { nextCursor } : {}) };
    });
  }

  async createPage(input: Parameters<Store['createPage']>[0]) {
    return this.#frame(() => {
      const parent = this.#livePage(input.parentId);
      const scopeId = parent.isScope ? parent.id : parent.scopeId;
      const id = input.id ?? crypto.randomUUID();
      if (this.#depth(parent) + 1 > MAX_KNOWLEDGE_PAGE_DEPTH) throw new KnowledgePageDepthError(id);
      if (input.key !== undefined) {
        const problem = knowledgePageKeyProblem(input.key);
        if (problem) throw new Error(problem);
        if (this.#childByKey(parent.id, input.key)) throw new KnowledgePageKeyConflictError(input.key, parent.id);
      }
      const page = this.#newPage({ ...input, id, scopeId, isScope: false });
      this.#log('page-created', page, input.provenance);
      return clone(page);
    });
  }

  async updatePage(input: Parameters<Store['updatePage']>[0]) {
    return this.#frame(() => {
      const page = this.#livePage(input.id);
      this.#checkVersion(page.id, page.version, input.expectedVersion);
      if (input.name !== undefined && !input.name.trim()) throw new Error('Knowledge page name must not be empty');
      assertKnowledgePageDescriptionWithinBound(input.description || undefined);
      if (input.name !== undefined) page.name = input.name;
      if (input.description !== undefined) {
        if (input.description) page.description = input.description;
        else delete page.description;
      }
      if (input.body !== undefined) page.body = input.body;
      page.version++;
      page.updatedBy = clone(input.provenance);
      page.updatedAt = this.#now();
      this.#putPage(page);
      this.#log('page-updated', page, input.provenance);
      return clone(page);
    });
  }

  /**
   * Checks moving `subtree` under `parent`: cycles, depth, size and sibling-key clashes under `parent`
   * (the moved root for a move, the source's live children for a merge). Only live pages count;
   * `rootCounts` is false for a merge, whose root (the source) is deleted.
   */
  #checkCarry(pageId: string, subtree: Subtree, parent: KnowledgePage, rootCounts: boolean): void {
    if (subtree.some(entry => entry.page.id === parent.id)) {
      throw new Error(`Knowledge page ${pageId} can't move under itself or its own subtree`);
    }
    const live = subtree.filter(entry => !entry.page.deletedAt && (rootCounts || entry.relativeDepth > 0));
    if (live.length > MAX_KNOWLEDGE_MOVE_PAGES) throw new KnowledgeMoveTooLargeError(pageId, live.length);
    const height = Math.max(0, ...live.map(entry => entry.relativeDepth));
    const deepest = this.#depth(parent) + (rootCounts ? height + 1 : height);
    if (deepest > MAX_KNOWLEDGE_PAGE_DEPTH) throw new KnowledgePageDepthError(pageId);
    const arriving = rootCounts ? [subtree[0]!.page] : live.filter(entry => entry.relativeDepth === 1).map(e => e.page);
    for (const page of arriving) {
      if (page.key === undefined) continue;
      const clash = this.#childByKey(parent.id, page.key, page.id);
      // A merge deletes the source, so a source that is itself a child of the target frees its key.
      if (clash && (rootCounts || clash.id !== pageId)) {
        throw new KnowledgePageKeyConflictError(page.key, parent.id);
      }
    }
  }

  async movePage(input: Parameters<Store['movePage']>[0]) {
    return this.#frame(() => {
      const page = this.#livePage(input.id);
      if (page.isScope) throw new Error(`Knowledge scope page ${page.id} can't be moved`);
      this.#checkVersion(page.id, page.version, input.expectedVersion);
      const parent = this.#livePage(input.parentId);
      const subtree = this.#subtree(page);
      this.#checkCarry(page.id, subtree, parent, true);
      const scopeId = parent.isScope ? parent.id : parent.scopeId;
      for (const { page: carried } of subtree) {
        carried.scopeId = scopeId;
        this.#putPage(carried);
      }
      page.position = input.position ?? this.#nextPosition(parent.id);
      page.parentId = parent.id;
      page.version++;
      page.updatedBy = clone(input.provenance);
      page.updatedAt = this.#now();
      this.#putPage(page);
      this.#log('page-moved', page, input.provenance);
      return clone(page);
    });
  }

  async mergePages(input: Parameters<Store['mergePages']>[0]) {
    return this.#frame(() => {
      const source = this.#livePage(input.sourceId);
      const target = this.#livePage(input.targetId);
      if (source.isScope || target.isScope) throw new Error("Knowledge scope pages can't be merged");
      this.#checkVersion(source.id, source.version, input.sourceVersion);
      const subtree = this.#subtree(source);
      this.#checkCarry(source.id, subtree, target, false);

      let position = this.#children(target.id).sort(byPosition).at(-1)?.position;
      for (const child of this.#children(source.id).sort(byPosition)) {
        position = knowledgePositionBetween(position);
        child.parentId = target.id;
        child.position = position;
        this.#putPage(child);
      }
      for (const { page } of subtree) {
        if (page.id !== source.id) {
          page.scopeId = target.scopeId;
          this.#putPage(page);
        }
      }
      for (const page of this.#fetchAllPages()) {
        if (page.parentId === source.id && page.deletedAt) {
          page.parentId = target.id;
          this.#putPage(page);
        }
      }
      for (const note of this.#fetchAllNotes()) {
        if (note.pageId === source.id) {
          note.pageId = target.id;
          this.#putNote(note);
        }
        if (note.mentions.includes(source.id)) {
          note.mentions = [...new Set(note.mentions.map(id => (id === source.id ? target.id : id)))];
          this.#putNote(note);
        }
      }
      for (const kind of PIN_KINDS) {
        const sourcePin = this.#fetchPin(source.id, kind);
        if (!sourcePin) continue;
        this.#dropPin(source.id, kind);
        const targetPin = this.#fetchPin(target.id, kind);
        if (targetPin) {
          targetPin.audience = [...new Set([...targetPin.audience, ...sourcePin.audience])];
          targetPin.updatedAt = this.#now();
          this.#putPin(targetPin);
        } else {
          this.#putPin({ ...sourcePin, pageId: target.id, updatedAt: this.#now() });
        }
      }
      const now = this.#now();
      source.scopeId = target.scopeId;
      source.mergedInto = target.id;
      source.deletedAt = now;
      source.deletedBy = input.provenance.author;
      source.version++;
      source.updatedBy = clone(input.provenance);
      source.updatedAt = now;
      this.#putPage(source);
      this.#log('page-merged', source, input.provenance);
      return clone(target);
    });
  }

  async deletePage(input: Parameters<Store['deletePage']>[0]) {
    return this.#frame(() => {
      const page = this.#livePage(input.id);
      if (page.isScope) throw new Error(`Knowledge scope page ${page.id} can't be deleted`);
      this.#checkVersion(page.id, page.version, input.expectedVersion);
      if (this.#children(page.id).length) throw new KnowledgePageHasChildrenError(page.id);
      const now = this.#now();
      page.deletedAt = now;
      page.deletedBy = input.deletedBy;
      page.version++;
      page.updatedAt = now;
      this.#putPage(page);
      for (const kind of PIN_KINDS) this.#dropPin(page.id, kind);
      this.#log('page-deleted', page, { author: input.deletedBy });
      return clone(page);
    });
  }

  // Notes

  async getNote(input: Parameters<Store['getNote']>[0]) {
    return this.#frame(() => {
      const note = this.#fetchNote(input.id);
      if (!note || (note.deletedAt && !input.includeDeleted) || !this.#noteVisible(note, input.read)) return null;
      return clone(note);
    });
  }

  async countNotes(input: Parameters<Store['countNotes']>[0]) {
    return this.#frame(() => {
      const counts: Record<string, number> = Object.fromEntries(input.pageIds.map(id => [id, 0]));
      for (const note of this.#fetchAllNotes()) {
        if (Object.hasOwn(counts, note.pageId) && !note.deletedAt && this.#noteVisible(note, input.read)) {
          counts[note.pageId]! += 1;
        }
      }
      return counts;
    });
  }

  async listNotes(input: Parameters<Store['listNotes']>[0]): Promise<KnowledgeNoteListOutput> {
    return this.#frame(() => {
      const notes = this.#fetchAllNotes()
        .filter(
          note =>
            note.pageId === input.pageId &&
            (!note.deletedAt || input.includeDeleted) &&
            this.#noteVisible(note, input.read),
        )
        .sort(oldestFirst);
      const { items, nextCursor } = paginate(notes, input.cursor, input.limit);
      return { notes: items.map(clone), ...(nextCursor ? { nextCursor } : {}) };
    });
  }

  async listNotesMentioning(input: Parameters<Store['listNotesMentioning']>[0]) {
    return this.#frame(() => {
      const notes = this.#fetchAllNotes()
        .filter(
          note =>
            note.pageId !== input.pageId &&
            note.mentions.includes(input.pageId) &&
            !note.deletedAt &&
            this.#noteVisible(note, input.read),
        )
        .sort(newestFirst);
      const { items, nextCursor } = paginate(notes, input.cursor, input.limit);
      return { notes: items.map(clone), ...(nextCursor ? { nextCursor } : {}) };
    });
  }

  #checkStamps(stampScopeIds: string[]): void {
    if (!stampScopeIds.length) throw new Error('A Knowledge note needs at least one stamp scope');
    for (const id of stampScopeIds) {
      if (!this.#page(id).isScope) throw new Error(`Knowledge note stamp ${id} is not a scope page`);
    }
  }

  async addNote(input: Parameters<Store['addNote']>[0]) {
    return this.#frame(() => {
      const page = this.#livePage(input.pageId);
      assertKnowledgeNoteTextWithinBound(input.text);
      this.#checkStamps(input.stampScopeIds);
      for (const id of input.mentions) this.#page(id);
      const id = input.id ?? crypto.randomUUID();
      if (this.#fetchNote(id)) throw new KnowledgeConflictError(id);
      const now = this.#now();
      const note: KnowledgeNote = {
        id,
        pageId: page.id,
        text: input.text,
        ...(input.when ? { when: new Date(input.when) } : {}),
        stampScopeIds: [...new Set(input.stampScopeIds)],
        mentions: [...new Set(input.mentions)],
        provenance: clone(input.provenance),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.#putNote(note);
      this.#log('note-added', page, input.provenance, id);
      return clone(note);
    });
  }

  async restampNote(input: Parameters<Store['restampNote']>[0]) {
    return this.#frame(() => {
      const note = this.#note(input.id);
      if (note.deletedAt) throw new KnowledgeNotFoundError('note', input.id);
      this.#checkVersion(note.id, note.version, input.expectedVersion);
      this.#checkStamps(input.stampScopeIds);
      note.stampScopeIds = [...new Set(input.stampScopeIds)];
      note.version++;
      note.updatedAt = this.#now();
      this.#putNote(note);
      this.#log('note-restamped', this.#page(note.pageId), input.provenance, note.id);
      return clone(note);
    });
  }

  async removeNote(input: Parameters<Store['removeNote']>[0]) {
    return this.#frame(() => {
      const note = this.#note(input.id);
      if (note.deletedAt) throw new KnowledgeNotFoundError('note', input.id);
      const now = this.#now();
      note.deletedAt = now;
      note.deletedBy = input.deletedBy;
      note.version++;
      note.updatedAt = now;
      this.#putNote(note);
      this.#log('note-removed', this.#page(note.pageId), input.provenance, note.id);
      return clone(note);
    });
  }

  async restoreNote(input: Parameters<Store['restoreNote']>[0]) {
    return this.#frame(() => {
      const note = this.#note(input.id);
      if (!note.deletedAt) throw new KnowledgeConflictError(input.id);
      delete note.deletedAt;
      delete note.deletedBy;
      note.version++;
      note.updatedAt = this.#now();
      this.#putNote(note);
      this.#log('note-restored', this.#page(note.pageId), input.provenance, note.id);
      return clone(note);
    });
  }

  // Search and activity

  async searchPages(input: Parameters<Store['searchPages']>[0]): Promise<KnowledgePageSearchHit[]> {
    return this.#frame(() => {
      const words = knowledgeSearchWords(input.query);
      if (!words.length) return [];
      const phrase = input.query.trim().toLowerCase().replace(/\s+/g, ' ');
      const limit = input.limit === undefined ? DEFAULT_SEARCH_LIMIT : pageSize(input.limit);
      const inScope = (page: KnowledgePage) => !input.scopeIds || input.scopeIds.includes(page.scopeId);
      const lower = (text: string | undefined) => (text ?? '').toLowerCase();
      const pageScore = (page: KnowledgePage) => {
        const name = lower(page.name);
        const description = lower(page.description);
        const body = lower(page.body);
        let matched = 0;
        let score = 0;
        for (const word of words) {
          if (name.includes(word)) score += KNOWLEDGE_SEARCH_WEIGHTS.name;
          else if (description.includes(word)) score += KNOWLEDGE_SEARCH_WEIGHTS.description;
          else if (body.includes(word)) score += KNOWLEDGE_SEARCH_WEIGHTS.body;
          else continue;
          matched++;
        }
        return { matched, score };
      };
      const noteScore = (note: KnowledgeNote) => {
        const text = lower(note.text);
        return words.filter(word => text.includes(word)).length;
      };
      const pageHits = this.#fetchAllPages()
        .filter(page => !page.isScope && !page.deletedAt && inScope(page) && this.#pageReadable(page, input.read))
        .map(page => ({
          page,
          phrase: canonicalKnowledgeName(page.name).includes(phrase) ? 0 : 1,
          ...pageScore(page),
        }))
        .filter(hit => hit.matched > 0)
        .sort(
          (a, b) =>
            a.phrase - b.phrase ||
            b.matched - a.matched ||
            b.score - a.score ||
            b.page.updatedAt.getTime() - a.page.updatedAt.getTime() ||
            (a.page.id < b.page.id ? -1 : 1),
        );
      const noteHits = this.#fetchAllNotes()
        .filter(note => {
          const page = this.#fetchPage(note.pageId);
          return !!page && !note.deletedAt && !page.deletedAt && inScope(page) && this.#noteVisible(note, input.read);
        })
        .map(note => ({ note, score: noteScore(note) }))
        .filter(hit => hit.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.note.updatedAt.getTime() - a.note.updatedAt.getTime() ||
            (a.note.id < b.note.id ? 1 : a.note.id > b.note.id ? -1 : 0),
        )
        .map(hit => hit.note);
      return [
        ...pageHits.map(({ page }) => ({ type: 'page' as const, page: clone(page) })),
        ...noteHits.map(note => ({
          type: 'note' as const,
          note: clone(note),
          page: clone(this.#page(note.pageId)),
        })),
      ].slice(0, limit);
    });
  }

  async listPageActivity(input: Parameters<Store['listPageActivity']>[0]) {
    return this.#frame(() => {
      const events = this.#fetchAllActivity()
        .filter(event => {
          const page = this.#fetchPage(event.pageId);
          if (!page || !this.#pageReadable(page, input.read)) return false;
          if (input.pageId !== undefined && event.pageId !== input.pageId) return false;
          if (input.scopeId !== undefined && page.scopeId !== input.scopeId) return false;
          if (event.noteId !== undefined) {
            const note = this.#fetchNote(event.noteId);
            if (!note || !this.#noteVisible(note, input.read)) return false;
          }
          return true;
        })
        .sort(newestFirst);
      const { items, nextCursor } = paginate(events, input.cursor, input.limit);
      return { events: items.map(clone), ...(nextCursor ? { nextCursor } : {}) };
    });
  }

  // Pins

  async addPinAudience(input: Parameters<Store['addPinAudience']>[0]) {
    return this.#frame(() => {
      const page = this.#livePage(input.pageId);
      if (!input.audience.length) throw new Error('A Knowledge pin needs at least one audience scope');
      const kind = input.kind ?? 'page';
      const depth = knowledgePinDepth(kind, input.depth);
      const now = this.#now();
      const existing = this.#fetchPin(page.id, kind);
      const pin: KnowledgePin = existing
        ? {
            ...existing,
            ...(depth === undefined ? {} : { depth }),
            audience: [...new Set([...existing.audience, ...input.audience])],
            updatedAt: now,
          }
        : {
            id: crypto.randomUUID(),
            pageId: page.id,
            kind,
            ...(depth === undefined ? {} : { depth }),
            audience: [...new Set(input.audience)],
            createdBy: input.createdBy,
            createdAt: now,
            updatedAt: now,
          };
      this.#putPin(pin);
      this.#log('pin-added', page, { author: input.createdBy });
      return clone(pin);
    });
  }

  async removePinAudience(input: Parameters<Store['removePinAudience']>[0]) {
    return this.#frame(() => {
      const page = this.#page(input.pageId);
      const kind = input.kind ?? 'page';
      const existing = this.#fetchPin(page.id, kind);
      if (!existing) return null;
      const removed = new Set(input.audience);
      const audience = existing.audience.filter(entry => !removed.has(entry));
      if (audience.length === existing.audience.length) return clone(existing);
      this.#log('pin-removed', page, { author: input.removedBy });
      if (!audience.length) {
        this.#dropPin(page.id, kind);
        return null;
      }
      const pin = { ...existing, audience, updatedAt: this.#now() };
      this.#putPin(pin);
      return clone(pin);
    });
  }

  async listPins(
    input: Parameters<Store['listPins']>[0],
  ): Promise<{ pins: KnowledgeListedPin[]; nextCursor?: string; total?: number }> {
    return this.#frame(() => {
      const audience = input.audience === 'all' ? null : new Set(input.audience);
      const pins = this.#fetchAllPins()
        .filter(pin => {
          const page = this.#fetchPage(pin.pageId);
          if (!page || page.deletedAt || !this.#pageReadable(page, input.read)) return false;
          if (input.kind && pin.kind !== input.kind) return false;
          if (input.pageIds && !input.pageIds.includes(pin.pageId)) return false;
          if (pin.kind === 'page' && input.excludePageIds?.includes(pin.pageId)) return false;
          if (pin.kind === 'page' && input.withBody && !/\S/.test(page.body ?? '')) return false;
          return !audience || pin.audience.some(entry => audience.has(entry));
        })
        .sort(newestFirst);
      const { items, nextCursor } = paginate(pins, input.cursor, input.limit);
      return {
        pins: items.map(pin => ({ ...clone(pin), pageName: this.#page(pin.pageId).name })),
        ...(nextCursor ? { nextCursor } : {}),
        ...(input.count ? { total: pins.length } : {}),
      };
    });
  }

  /**
   * Deletes every Knowledge node (pages, notes, pins, activity, body links, and legacy schema-2
   * nodes) and, unless `keepMarker` is set, the schema-version marker too. Clearing data while
   * keeping the marker is what `dangerouslyClearAll` means; `dangerouslyReset` drops both and
   * lets `init()` stamp a fresh marker.
   */
  dangerouslyClearAll({ keepMarker = false }: { keepMarker?: boolean } = {}): void {
    this.#ctx.transaction(() => {
      this.#ctx.run('MATCH (n) WHERE any(label IN labels(n) WHERE label IN $labels) DETACH DELETE n', {
        labels: [...KNOWLEDGE_LABELS.filter(label => label !== 'KMeta'), ...LEGACY_KNOWLEDGE_LABELS],
      });
      if (!keepMarker) this.#ctx.run('MATCH (m:KMeta) DETACH DELETE m');
    });
  }
}
