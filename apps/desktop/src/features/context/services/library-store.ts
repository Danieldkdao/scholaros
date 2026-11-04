import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  contextItemSchema,
  contextPreviewSchema,
  contextVersionSchema,
  ingestionStatuses,
  locatorSchema,
  type ContextItemDTO,
  type ContextPreview,
  type ContextVersionDTO,
  type Locator,
  type SourceReference,
} from '@scholaros/services/learning/context-contracts';
import {
  idSchema,
  instantSchema,
  pageInputSchema,
  requestIdSchema,
  revisionSchema,
  type AuthorizedContext,
  type Page,
} from '@scholaros/services/learning/product-contracts';
import { db } from '../../../db';
import {
  ContextChunkTable,
  ContextItemTable,
  ContextLinkTable,
  ContextVersionTable,
  CourseTable,
  StudySessionTable,
  StudySourceReferenceTable,
} from '../../../db/schema';
import { createOriginalStore } from './original-store';

export type ContextStoreErrorCode =
  | 'cancelled'
  | 'invalid-input'
  | 'limit-exceeded'
  | 'not-found'
  | 'permission-revoked'
  | 'revision-conflict'
  | 'scope-denied'
  | 'session-changed'
  | 'storage-failed'
  | 'unsupported';

export class ContextStoreError extends Error {
  constructor(
    readonly code: ContextStoreErrorCode,
    readonly committed = false,
  ) {
    super(code);
    this.name = 'ContextStoreError';
  }
}

const createContextNoteInputSchema = z.strictObject({
  requestId: requestIdSchema,
  title: z.string().trim().min(1).max(160),
  text: z.string().trim().min(1).max(100_000),
  kind: z.enum(['note', 'preference']),
  courseId: idSchema.optional(),
});
export type CreateContextNoteInputSchema = z.infer<
  typeof createContextNoteInputSchema
>;

const updateContextItemInputSchema = z
  .strictObject({
    itemId: idSchema,
    expectedRevision: revisionSchema,
    title: z.string().trim().min(1).max(160).optional(),
    text: z.string().trim().min(1).max(100_000).optional(),
    courseId: idSchema.nullable().optional(),
  })
  .refine(
    ({ title, text, courseId }) =>
      title !== undefined || text !== undefined || courseId !== undefined,
  );
export type UpdateContextItemInputSchema = z.infer<
  typeof updateContextItemInputSchema
>;

const linkContextItemInputSchema = z.strictObject({
  itemId: idSchema,
  courseId: idSchema.nullable(),
  sessionId: idSchema.optional(),
  retainInLibrary: z.boolean().optional(),
});
export type LinkContextItemInputSchema = z.infer<
  typeof linkContextItemInputSchema
>;

const removeContextItemInputSchema = z.strictObject({
  itemId: idSchema,
  expectedRevision: revisionSchema,
});
export type RemoveContextItemInputSchema = z.infer<
  typeof removeContextItemInputSchema
>;

const getContextItemInputSchema = z.strictObject({
  itemId: idSchema,
  versionId: idSchema.optional(),
});
export type GetContextItemInputSchema = z.infer<
  typeof getContextItemInputSchema
>;

const createUploadedContextItemInputSchema = z.strictObject({
  itemId: idSchema,
  title: z.string().trim().min(1).max(160),
  kind: z.enum(['document', 'image']),
  sessionId: idSchema.optional(),
  courseId: idSchema.optional(),
  saveToLibrary: z.boolean(),
});
export type CreateUploadedContextItemInputSchema = z.infer<
  typeof createUploadedContextItemInputSchema
>;

const saveGeneratedContextItemInputSchema = z.strictObject({
  requestId: requestIdSchema,
  title: z.string().trim().min(1).max(160),
  text: z.string().trim().min(1).max(100_000),
  kind: z.enum(['explanation', 'activity']),
  sourceId: idSchema,
  courseId: idSchema.nullable().optional(),
  sessionId: idSchema.optional(),
});
export type SaveGeneratedContextItemInputSchema = z.infer<
  typeof saveGeneratedContextItemInputSchema
>;

const contextVersionWriteInputSchema = z.strictObject({
  itemId: idSchema,
  expectedRevision: revisionSchema,
  attemptId: idSchema,
  originalHash: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.string().trim().min(1).max(100),
  byteLength: z
    .number()
    .int()
    .nonnegative()
    .max(10 * 1024 * 1024),
  originalStorageKey: z.string().max(160).nullable(),
  extractedText: z.string().max(2_000_000).nullable(),
  extractionStatus: z.enum(ingestionStatuses),
  uncertainty: z.string().max(1000).nullable(),
  pageCount: z.number().int().nonnegative().max(200).nullable(),
  interpretedPages: z.array(z.number().int().positive()).max(200),
  locators: z.array(locatorSchema).max(2000),
  originalIsNew: z.boolean().optional(),
});
export type ContextVersionWriteInputSchema = z.infer<
  typeof contextVersionWriteInputSchema
>;

const contextStatusInputSchema = z.strictObject({
  itemId: idSchema,
  expectedRevision: revisionSchema,
  status: z.enum(ingestionStatuses),
});
export type ContextStatusInputSchema = z.infer<typeof contextStatusInputSchema>;

const sessionInputSchema = z.strictObject({ sessionId: idSchema });
export type SessionInputSchema = z.infer<typeof sessionInputSchema>;

const cursorSchema = z.strictObject({
  updatedAt: instantSchema,
  id: idSchema,
});

type ContextItemRow = typeof ContextItemTable.$inferSelect;
type ContextVersionRow = typeof ContextVersionTable.$inferSelect;
type ContextTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ContextQueryable = typeof db | ContextTransaction;

const originalStore = createOriginalStore();
const maximumContextChunks = 40;
const maximumContextTerms = 12;
const passageTextLimit = 2000;

export const truncateContextText = (value: string, characterLimit: number) =>
  value.length <= characterLimit
    ? value
    : Array.from(value).slice(0, characterLimit).join('');

const timestamp = () => new Date().toISOString();
const hashText = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

const assertAuthorized = (context: AuthorizedContext) => {
  if (!context.userId.trim()) throw new ContextStoreError('invalid-input');
  if (context.signal.aborted) throw new ContextStoreError('cancelled');
  if (!context.isCurrent()) throw new ContextStoreError('session-changed');
};

const parseOrThrow = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ContextStoreError('invalid-input');
  return parsed.data;
};

const getOwnedItem = (
  queryable: ContextQueryable,
  userId: string,
  itemId: string,
): ContextItemRow => {
  const contextItem = queryable
    .select()
    .from(ContextItemTable)
    .where(eq(ContextItemTable.id, itemId))
    .get();
  if (!contextItem) throw new ContextStoreError('not-found');
  if (contextItem.userId !== userId)
    throw new ContextStoreError('scope-denied');
  if (contextItem.removedAt) throw new ContextStoreError('not-found');
  return contextItem;
};

const getOwnedCourse = (
  queryable: ContextQueryable,
  userId: string,
  courseId: string,
) => {
  const course = queryable
    .select({ id: CourseTable.id })
    .from(CourseTable)
    .where(and(eq(CourseTable.userId, userId), eq(CourseTable.id, courseId)))
    .get();
  if (!course) throw new ContextStoreError('scope-denied');
};

const getOwnedSession = (
  queryable: ContextQueryable,
  userId: string,
  sessionId: string,
) => {
  const session = queryable
    .select({ id: StudySessionTable.id, courseId: StudySessionTable.courseId })
    .from(StudySessionTable)
    .where(
      and(
        eq(StudySessionTable.userId, userId),
        eq(StudySessionTable.id, sessionId),
        isNull(StudySessionTable.deletedAt),
      ),
    )
    .get();
  if (!session) throw new ContextStoreError('scope-denied');
  getOwnedCourse(queryable, userId, session.courseId);
  return session;
};

const chunkText = (text: string) => {
  const chunks: Array<{ text: string; locator: Locator }> = [];
  const paragraphs = text.split(/\n{2,}/u);
  let paragraphOrdinal = 0;
  for (const paragraph of paragraphs) {
    const characters = Array.from(paragraph.trim());
    if (!characters.length) continue;
    paragraphOrdinal += 1;
    while (characters.length) {
      let end = Math.min(passageTextLimit, characters.length);
      if (end < characters.length) {
        const breakAt = characters.slice(0, end).lastIndexOf(' ');
        if (breakAt > passageTextLimit / 2) end = breakAt;
      }
      const textChunk = characters.splice(0, end).join('').trim();
      if (textChunk) {
        chunks.push({
          text: textChunk,
          locator: { kind: 'paragraph', ordinal: paragraphOrdinal },
        });
      }
      while (characters[0] === ' ') characters.shift();
    }
  }
  return chunks;
};

const contextVersionDto = (
  version: ContextVersionRow,
  originalAvailable: boolean,
): ContextVersionDTO | null => {
  const parsed = contextVersionSchema.safeParse({
    id: version.id,
    itemId: version.itemId,
    contentHash: version.contentHash,
    mimeType: version.mimeType,
    byteLength: version.byteLength,
    pageCount: version.pageCount,
    extractionStatus: version.extractionStatus,
    interpretedPages: version.interpretedPages,
    uncertainty: version.uncertainty,
    createdAt: version.createdAt,
    originalAvailable,
    locators: version.locators,
  });
  return parsed.success ? parsed.data : null;
};

const contextItemDto = (
  queryable: ContextQueryable,
  userId: string,
  item: ContextItemRow,
  options: { requireLibraryVisibility?: boolean } = {},
): ContextItemDTO | null => {
  const links = queryable
    .select()
    .from(ContextLinkTable)
    .where(
      and(
        eq(ContextLinkTable.userId, userId),
        eq(ContextLinkTable.itemId, item.id),
      ),
    )
    .all();
  const accountOwnedLinks = links.filter((link) => {
    if (link.courseId) {
      const course = queryable
        .select({ id: CourseTable.id })
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, userId),
            eq(CourseTable.id, link.courseId),
          ),
        )
        .get();
      if (!course) return false;
    }
    if (link.sessionId) {
      const session = queryable
        .select({ courseId: StudySessionTable.courseId })
        .from(StudySessionTable)
        .where(
          and(
            eq(StudySessionTable.userId, userId),
            eq(StudySessionTable.id, link.sessionId),
            isNull(StudySessionTable.deletedAt),
          ),
        )
        .get();
      if (!session || (link.courseId && session.courseId !== link.courseId))
        return false;
    }
    return true;
  });
  const visibleLinks = accountOwnedLinks.filter(
    (link) => link.retainedInLibrary || link.courseId !== null,
  );
  if (options.requireLibraryVisibility && visibleLinks.length === 0)
    return null;
  const courseIds = [
    ...new Set(
      visibleLinks.flatMap((link) => (link.courseId ? [link.courseId] : [])),
    ),
  ];
  if (courseIds.length > 1) return null;
  const currentVersion = item.currentVersionId
    ? queryable
        .select()
        .from(ContextVersionTable)
        .where(
          and(
            eq(ContextVersionTable.id, item.currentVersionId),
            eq(ContextVersionTable.itemId, item.id),
            eq(ContextVersionTable.userId, userId),
          ),
        )
        .get()
    : undefined;
  const currentUsable =
    currentVersion !== undefined &&
    ['complete', 'partial'].includes(currentVersion.extractionStatus) &&
    currentVersion.extractedText !== null &&
    currentVersion.extractedText.length > 0;
  const source =
    item.originatingSessionId || item.originatingSourceId
      ? {
          sessionId: item.originatingSessionId,
          sourceId: item.originatingSourceId,
          sourceVersion: currentVersion?.contentHash ?? null,
          removed: false,
        }
      : null;
  const dto = contextItemSchema.safeParse({
    id: item.id,
    title: item.title,
    kind: item.kind,
    provenance: item.provenance,
    courseIds,
    currentVersionId: currentVersion?.id ?? null,
    status: item.status,
    usable: currentUsable,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    revision: item.revision,
    source,
  });
  return dto.success ? dto.data : null;
};

const previewForVersion = (
  version: ContextVersionRow | undefined,
): ContextPreview => {
  if (!version) return { kind: 'unavailable', reason: 'processing' };
  if (version.extractedText !== null) {
    const text = truncateContextText(version.extractedText, 50_000);
    const preview = contextPreviewSchema.safeParse({
      kind: 'text',
      text,
      locators: version.locators.slice(0, 200),
      partial:
        version.extractionStatus === 'partial' ||
        text.length < version.extractedText.length,
      uncertainty: version.uncertainty,
    });
    if (preview.success) return preview.data;
  }
  const reason =
    version.extractionStatus === 'unsupported'
      ? 'unsupported'
      : version.extractionStatus === 'unreadable'
        ? 'unreadable'
        : version.extractionStatus === 'queued' ||
            version.extractionStatus === 'processing'
          ? 'processing'
          : 'unreadable';
  return { kind: 'unavailable', reason };
};

const getVisibleItem = (userId: string, itemId: string) => {
  const item = db
    .select()
    .from(ContextItemTable)
    .where(
      and(
        eq(ContextItemTable.userId, userId),
        eq(ContextItemTable.id, itemId),
        isNull(ContextItemTable.removedAt),
      ),
    )
    .get();
  if (!item) return null;
  return contextItemDto(db, userId, item, { requireLibraryVisibility: true });
};

const getUnremovedItemForOwner = (userId: string, itemId: string) =>
  db
    .select()
    .from(ContextItemTable)
    .where(
      and(
        eq(ContextItemTable.userId, userId),
        eq(ContextItemTable.id, itemId),
        isNull(ContextItemTable.removedAt),
      ),
    )
    .get();

export const getContextRevision = (userId: string): number | null => {
  if (!userId.trim()) return null;
  try {
    const result = db.$client
      .prepare(
        `SELECT COUNT(*) + COALESCE(SUM(revision), 0) AS revision
         FROM context_items
         WHERE user_id = ?`,
      )
      .get(userId) as { revision: number } | undefined;
    return result && Number.isSafeInteger(result.revision)
      ? result.revision
      : null;
  } catch {
    return null;
  }
};

const queryFromText = (value: string) => {
  const tokens = [
    ...new Set(
      (value.normalize('NFKC').match(/[\p{L}\p{N}]{1,64}/gu) ?? []).slice(
        0,
        maximumContextTerms,
      ),
    ),
  ];
  return tokens
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' AND ');
};

const encodeCursor = (value: { updatedAt: string; id: string }) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const decodeCursor = (value: string | undefined) => {
  if (!value) return null;
  try {
    return parseOrThrow(
      cursorSchema,
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
  } catch {
    throw new ContextStoreError('invalid-input');
  }
};

const assertCourseAndSessionScope = (
  queryable: ContextQueryable,
  userId: string,
  courseId: string | null | undefined,
  sessionId: string | undefined,
) => {
  if (sessionId) {
    const session = getOwnedSession(queryable, userId, sessionId);
    if (courseId && session.courseId !== courseId)
      throw new ContextStoreError('scope-denied');
  } else if (courseId) {
    getOwnedCourse(queryable, userId, courseId);
  }
};

const createLink = (
  transaction: ContextTransaction,
  values: {
    userId: string;
    itemId: string;
    courseId: string | null;
    sessionId: string | null;
    retainedInLibrary: boolean;
  },
) =>
  transaction
    .insert(ContextLinkTable)
    .values({
      id: randomUUID(),
      ...values,
      createdAt: timestamp(),
    })
    .run();

const linkExists = (
  transaction: ContextTransaction,
  userId: string,
  itemId: string,
  courseId: string | null,
  sessionId: string | null,
) => {
  const filters = [
    eq(ContextLinkTable.userId, userId),
    eq(ContextLinkTable.itemId, itemId),
    courseId === null
      ? isNull(ContextLinkTable.courseId)
      : eq(ContextLinkTable.courseId, courseId),
    sessionId === null
      ? isNull(ContextLinkTable.sessionId)
      : eq(ContextLinkTable.sessionId, sessionId),
  ];
  return transaction
    .select({ id: ContextLinkTable.id })
    .from(ContextLinkTable)
    .where(and(...filters))
    .get();
};

const insertLinkIfMissing = (
  transaction: ContextTransaction,
  values: {
    userId: string;
    itemId: string;
    courseId: string | null;
    sessionId: string | null;
    retainedInLibrary: boolean;
  },
) => {
  if (
    !linkExists(
      transaction,
      values.userId,
      values.itemId,
      values.courseId,
      values.sessionId,
    )
  )
    createLink(transaction, values);
};

const setLinkScope = (
  transaction: ContextTransaction,
  userId: string,
  itemId: string,
  courseId: string | null,
  sessionId: string | null,
  retainInLibrary: boolean | undefined,
) => {
  const currentLinks = transaction
    .select()
    .from(ContextLinkTable)
    .where(
      and(
        eq(ContextLinkTable.userId, userId),
        eq(ContextLinkTable.itemId, itemId),
      ),
    )
    .all();
  const preserveLibrary =
    retainInLibrary ?? currentLinks.some((link) => link.retainedInLibrary);
  if (courseId) {
    for (const link of currentLinks) {
      if (!link.sessionId) continue;
      const session = transaction
        .select({ courseId: StudySessionTable.courseId })
        .from(StudySessionTable)
        .where(
          and(
            eq(StudySessionTable.userId, userId),
            eq(StudySessionTable.id, link.sessionId),
            isNull(StudySessionTable.deletedAt),
          ),
        )
        .get();
      if (session?.courseId !== courseId)
        transaction
          .delete(ContextLinkTable)
          .where(eq(ContextLinkTable.id, link.id))
          .run();
    }
  }
  const courseLinks = currentLinks.filter((link) => link.courseId !== null);
  if (courseLinks.length) {
    transaction
      .delete(ContextLinkTable)
      .where(
        and(
          eq(ContextLinkTable.userId, userId),
          eq(ContextLinkTable.itemId, itemId),
          sql`${ContextLinkTable.courseId} IS NOT NULL`,
        ),
      )
      .run();
  }
  if (courseId)
    insertLinkIfMissing(transaction, {
      userId,
      itemId,
      courseId,
      sessionId: null,
      retainedInLibrary: false,
    });
  if (sessionId)
    insertLinkIfMissing(transaction, {
      userId,
      itemId,
      courseId: null,
      sessionId,
      retainedInLibrary: false,
    });
  const libraryLink = linkExists(transaction, userId, itemId, null, null);
  if (preserveLibrary && !libraryLink)
    createLink(transaction, {
      userId,
      itemId,
      courseId: null,
      sessionId: null,
      retainedInLibrary: true,
    });
  if (!preserveLibrary && libraryLink)
    transaction
      .delete(ContextLinkTable)
      .where(
        and(
          eq(ContextLinkTable.userId, userId),
          eq(ContextLinkTable.itemId, itemId),
          isNull(ContextLinkTable.courseId),
          isNull(ContextLinkTable.sessionId),
        ),
      )
      .run();
};

const getOriginalKeysForItem = (userId: string, itemId: string) =>
  db
    .select({ originalStorageKey: ContextVersionTable.originalStorageKey })
    .from(ContextVersionTable)
    .where(
      and(
        eq(ContextVersionTable.userId, userId),
        eq(ContextVersionTable.itemId, itemId),
      ),
    )
    .all()
    .flatMap(({ originalStorageKey }) =>
      originalStorageKey ? [originalStorageKey] : [],
    );

const deleteContextItemData = (
  transaction: ContextTransaction,
  userId: string,
  itemId: string,
) => {
  transaction
    .update(StudySourceReferenceTable)
    .set({ state: 'removed', versionId: null, locator: null })
    .where(
      and(
        eq(StudySourceReferenceTable.userId, userId),
        eq(StudySourceReferenceTable.sourceKind, 'context-version'),
        eq(StudySourceReferenceTable.sourceId, itemId),
      ),
    )
    .run();
  transaction
    .delete(ContextChunkTable)
    .where(
      and(
        eq(ContextChunkTable.userId, userId),
        eq(ContextChunkTable.itemId, itemId),
      ),
    )
    .run();
  transaction
    .delete(ContextLinkTable)
    .where(
      and(
        eq(ContextLinkTable.userId, userId),
        eq(ContextLinkTable.itemId, itemId),
      ),
    )
    .run();
  transaction
    .delete(ContextVersionTable)
    .where(
      and(
        eq(ContextVersionTable.userId, userId),
        eq(ContextVersionTable.itemId, itemId),
      ),
    )
    .run();
  transaction
    .update(ContextItemTable)
    .set({
      title: 'Removed source',
      status: 'cancelled',
      currentVersionId: null,
      removedAt: timestamp(),
      originatingSessionId: null,
      originatingSourceId: null,
      revision: sql`${ContextItemTable.revision} + 1`,
      updatedAt: timestamp(),
    })
    .where(
      and(eq(ContextItemTable.userId, userId), eq(ContextItemTable.id, itemId)),
    )
    .run();
};

const removeOriginalKeysIfUnreferenced = async (
  userId: string,
  storageKeys: string[],
) => {
  for (const storageKey of new Set(storageKeys)) {
    const existingVersion = db
      .select({ id: ContextVersionTable.id })
      .from(ContextVersionTable)
      .where(
        and(
          eq(ContextVersionTable.userId, userId),
          eq(ContextVersionTable.originalStorageKey, storageKey),
        ),
      )
      .get();
    if (existingVersion) continue;
    await originalStore.remove(userId, storageKey);
  }
};

export const listContextItems = (
  context: AuthorizedContext,
  input: unknown,
): Page<ContextItemDTO> | null => {
  const parsed = pageInputSchema.safeParse(input);
  if (
    !parsed.success ||
    !context.userId.trim() ||
    context.signal.aborted ||
    !context.isCurrent()
  )
    return null;
  const pageSize = parsed.data.limit ?? 25;
  try {
    const cursor = decodeCursor(parsed.data.cursor);
    if (parsed.data.courseId)
      getOwnedCourse(db, context.userId, parsed.data.courseId);
    const predicates = [
      `items.user_id = ?`,
      `items.removed_at IS NULL`,
      `EXISTS (
        SELECT 1 FROM context_links AS visible
        WHERE visible.user_id = items.user_id
          AND visible.item_id = items.id
          AND (visible.retained_in_library = 1 OR visible.course_id IS NOT NULL)
      )`,
    ];
    const parameters: Array<string | number> = [context.userId];
    if (parsed.data.courseId === null) {
      predicates.push(`EXISTS (
        SELECT 1 FROM context_links AS personal
        WHERE personal.user_id = items.user_id
          AND personal.item_id = items.id
          AND personal.course_id IS NULL
          AND personal.session_id IS NULL
          AND personal.retained_in_library = 1
      )`);
      predicates.push(`NOT EXISTS (
        SELECT 1 FROM context_links AS assigned
        WHERE assigned.user_id = items.user_id
          AND assigned.item_id = items.id
          AND assigned.course_id IS NOT NULL
      )`);
    } else if (parsed.data.courseId) {
      predicates.push(`EXISTS (
        SELECT 1 FROM context_links AS assigned
        JOIN courses ON courses.id = assigned.course_id AND courses.user_id = assigned.user_id
        WHERE assigned.user_id = items.user_id
          AND assigned.item_id = items.id
          AND assigned.course_id = ?
      )`);
      parameters.push(parsed.data.courseId);
    }
    const queryText = parsed.data.query?.trim();
    if (queryText) {
      const titleQuery = `%${queryText.toLocaleLowerCase().replace(/[\\%_]/gu, '\\$&')}%`;
      const ftsQuery = queryFromText(queryText);
      if (ftsQuery) {
        predicates.push(`(
          LOWER(items.title) LIKE ? ESCAPE '\\'
          OR items.id IN (
            SELECT chunks.item_id FROM context_chunks_fts
            JOIN context_chunks AS chunks
              ON chunks.rowid = context_chunks_fts.rowid
            JOIN context_items AS current_items
              ON current_items.id = chunks.item_id
              AND current_items.user_id = chunks.user_id
            JOIN context_versions AS versions
              ON versions.id = chunks.version_id
              AND versions.item_id = chunks.item_id
              AND versions.user_id = chunks.user_id
            WHERE context_chunks_fts MATCH ?
              AND context_chunks_fts.user_id = ?
              AND current_items.removed_at IS NULL
              AND current_items.current_version_id = versions.id
              AND versions.extraction_status IN ('complete', 'partial')
              AND versions.extracted_text IS NOT NULL
          )
        )`);
        parameters.push(titleQuery, ftsQuery, context.userId);
      } else {
        predicates.push(`LOWER(items.title) LIKE ? ESCAPE '\\'`);
        parameters.push(titleQuery);
      }
    }
    if (cursor) {
      predicates.push(
        `(items.updated_at < ? OR (items.updated_at = ? AND items.id < ?))`,
      );
      parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    parameters.push(pageSize + 1);
    const rows = db.$client
      .prepare(
        `SELECT
           items.id AS id,
           items.user_id AS userId,
           items.title AS title,
           items.kind AS kind,
           items.provenance AS provenance,
           items.current_version_id AS currentVersionId,
           items.status AS status,
           items.revision AS revision,
           items.removed_at AS removedAt,
           items.originating_session_id AS originatingSessionId,
           items.originating_source_id AS originatingSourceId,
           items.created_at AS createdAt,
           items.updated_at AS updatedAt
         FROM context_items AS items
         WHERE ${predicates.join(' AND ')}
         ORDER BY items.updated_at DESC, items.id DESC
         LIMIT ?`,
      )
      .all(...parameters) as ContextItemRow[];
    const hasMore = rows.length > pageSize;
    const selectedRows = rows.slice(0, pageSize);
    const items = selectedRows.flatMap((item) => {
      const dto = contextItemDto(db, context.userId, item, {
        requireLibraryVisibility: true,
      });
      return dto ? [dto] : [];
    });
    const revision = getContextRevision(context.userId);
    if (revision === null) return null;
    return {
      items,
      nextCursor:
        hasMore && selectedRows.length
          ? encodeCursor({
              updatedAt: selectedRows[selectedRows.length - 1]!.updatedAt,
              id: selectedRows[selectedRows.length - 1]!.id,
            })
          : null,
      revision,
    };
  } catch {
    return null;
  }
};

export const getContextItem = async (
  context: AuthorizedContext,
  input: unknown,
): Promise<{
  item: ContextItemDTO;
  versions: ContextVersionDTO[];
  preview: ContextPreview;
} | null> => {
  const parsed = getContextItemInputSchema.safeParse(input);
  if (
    !parsed.success ||
    !context.userId.trim() ||
    context.signal.aborted ||
    !context.isCurrent()
  )
    return null;
  try {
    const item = db
      .select()
      .from(ContextItemTable)
      .where(
        and(
          eq(ContextItemTable.userId, context.userId),
          eq(ContextItemTable.id, parsed.data.itemId),
          isNull(ContextItemTable.removedAt),
        ),
      )
      .get();
    if (!item) return null;
    const itemDto = contextItemDto(db, context.userId, item, {
      requireLibraryVisibility: true,
    });
    if (!itemDto) return null;
    const storedVersions = db
      .select()
      .from(ContextVersionTable)
      .where(
        and(
          eq(ContextVersionTable.userId, context.userId),
          eq(ContextVersionTable.itemId, item.id),
        ),
      )
      .all()
      .slice(-50);
    const versions = (
      await Promise.all(
        storedVersions.map(async (version) => {
          const originalAvailable = version.originalStorageKey
            ? await originalStore.has(
                context.userId,
                version.originalStorageKey,
              )
            : false;
          return contextVersionDto(version, originalAvailable);
        }),
      )
    ).flatMap((version) => (version ? [version] : []));
    if (context.signal.aborted || !context.isCurrent()) return null;
    const selectedVersionId = parsed.data.versionId ?? item.currentVersionId;
    if (!selectedVersionId) {
      return {
        item: itemDto,
        versions,
        preview: { kind: 'unavailable', reason: 'processing' },
      };
    }
    const selectedVersion = db
      .select()
      .from(ContextVersionTable)
      .where(
        and(
          eq(ContextVersionTable.userId, context.userId),
          eq(ContextVersionTable.itemId, item.id),
          eq(ContextVersionTable.id, selectedVersionId),
        ),
      )
      .get();
    if (!selectedVersion) return null;
    return {
      item: itemDto,
      versions,
      preview: previewForVersion(selectedVersion),
    };
  } catch {
    return null;
  }
};

export const createContextNote = async (
  context: AuthorizedContext,
  input: unknown,
): Promise<ContextItemDTO> => {
  assertAuthorized(context);
  const parsed = parseOrThrow(createContextNoteInputSchema, input);
  if (parsed.courseId) getOwnedCourse(db, context.userId, parsed.courseId);
  const bytes = Buffer.from(parsed.text, 'utf8');
  const contentHash = hashText(bytes);
  const now = timestamp();
  try {
    db.transaction((transaction) => {
      const existing = transaction
        .select()
        .from(ContextItemTable)
        .where(eq(ContextItemTable.id, parsed.requestId))
        .get();
      if (existing) {
        if (existing.userId !== context.userId)
          throw new ContextStoreError('scope-denied');
        const existingVersion = existing.currentVersionId
          ? transaction
              .select()
              .from(ContextVersionTable)
              .where(
                and(
                  eq(ContextVersionTable.userId, context.userId),
                  eq(ContextVersionTable.itemId, existing.id),
                  eq(ContextVersionTable.id, existing.currentVersionId),
                ),
              )
              .get()
          : undefined;
        const existingCourseIds = transaction
          .select({ courseId: ContextLinkTable.courseId })
          .from(ContextLinkTable)
          .where(
            and(
              eq(ContextLinkTable.userId, context.userId),
              eq(ContextLinkTable.itemId, existing.id),
              sql`${ContextLinkTable.courseId} IS NOT NULL`,
            ),
          )
          .all()
          .flatMap(({ courseId }) => (courseId ? [courseId] : []));
        const hasRequestedCourse = parsed.courseId
          ? existingCourseIds.length === 1 &&
            existingCourseIds[0] === parsed.courseId
          : existingCourseIds.length === 0;
        if (
          !existing.removedAt &&
          existing.title === parsed.title &&
          existing.kind === parsed.kind &&
          existingVersion?.extractedText === parsed.text &&
          hasRequestedCourse
        )
          return;
        throw new ContextStoreError('revision-conflict');
      }
      const versionId = randomUUID();
      transaction
        .insert(ContextItemTable)
        .values({
          id: parsed.requestId,
          userId: context.userId,
          title: parsed.title,
          kind: parsed.kind,
          provenance: 'user-authored',
          currentVersionId: versionId,
          status: 'complete',
          revision: 0,
          removedAt: null,
          originatingSessionId: null,
          originatingSourceId: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      transaction
        .insert(ContextVersionTable)
        .values({
          id: versionId,
          userId: context.userId,
          itemId: parsed.requestId,
          attemptId: parsed.requestId,
          originalHash: contentHash,
          contentHash,
          mimeType: 'text/plain',
          byteLength: bytes.byteLength,
          originalStorageKey: null,
          extractedText: parsed.text,
          extractionStatus: 'complete',
          uncertainty: null,
          pageCount: null,
          interpretedPages: [],
          locators: chunkText(parsed.text).map(({ locator }) => locator),
          createdAt: now,
        })
        .run();
      const chunks = chunkText(parsed.text);
      transaction
        .insert(ContextChunkTable)
        .values(
          chunks.map((chunk, ordinal) => ({
            id: randomUUID(),
            userId: context.userId,
            itemId: parsed.requestId,
            versionId,
            ordinal,
            locator: chunk.locator,
            text: chunk.text,
          })),
        )
        .run();
      insertLinkIfMissing(transaction, {
        userId: context.userId,
        itemId: parsed.requestId,
        courseId: null,
        sessionId: null,
        retainedInLibrary: true,
      });
      if (parsed.courseId)
        insertLinkIfMissing(transaction, {
          userId: context.userId,
          itemId: parsed.requestId,
          courseId: parsed.courseId,
          sessionId: null,
          retainedInLibrary: false,
        });
    });
  } catch (error) {
    if (error instanceof ContextStoreError) throw error;
    throw new ContextStoreError('storage-failed');
  }
  const createdContextItem = getVisibleItem(context.userId, parsed.requestId);
  if (!createdContextItem) throw new ContextStoreError('storage-failed');
  return createdContextItem;
};

export const saveGeneratedContextItem = async (
  context: AuthorizedContext,
  input: unknown,
): Promise<ContextItemDTO> => {
  assertAuthorized(context);
  const parsed = parseOrThrow(saveGeneratedContextItemInputSchema, input);
  assertCourseAndSessionScope(
    db,
    context.userId,
    parsed.courseId,
    parsed.sessionId,
  );
  const bytes = Buffer.from(parsed.text, 'utf8');
  const contentHash = hashText(bytes);
  const now = timestamp();
  try {
    db.transaction((transaction) => {
      const existing = transaction
        .select()
        .from(ContextItemTable)
        .where(eq(ContextItemTable.id, parsed.requestId))
        .get();
      if (existing) {
        if (existing.userId !== context.userId)
          throw new ContextStoreError('scope-denied');
        const existingVersion = existing.currentVersionId
          ? transaction
              .select()
              .from(ContextVersionTable)
              .where(
                and(
                  eq(ContextVersionTable.userId, context.userId),
                  eq(ContextVersionTable.itemId, existing.id),
                  eq(ContextVersionTable.id, existing.currentVersionId),
                ),
              )
              .get()
          : undefined;
        const existingLinks = transaction
          .select()
          .from(ContextLinkTable)
          .where(
            and(
              eq(ContextLinkTable.userId, context.userId),
              eq(ContextLinkTable.itemId, existing.id),
            ),
          )
          .all();
        const existingCourseIds = existingLinks.flatMap((link) =>
          link.courseId ? [link.courseId] : [],
        );
        const existingSessionIds = existingLinks.flatMap((link) =>
          link.sessionId ? [link.sessionId] : [],
        );
        const sameCourseScope = parsed.courseId
          ? existingCourseIds.length === 1 &&
            existingCourseIds[0] === parsed.courseId
          : existingCourseIds.length === 0;
        const sameSessionScope = parsed.sessionId
          ? existingSessionIds.length === 1 &&
            existingSessionIds[0] === parsed.sessionId
          : existingSessionIds.length === 0;
        const retainedInLibrary = existingLinks.some(
          (link) =>
            link.courseId === null &&
            link.sessionId === null &&
            link.retainedInLibrary,
        );
        if (
          !existing.removedAt &&
          existing.title === parsed.title &&
          existing.kind === parsed.kind &&
          existing.provenance === 'ai-generated' &&
          existing.originatingSourceId === parsed.sourceId &&
          existingVersion?.extractedText === parsed.text &&
          sameCourseScope &&
          sameSessionScope &&
          retainedInLibrary
        )
          return;
        throw new ContextStoreError('revision-conflict');
      }
      const versionId = randomUUID();
      transaction
        .insert(ContextItemTable)
        .values({
          id: parsed.requestId,
          userId: context.userId,
          title: parsed.title,
          kind: parsed.kind,
          provenance: 'ai-generated',
          currentVersionId: versionId,
          status: 'complete',
          revision: 0,
          removedAt: null,
          originatingSessionId: parsed.sessionId ?? null,
          originatingSourceId: parsed.sourceId,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      transaction
        .insert(ContextVersionTable)
        .values({
          id: versionId,
          userId: context.userId,
          itemId: parsed.requestId,
          attemptId: parsed.requestId,
          originalHash: contentHash,
          contentHash,
          mimeType: 'text/plain',
          byteLength: bytes.byteLength,
          originalStorageKey: null,
          extractedText: parsed.text,
          extractionStatus: 'complete',
          uncertainty: null,
          pageCount: null,
          interpretedPages: [],
          locators: chunkText(parsed.text).map(({ locator }) => locator),
          createdAt: now,
        })
        .run();
      const chunks = chunkText(parsed.text);
      transaction
        .insert(ContextChunkTable)
        .values(
          chunks.map((chunk, ordinal) => ({
            id: randomUUID(),
            userId: context.userId,
            itemId: parsed.requestId,
            versionId,
            ordinal,
            locator: chunk.locator,
            text: chunk.text,
          })),
        )
        .run();
      insertLinkIfMissing(transaction, {
        userId: context.userId,
        itemId: parsed.requestId,
        courseId: null,
        sessionId: null,
        retainedInLibrary: true,
      });
      if (parsed.courseId)
        insertLinkIfMissing(transaction, {
          userId: context.userId,
          itemId: parsed.requestId,
          courseId: parsed.courseId,
          sessionId: null,
          retainedInLibrary: false,
        });
      if (parsed.sessionId)
        insertLinkIfMissing(transaction, {
          userId: context.userId,
          itemId: parsed.requestId,
          courseId: null,
          sessionId: parsed.sessionId,
          retainedInLibrary: false,
        });
    });
  } catch (error) {
    if (error instanceof ContextStoreError) throw error;
    throw new ContextStoreError('storage-failed');
  }
  const savedContextItem = getVisibleItem(context.userId, parsed.requestId);
  if (!savedContextItem) throw new ContextStoreError('storage-failed');
  return savedContextItem;
};

export const updateContextItem = async (
  context: AuthorizedContext,
  input: unknown,
): Promise<ContextItemDTO> => {
  assertAuthorized(context);
  const parsed = parseOrThrow(updateContextItemInputSchema, input);
  if (parsed.courseId) getOwnedCourse(db, context.userId, parsed.courseId);
  const now = timestamp();
  try {
    db.transaction((transaction) => {
      const item = getOwnedItem(transaction, context.userId, parsed.itemId);
      if (item.revision !== parsed.expectedRevision)
        throw new ContextStoreError('revision-conflict');
      if (
        parsed.text !== undefined &&
        item.kind !== 'note' &&
        item.kind !== 'preference'
      )
        throw new ContextStoreError('unsupported');
      let currentVersionId = item.currentVersionId;
      if (parsed.text !== undefined) {
        const bytes = Buffer.from(parsed.text, 'utf8');
        const contentHash = hashText(bytes);
        const versionId = randomUUID();
        transaction
          .insert(ContextVersionTable)
          .values({
            id: versionId,
            userId: context.userId,
            itemId: item.id,
            attemptId: randomUUID(),
            originalHash: contentHash,
            contentHash,
            mimeType: 'text/plain',
            byteLength: bytes.byteLength,
            originalStorageKey: null,
            extractedText: parsed.text,
            extractionStatus: 'complete',
            uncertainty: null,
            pageCount: null,
            interpretedPages: [],
            locators: chunkText(parsed.text).map(({ locator }) => locator),
            createdAt: now,
          })
          .run();
        const chunks = chunkText(parsed.text);
        transaction
          .insert(ContextChunkTable)
          .values(
            chunks.map((chunk, ordinal) => ({
              id: randomUUID(),
              userId: context.userId,
              itemId: item.id,
              versionId,
              ordinal,
              locator: chunk.locator,
              text: chunk.text,
            })),
          )
          .run();
        if (item.currentVersionId)
          transaction
            .update(StudySourceReferenceTable)
            .set({ state: 'historical' })
            .where(
              and(
                eq(StudySourceReferenceTable.userId, context.userId),
                eq(StudySourceReferenceTable.sourceKind, 'context-version'),
                eq(StudySourceReferenceTable.sourceId, item.id),
                eq(StudySourceReferenceTable.versionId, item.currentVersionId),
                eq(StudySourceReferenceTable.state, 'current'),
              ),
            )
            .run();
        currentVersionId = versionId;
      }
      transaction
        .update(ContextItemTable)
        .set({
          ...(parsed.title !== undefined ? { title: parsed.title } : {}),
          currentVersionId,
          revision: item.revision + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(ContextItemTable.userId, context.userId),
            eq(ContextItemTable.id, item.id),
            eq(ContextItemTable.revision, parsed.expectedRevision),
            isNull(ContextItemTable.removedAt),
          ),
        )
        .run();
      const selectedCourseId = parsed.courseId;
      if (selectedCourseId !== undefined)
        setLinkScope(
          transaction,
          context.userId,
          item.id,
          selectedCourseId,
          null,
          true,
        );
    });
  } catch (error) {
    if (error instanceof ContextStoreError) throw error;
    throw new ContextStoreError('storage-failed');
  }
  const updatedContextItem = getVisibleItem(context.userId, parsed.itemId);
  if (!updatedContextItem) throw new ContextStoreError('storage-failed');
  return updatedContextItem;
};

export const linkContextItem = async (
  context: AuthorizedContext,
  input: unknown,
): Promise<ContextItemDTO> => {
  assertAuthorized(context);
  const parsed = parseOrThrow(linkContextItemInputSchema, input);
  assertCourseAndSessionScope(
    db,
    context.userId,
    parsed.courseId,
    parsed.sessionId,
  );
  try {
    db.transaction((transaction) => {
      getOwnedItem(transaction, context.userId, parsed.itemId);
      setLinkScope(
        transaction,
        context.userId,
        parsed.itemId,
        parsed.courseId,
        parsed.sessionId ?? null,
        parsed.retainInLibrary,
      );
      const links = transaction
        .select()
        .from(ContextLinkTable)
        .where(
          and(
            eq(ContextLinkTable.userId, context.userId),
            eq(ContextLinkTable.itemId, parsed.itemId),
          ),
        )
        .all();
      if (
        !links.some(
          (link) =>
            link.retainedInLibrary ||
            link.courseId !== null ||
            link.sessionId !== null,
        )
      )
        throw new ContextStoreError('invalid-input');
      transaction
        .update(ContextItemTable)
        .set({
          revision: sql`${ContextItemTable.revision} + 1`,
          updatedAt: timestamp(),
        })
        .where(
          and(
            eq(ContextItemTable.userId, context.userId),
            eq(ContextItemTable.id, parsed.itemId),
          ),
        )
        .run();
    });
  } catch (error) {
    if (error instanceof ContextStoreError) throw error;
    throw new ContextStoreError('storage-failed');
  }
  const linkedContextItem = getVisibleItem(context.userId, parsed.itemId);
  if (linkedContextItem) return linkedContextItem;
  const item = getUnremovedItemForOwner(context.userId, parsed.itemId);
  const sessionItem = item ? contextItemDto(db, context.userId, item) : null;
  if (!sessionItem) throw new ContextStoreError('storage-failed');
  return sessionItem;
};

export const createUploadedContextItem = async (
  context: AuthorizedContext,
  input: unknown,
): Promise<ContextItemDTO> => {
  assertAuthorized(context);
  const parsed = parseOrThrow(createUploadedContextItemInputSchema, input);
  assertCourseAndSessionScope(
    db,
    context.userId,
    parsed.courseId,
    parsed.sessionId,
  );
  if (!parsed.saveToLibrary && !parsed.sessionId && !parsed.courseId)
    throw new ContextStoreError('invalid-input');
  const now = timestamp();
  try {
    db.transaction((transaction) => {
      const existing = transaction
        .select()
        .from(ContextItemTable)
        .where(eq(ContextItemTable.id, parsed.itemId))
        .get();
      if (existing) {
        if (existing.userId !== context.userId)
          throw new ContextStoreError('scope-denied');
        throw new ContextStoreError('revision-conflict');
      }
      transaction
        .insert(ContextItemTable)
        .values({
          id: parsed.itemId,
          userId: context.userId,
          title: parsed.title,
          kind: parsed.kind,
          provenance: 'user-uploaded',
          currentVersionId: null,
          status: 'queued',
          revision: 0,
          removedAt: null,
          originatingSessionId: parsed.sessionId ?? null,
          originatingSourceId: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      if (parsed.courseId)
        insertLinkIfMissing(transaction, {
          userId: context.userId,
          itemId: parsed.itemId,
          courseId: parsed.courseId,
          sessionId: null,
          retainedInLibrary: false,
        });
      if (parsed.sessionId)
        insertLinkIfMissing(transaction, {
          userId: context.userId,
          itemId: parsed.itemId,
          courseId: null,
          sessionId: parsed.sessionId,
          retainedInLibrary: false,
        });
      if (parsed.saveToLibrary)
        insertLinkIfMissing(transaction, {
          userId: context.userId,
          itemId: parsed.itemId,
          courseId: null,
          sessionId: null,
          retainedInLibrary: true,
        });
    });
  } catch (error) {
    if (error instanceof ContextStoreError) throw error;
    throw new ContextStoreError('storage-failed');
  }
  const createdContextItem = getUnremovedItemForOwner(
    context.userId,
    parsed.itemId,
  );
  const dto = createdContextItem
    ? contextItemDto(db, context.userId, createdContextItem)
    : null;
  if (!dto) throw new ContextStoreError('storage-failed');
  return dto;
};

export const setContextIngestionStatus = async (
  context: AuthorizedContext,
  input: unknown,
): Promise<ContextItemDTO> => {
  assertAuthorized(context);
  const parsed = parseOrThrow(contextStatusInputSchema, input);
  try {
    db.transaction((transaction) => {
      const item = getOwnedItem(transaction, context.userId, parsed.itemId);
      if (item.revision !== parsed.expectedRevision)
        throw new ContextStoreError('revision-conflict');
      transaction
        .update(ContextItemTable)
        .set({
          status: parsed.status,
          revision: item.revision + 1,
          updatedAt: timestamp(),
        })
        .where(
          and(
            eq(ContextItemTable.userId, context.userId),
            eq(ContextItemTable.id, item.id),
            eq(ContextItemTable.revision, parsed.expectedRevision),
            isNull(ContextItemTable.removedAt),
          ),
        )
        .run();
    });
  } catch (error) {
    if (error instanceof ContextStoreError) throw error;
    throw new ContextStoreError('storage-failed');
  }
  const updatedContextItem = getUnremovedItemForOwner(
    context.userId,
    parsed.itemId,
  );
  const dto = updatedContextItem
    ? contextItemDto(db, context.userId, updatedContextItem)
    : null;
  if (!dto) throw new ContextStoreError('storage-failed');
  return dto;
};

export const saveContextIngestionResult = async (
  context: AuthorizedContext,
  input: unknown,
): Promise<ContextItemDTO> => {
  assertAuthorized(context);
  const parsed = parseOrThrow(contextVersionWriteInputSchema, input);
  if (
    parsed.extractedText !== null &&
    hashText(parsed.extractedText) !== parsed.contentHash
  )
    throw new ContextStoreError('invalid-input');
  if (
    (parsed.extractionStatus === 'complete' ||
      parsed.extractionStatus === 'partial') &&
    !parsed.extractedText?.trim()
  )
    throw new ContextStoreError('invalid-input');
  const cleanupNewOriginal = async () => {
    if (parsed.originalIsNew && parsed.originalStorageKey)
      await removeOriginalKeysIfUnreferenced(context.userId, [
        parsed.originalStorageKey,
      ]).catch(() => {});
  };
  try {
    if (parsed.originalStorageKey) {
      const originalBytes = await originalStore.read(
        context.userId,
        parsed.originalStorageKey,
        parsed.originalHash,
      );
      if (originalBytes.byteLength !== parsed.byteLength)
        throw new ContextStoreError('invalid-input');
    }
    assertAuthorized(context);
  } catch (error) {
    await cleanupNewOriginal();
    if (error instanceof ContextStoreError) throw error;
    throw new ContextStoreError('storage-failed');
  }
  const versionId = randomUUID();
  const now = timestamp();
  try {
    db.transaction((transaction) => {
      const item = getOwnedItem(transaction, context.userId, parsed.itemId);
      const sameAttempt = transaction
        .select()
        .from(ContextVersionTable)
        .where(
          and(
            eq(ContextVersionTable.userId, context.userId),
            eq(ContextVersionTable.itemId, item.id),
            eq(ContextVersionTable.attemptId, parsed.attemptId),
          ),
        )
        .get();
      if (sameAttempt) {
        if (
          sameAttempt.originalHash === parsed.originalHash &&
          sameAttempt.mimeType === parsed.mimeType &&
          sameAttempt.byteLength === parsed.byteLength &&
          sameAttempt.originalStorageKey === parsed.originalStorageKey &&
          sameAttempt.contentHash === parsed.contentHash &&
          sameAttempt.extractedText === parsed.extractedText &&
          sameAttempt.extractionStatus === parsed.extractionStatus &&
          sameAttempt.uncertainty === parsed.uncertainty &&
          sameAttempt.pageCount === parsed.pageCount &&
          JSON.stringify(sameAttempt.interpretedPages) ===
            JSON.stringify(parsed.interpretedPages) &&
          JSON.stringify(sameAttempt.locators) ===
            JSON.stringify(parsed.locators)
        )
          return;
        throw new ContextStoreError('revision-conflict');
      }
      if (item.revision !== parsed.expectedRevision)
        throw new ContextStoreError('revision-conflict');
      transaction
        .insert(ContextVersionTable)
        .values({
          id: versionId,
          userId: context.userId,
          itemId: item.id,
          attemptId: parsed.attemptId,
          originalHash: parsed.originalHash,
          contentHash: parsed.contentHash,
          mimeType: parsed.mimeType,
          byteLength: parsed.byteLength,
          originalStorageKey: parsed.originalStorageKey,
          extractedText: parsed.extractedText,
          extractionStatus: parsed.extractionStatus,
          uncertainty: parsed.uncertainty,
          pageCount: parsed.pageCount,
          interpretedPages: parsed.interpretedPages,
          locators: parsed.locators,
          createdAt: now,
        })
        .run();
      const usable =
        (parsed.extractionStatus === 'complete' ||
          parsed.extractionStatus === 'partial') &&
        Boolean(parsed.extractedText?.trim());
      if (usable) {
        const chunks = chunkText(parsed.extractedText ?? '');
        if (chunks.length)
          transaction
            .insert(ContextChunkTable)
            .values(
              chunks.map((chunk, ordinal) => ({
                id: randomUUID(),
                userId: context.userId,
                itemId: item.id,
                versionId,
                ordinal,
                locator: chunk.locator,
                text: chunk.text,
              })),
            )
            .run();
        if (item.currentVersionId)
          transaction
            .update(StudySourceReferenceTable)
            .set({ state: 'historical' })
            .where(
              and(
                eq(StudySourceReferenceTable.userId, context.userId),
                eq(StudySourceReferenceTable.sourceKind, 'context-version'),
                eq(StudySourceReferenceTable.sourceId, item.id),
                eq(StudySourceReferenceTable.versionId, item.currentVersionId),
                eq(StudySourceReferenceTable.state, 'current'),
              ),
            )
            .run();
      }
      transaction
        .update(ContextItemTable)
        .set({
          status: parsed.extractionStatus,
          ...(usable ? { currentVersionId: versionId } : {}),
          revision: item.revision + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(ContextItemTable.userId, context.userId),
            eq(ContextItemTable.id, item.id),
            eq(ContextItemTable.revision, parsed.expectedRevision),
            isNull(ContextItemTable.removedAt),
          ),
        )
        .run();
    });
  } catch (error) {
    await cleanupNewOriginal();
    if (error instanceof ContextStoreError) throw error;
    throw new ContextStoreError('storage-failed');
  }
  const updatedContextItem = getUnremovedItemForOwner(
    context.userId,
    parsed.itemId,
  );
  const dto = updatedContextItem
    ? contextItemDto(db, context.userId, updatedContextItem)
    : null;
  if (!dto) throw new ContextStoreError('storage-failed');
  return dto;
};

export const removeContextItem = async (
  context: AuthorizedContext,
  input: unknown,
): Promise<void> => {
  assertAuthorized(context);
  const parsed = parseOrThrow(removeContextItemInputSchema, input);
  const originalKeys = getOriginalKeysForItem(context.userId, parsed.itemId);
  try {
    db.transaction((transaction) => {
      const item = getOwnedItem(transaction, context.userId, parsed.itemId);
      if (item.revision !== parsed.expectedRevision)
        throw new ContextStoreError('revision-conflict');
      deleteContextItemData(transaction, context.userId, item.id);
    });
  } catch (error) {
    if (error instanceof ContextStoreError) throw error;
    throw new ContextStoreError('storage-failed');
  }
  try {
    await removeOriginalKeysIfUnreferenced(context.userId, originalKeys);
  } catch {
    throw new ContextStoreError('storage-failed', true);
  }
};

export const releaseContextSession = async (
  context: AuthorizedContext,
  input: unknown,
): Promise<void> => {
  assertAuthorized(context);
  const parsed = parseOrThrow(sessionInputSchema, input);
  getOwnedSession(db, context.userId, parsed.sessionId);
  const sessionLinks = db
    .select()
    .from(ContextLinkTable)
    .where(
      and(
        eq(ContextLinkTable.userId, context.userId),
        eq(ContextLinkTable.sessionId, parsed.sessionId),
      ),
    )
    .all();
  const originalKeys: string[] = [];
  try {
    db.transaction((transaction) => {
      for (const link of sessionLinks) {
        const otherScope =
          link.courseId !== null
            ? linkExists(
                transaction,
                context.userId,
                link.itemId,
                link.courseId,
                null,
              )
            : link.retainedInLibrary
              ? linkExists(transaction, context.userId, link.itemId, null, null)
              : null;
        if (otherScope) {
          transaction
            .delete(ContextLinkTable)
            .where(eq(ContextLinkTable.id, link.id))
            .run();
        } else if (link.courseId !== null || link.retainedInLibrary) {
          transaction
            .update(ContextLinkTable)
            .set({ sessionId: null })
            .where(eq(ContextLinkTable.id, link.id))
            .run();
        } else {
          transaction
            .delete(ContextLinkTable)
            .where(eq(ContextLinkTable.id, link.id))
            .run();
        }
      }
      const affectedItemIds = [
        ...new Set(sessionLinks.map((link) => link.itemId)),
      ];
      for (const itemId of affectedItemIds) {
        const remainingLinks = transaction
          .select()
          .from(ContextLinkTable)
          .where(
            and(
              eq(ContextLinkTable.userId, context.userId),
              eq(ContextLinkTable.itemId, itemId),
            ),
          )
          .all();
        if (
          remainingLinks.some(
            (link) =>
              link.courseId !== null ||
              link.sessionId !== null ||
              link.retainedInLibrary,
          )
        ) {
          const retainedContextItem = transaction
            .select()
            .from(ContextItemTable)
            .where(
              and(
                eq(ContextItemTable.userId, context.userId),
                eq(ContextItemTable.id, itemId),
                isNull(ContextItemTable.removedAt),
              ),
            )
            .get();
          if (retainedContextItem?.originatingSessionId === parsed.sessionId)
            transaction
              .update(ContextItemTable)
              .set({
                originatingSessionId: null,
                revision: retainedContextItem.revision + 1,
                updatedAt: timestamp(),
              })
              .where(eq(ContextItemTable.id, itemId))
              .run();
          continue;
        }
        const item = transaction
          .select()
          .from(ContextItemTable)
          .where(
            and(
              eq(ContextItemTable.userId, context.userId),
              eq(ContextItemTable.id, itemId),
              isNull(ContextItemTable.removedAt),
            ),
          )
          .get();
        if (!item) continue;
        originalKeys.push(
          ...transaction
            .select({
              originalStorageKey: ContextVersionTable.originalStorageKey,
            })
            .from(ContextVersionTable)
            .where(
              and(
                eq(ContextVersionTable.userId, context.userId),
                eq(ContextVersionTable.itemId, itemId),
              ),
            )
            .all()
            .flatMap(({ originalStorageKey }) =>
              originalStorageKey ? [originalStorageKey] : [],
            ),
        );
        deleteContextItemData(transaction, context.userId, itemId);
      }
    });
  } catch (error) {
    if (error instanceof ContextStoreError) throw error;
    throw new ContextStoreError('storage-failed');
  }
  await removeOriginalKeysIfUnreferenced(context.userId, originalKeys).catch(
    () => {
      throw new ContextStoreError('storage-failed', true);
    },
  );
};

export const cleanupOrphanedContextOriginals = async (
  context: AuthorizedContext,
): Promise<void> => {
  assertAuthorized(context);
  try {
    const accountFiles = await originalStore.list(context.userId);
    assertAuthorized(context);
    const retainedKeys = new Set(
      db
        .select({ originalStorageKey: ContextVersionTable.originalStorageKey })
        .from(ContextVersionTable)
        .where(
          and(
            eq(ContextVersionTable.userId, context.userId),
            sql`${ContextVersionTable.originalStorageKey} IS NOT NULL`,
          ),
        )
        .all()
        .flatMap(({ originalStorageKey }) =>
          originalStorageKey ? [originalStorageKey] : [],
        ),
    );
    for (const storageKey of accountFiles) {
      assertAuthorized(context);
      if (!retainedKeys.has(storageKey))
        await originalStore.remove(context.userId, storageKey);
    }
  } catch {
    throw new ContextStoreError('storage-failed');
  }
};

export const deleteAllContextForAccount = async (
  context: AuthorizedContext,
): Promise<void> => {
  assertAuthorized(context);
  const originalKeys = db
    .select({ originalStorageKey: ContextVersionTable.originalStorageKey })
    .from(ContextVersionTable)
    .where(
      and(
        eq(ContextVersionTable.userId, context.userId),
        sql`${ContextVersionTable.originalStorageKey} IS NOT NULL`,
      ),
    )
    .all()
    .flatMap(({ originalStorageKey }) =>
      originalStorageKey ? [originalStorageKey] : [],
    );
  try {
    db.transaction((transaction) => {
      transaction
        .delete(StudySourceReferenceTable)
        .where(
          and(
            eq(StudySourceReferenceTable.userId, context.userId),
            eq(StudySourceReferenceTable.sourceKind, 'context-version'),
          ),
        )
        .run();
      transaction
        .delete(ContextChunkTable)
        .where(eq(ContextChunkTable.userId, context.userId))
        .run();
      transaction
        .delete(ContextLinkTable)
        .where(eq(ContextLinkTable.userId, context.userId))
        .run();
      transaction
        .delete(ContextVersionTable)
        .where(eq(ContextVersionTable.userId, context.userId))
        .run();
      transaction
        .delete(ContextItemTable)
        .where(eq(ContextItemTable.userId, context.userId))
        .run();
    });
  } catch {
    throw new ContextStoreError('storage-failed');
  }
  try {
    const accountOriginals = await originalStore.list(context.userId);
    await removeOriginalKeysIfUnreferenced(context.userId, [
      ...originalKeys,
      ...accountOriginals,
    ]);
  } catch {
    throw new ContextStoreError('storage-failed', true);
  }
};

export const resolveHistoricalContextCitation = (
  context: AuthorizedContext,
  input: {
    sessionId: string;
    sourceId: string;
    versionId: string;
    locator?: Locator | null;
  },
): { reference: SourceReference; text: string } | null => {
  if (!context.userId.trim() || context.signal.aborted || !context.isCurrent())
    return null;
  const parsed = z
    .strictObject({
      sessionId: idSchema,
      sourceId: idSchema,
      versionId: idSchema,
      locator: locatorSchema.nullable().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return null;
  try {
    const session = getOwnedSession(db, context.userId, parsed.data.sessionId);
    const citedReference = db
      .select()
      .from(StudySourceReferenceTable)
      .where(
        and(
          eq(StudySourceReferenceTable.userId, context.userId),
          eq(StudySourceReferenceTable.sessionId, session.id),
          eq(StudySourceReferenceTable.sourceKind, 'context-version'),
          eq(StudySourceReferenceTable.sourceId, parsed.data.sourceId),
          or(
            eq(StudySourceReferenceTable.versionId, parsed.data.versionId),
            and(
              eq(StudySourceReferenceTable.state, 'removed'),
              isNull(StudySourceReferenceTable.versionId),
            ),
          ),
        ),
      )
      .get();
    if (!citedReference) return null;
    const item = db
      .select()
      .from(ContextItemTable)
      .where(
        and(
          eq(ContextItemTable.userId, context.userId),
          eq(ContextItemTable.id, parsed.data.sourceId),
        ),
      )
      .get();
    if (!item) return null;
    if (citedReference.state === 'removed' || item.removedAt) {
      return {
        reference: {
          sourceKind: 'context-version',
          sourceId: item.id,
          versionId: null,
          courseId: session.courseId,
          locator: null,
          title: 'Removed source',
          provenance: item.provenance,
          observedAt: null,
          state: 'removed',
        },
        text: 'This source was removed.',
      };
    }
    const version = db
      .select()
      .from(ContextVersionTable)
      .where(
        and(
          eq(ContextVersionTable.userId, context.userId),
          eq(ContextVersionTable.itemId, item.id),
          eq(ContextVersionTable.id, parsed.data.versionId),
        ),
      )
      .get();
    if (!version || version.extractedText === null) return null;
    const locator = citedReference.locator ?? parsed.data.locator ?? null;
    return {
      reference: {
        sourceKind: 'context-version',
        sourceId: item.id,
        versionId: version.id,
        courseId: session.courseId,
        locator,
        title: item.title,
        provenance: item.provenance,
        observedAt: version.createdAt,
        state:
          citedReference.state === 'current' &&
          item.currentVersionId === version.id
            ? 'current'
            : 'historical',
      },
      text: truncateContextText(version.extractedText, passageTextLimit),
    };
  } catch {
    return null;
  }
};

export const normalizeContextSearchQuery = queryFromText;
export const contextPassageLimit = passageTextLimit;
export const contextChunkScanLimit = maximumContextChunks;
export const contextStoreTimestamp = timestamp;
