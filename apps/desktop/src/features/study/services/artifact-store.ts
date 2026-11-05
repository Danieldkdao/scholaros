import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  activityCandidateSchema,
  activityStateByteLimit,
  artifactStateSchema,
  artifactVersionSchema,
  type ArtifactStateDTO,
  type ArtifactVersionDTO,
} from '@scholaros/services/learning/activity-contracts';
import {
  contextItemSchema,
  sourceReferenceSchema,
  type ContextItemDTO,
  type SourceReference,
} from '@scholaros/services/learning/context-contracts';
import {
  idSchema,
  jsonValueSchema,
  requestIdSchema,
  revisionSchema,
  type AuthorizedContext,
  type JsonValue,
  type SafeErrorCode,
} from '@scholaros/services/learning/product-contracts';
import {
  studyMessagePartSchema,
  type MessagePart,
} from '@scholaros/services/learning/study-contracts';
import * as schema from '../../../db/schema';
import {
  ArtifactStateTable,
  ArtifactTable,
  ArtifactVersionTable,
  ContextItemTable,
  ContextLinkTable,
  ContextVersionTable,
  CourseTable,
  StudySessionTable,
  StudyTurnTable,
} from '../../../db/schema';
import {
  acceptedActivityBundleByteLimit,
  createActivityCandidateDigest,
  validateActivityCandidate,
  type ActivityValidationFailure,
} from './artifact-validation';

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: SafeErrorCode,
    readonly validationReason?: ActivityValidationFailure['reason'],
  ) {
    super('The activity could not be saved or opened.');
    this.name = 'ArtifactStoreError';
  }
}

export type CreateArtifactVersionInput = {
  sessionId: string;
  turnId: string;
  artifactId?: string;
  candidate: unknown;
  policyDecision: {
    allowed: boolean;
    reasonCode: string;
    revision: number;
    safeParts?: MessagePart[];
  };
  requestId: string;
};

export type CreateArtifactVersionResult = {
  version: ArtifactVersionDTO;
  attemptId: string;
};

export type AuthorizedActivityRun = {
  runId: string;
  sessionId: string;
  artifactId: string;
  versionId: string;
  attemptId: string;
  contentDigest: string;
  bundle: {
    title: string;
    objective: string;
    html: string;
    css: string;
    javascript: string;
    accessibleExplanation: string;
    runtimeVersion: number;
  };
  sourceReferences: SourceReference[];
  digestSourceReferences: SourceReference[];
  state: ArtifactStateDTO;
};

export type AuthorizeActivityRunInput = {
  sessionId: string;
  artifactId: string;
  versionId: string;
  attemptId: string;
  requestId: string;
};

export type CheckpointArtifactStateInput = {
  runId: string;
  sequence: number;
  expectedRevision: number;
  state: JsonValue;
};

export type ReleaseActivityRunInput =
  | { runId: string; requestId?: string }
  | { runId?: never; requestId: string };

type ArtifactDatabase = BetterSQLite3Database<typeof schema>;

type ArtifactStoreDependencies = {
  db: ArtifactDatabase;
  now?: () => string;
  createId?: () => string;
};

type StoredCandidateMetadata = {
  title: string;
  objective: string;
  accessibleExplanation: string;
  sessionId: string;
  turnId: string;
  initialAttemptId: string;
};

type StoredArtifactDecision = {
  allowed: true;
  reasonCode: string;
  revision: number;
  candidate: StoredCandidateMetadata;
};

type ActivityRunBinding = {
  userId: string;
  accountEpoch: number;
  sessionId: string;
  sessionGenerationEpoch: number;
  courseId: string;
  artifactId: string;
  versionId: string;
  attemptId: string;
  requestId: string;
  authorization: AuthorizedActivityRun;
  latestCheckpointReceipt?: {
    sequence: number;
    expectedRevision: number;
    state: JsonValue;
    dto: ArtifactStateDTO;
  };
};

const createVersionInputKeys = new Set([
  'sessionId',
  'turnId',
  'artifactId',
  'candidate',
  'policyDecision',
  'requestId',
]);

const validateCreateInput = (input: unknown) => {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ArtifactStoreError('invalid-input');
  const value = input as Record<string, unknown>;
  let candidate: ReturnType<typeof activityCandidateSchema.safeParse>;
  try {
    candidate = activityCandidateSchema.safeParse(value.candidate);
  } catch {
    throw new ArtifactStoreError('invalid-input');
  }
  if (!candidate.success) throw new ArtifactStoreError('invalid-input');
  const sessionId = idSchema.safeParse(value.sessionId);
  const turnId = idSchema.safeParse(value.turnId);
  const artifactId =
    value.artifactId === undefined
      ? undefined
      : idSchema.safeParse(value.artifactId);
  const requestId = requestIdSchema.safeParse(value.requestId);
  const decision = value.policyDecision;
  if (
    !sessionId.success ||
    !turnId.success ||
    (artifactId !== undefined && !artifactId.success) ||
    !requestId.success ||
    !decision ||
    typeof decision !== 'object' ||
    Array.isArray(decision)
  )
    throw new ArtifactStoreError('invalid-input');
  const decisionValue = decision as Record<string, unknown>;
  if (
    typeof decisionValue.allowed !== 'boolean' ||
    typeof decisionValue.reasonCode !== 'string' ||
    decisionValue.reasonCode.length > 100 ||
    !revisionSchema.safeParse(decisionValue.revision).success
  )
    throw new ArtifactStoreError('invalid-input');
  const safeParts =
    decisionValue.safeParts === undefined
      ? undefined
      : studyMessagePartSchema
          .array()
          .max(100)
          .safeParse(decisionValue.safeParts);
  if (safeParts !== undefined && !safeParts.success)
    throw new ArtifactStoreError('invalid-input');
  if (Object.keys(value).some((key) => !createVersionInputKeys.has(key)))
    throw new ArtifactStoreError('invalid-input');
  if (
    Object.keys(decisionValue).some(
      (key) =>
        !['allowed', 'reasonCode', 'revision', 'safeParts'].includes(key),
    )
  )
    throw new ArtifactStoreError('invalid-input');
  return {
    sessionId: sessionId.data,
    turnId: turnId.data,
    artifactId: artifactId?.success ? artifactId.data : undefined,
    candidate: candidate.data,
    policyDecision: {
      allowed: decisionValue.allowed,
      reasonCode: decisionValue.reasonCode,
      revision: decisionValue.revision as number,
    },
    requestId: requestId.data,
  } satisfies CreateArtifactVersionInput & {
    candidate: ReturnType<typeof activityCandidateSchema.parse>;
  };
};

const readStoredDecision = (value: unknown): StoredArtifactDecision | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const decision = value as Record<string, unknown>;
  const candidate = decision.candidate;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    return null;
  const metadata = candidate as Record<string, unknown>;
  if (
    decision.allowed !== true ||
    typeof decision.reasonCode !== 'string' ||
    decision.reasonCode.length > 100 ||
    !revisionSchema.safeParse(decision.revision).success ||
    typeof metadata.title !== 'string' ||
    typeof metadata.objective !== 'string' ||
    typeof metadata.accessibleExplanation !== 'string' ||
    typeof metadata.sessionId !== 'string' ||
    typeof metadata.turnId !== 'string' ||
    typeof metadata.initialAttemptId !== 'string'
  )
    return null;
  return {
    allowed: true,
    reasonCode: decision.reasonCode,
    revision: decision.revision as number,
    candidate: {
      title: metadata.title,
      objective: metadata.objective,
      accessibleExplanation: metadata.accessibleExplanation,
      sessionId: metadata.sessionId,
      turnId: metadata.turnId,
      initialAttemptId: metadata.initialAttemptId,
    },
  };
};

// Stored citations are provenance snapshots, not current inference authorization.
const snapshotSourceReferences = (sourceReferences: SourceReference[]) =>
  sourceReferences.map((reference) =>
    sourceReferenceSchema.parse({
      ...reference,
      state: reference.state === 'removed' ? 'removed' : 'historical',
    }),
  );

const artifactVersionDto = (
  artifactId: string,
  version: typeof ArtifactVersionTable.$inferSelect,
  historicalSources = false,
): ArtifactVersionDTO | null => {
  const decision = readStoredDecision(version.policyDecision);
  if (!decision) return null;
  const parsed = artifactVersionSchema.safeParse({
    artifactId,
    versionId: version.id,
    title: decision.candidate.title,
    objective: decision.candidate.objective,
    runtimeVersion: version.runtimeVersion,
    contentDigest: version.contentDigest,
    createdAt: version.createdAt,
    sourceReferences: historicalSources
      ? snapshotSourceReferences(version.sourceReferences)
      : version.sourceReferences,
    available: version.runtimeVersion === 1,
  });
  return parsed.success ? parsed.data : null;
};

const artifactStateDto = (
  row: typeof ArtifactStateTable.$inferSelect,
): ArtifactStateDTO | null => {
  const parsed = artifactStateSchema.safeParse({
    artifactId: row.artifactId,
    versionId: row.versionId,
    attemptId: row.attemptId,
    stateRevision: row.stateRevision,
    state: row.state,
    updatedAt: row.updatedAt,
  });
  return parsed.success ? parsed.data : null;
};

const buildCandidateBytes = (
  version: typeof ArtifactVersionTable.$inferSelect,
  decision: StoredArtifactDecision,
) => {
  const candidate = {
    title: decision.candidate.title,
    objective: decision.candidate.objective,
    html: version.html,
    css: version.css,
    javascript: version.javascript,
    accessibleExplanation: decision.candidate.accessibleExplanation,
    sourceReferences: version.sourceReferences,
    runtimeVersion: version.runtimeVersion,
  };
  const serializedCandidate = JSON.stringify(candidate);
  const contentDigest = createActivityCandidateDigest(candidate);
  return { candidate, serializedCandidate, contentDigest };
};

const isCurrentContext = (context: AuthorizedContext) =>
  !context.signal.aborted && context.isCurrent();

const assertCurrentContext = (context: AuthorizedContext) => {
  if (context.signal.aborted) throw new ArtifactStoreError('cancelled');
  if (!context.isCurrent()) throw new ArtifactStoreError('session-changed');
};

const toContextItemDto = (
  item: typeof ContextItemTable.$inferSelect,
  courseId: string | null,
  artifactId: string,
  versionId: string,
): ContextItemDTO =>
  contextItemSchema.parse({
    id: item.id,
    title: item.title,
    kind: item.kind,
    provenance: item.provenance,
    courseIds: courseId ? [courseId] : [],
    currentVersionId: item.currentVersionId,
    status: item.status,
    usable: item.status === 'complete' && item.removedAt === null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    revision: item.revision,
    source: {
      sessionId: item.originatingSessionId,
      sourceId: artifactId,
      sourceVersion: versionId,
      removed: item.removedAt !== null,
    },
  });

export const createArtifactStore = ({
  db,
  now = () => new Date().toISOString(),
  createId = randomUUID,
}: ArtifactStoreDependencies) => {
  const activeRuns = new Map<string, ActivityRunBinding>();

  const getArtifactVersion = async (
    context: AuthorizedContext,
    input: { artifactId: string; versionId: string },
  ): Promise<ArtifactVersionDTO | null> => {
    const parsedInput = {
      artifactId: idSchema.safeParse(input?.artifactId),
      versionId: idSchema.safeParse(input?.versionId),
    };
    if (!parsedInput.artifactId.success || !parsedInput.versionId.success)
      return null;
    if (!isCurrentContext(context)) return null;
    try {
      const result = db
        .select({ artifact: ArtifactTable, version: ArtifactVersionTable })
        .from(ArtifactTable)
        .innerJoin(
          ArtifactVersionTable,
          and(
            eq(ArtifactVersionTable.artifactId, ArtifactTable.id),
            eq(ArtifactVersionTable.id, parsedInput.versionId.data),
          ),
        )
        .where(
          and(
            eq(ArtifactTable.userId, context.userId),
            eq(ArtifactTable.id, parsedInput.artifactId.data),
            isNull(ArtifactTable.removedAt),
            eq(ArtifactVersionTable.userId, context.userId),
          ),
        )
        .get();
      if (!result || !isCurrentContext(context)) return null;
      return artifactVersionDto(result.artifact.id, result.version, true);
    } catch {
      return null;
    }
  };

  const getArtifactState = async (
    context: AuthorizedContext,
    input: { artifactId: string; versionId: string; attemptId: string },
  ): Promise<ArtifactStateDTO | null> => {
    const artifactId = idSchema.safeParse(input?.artifactId);
    const versionId = idSchema.safeParse(input?.versionId);
    const attemptId = idSchema.safeParse(input?.attemptId);
    if (!artifactId.success || !versionId.success || !attemptId.success)
      return null;
    if (!isCurrentContext(context)) return null;
    try {
      const row = db
        .select()
        .from(ArtifactStateTable)
        .innerJoin(
          ArtifactTable,
          and(
            eq(ArtifactTable.id, ArtifactStateTable.artifactId),
            eq(ArtifactTable.userId, context.userId),
          ),
        )
        .where(
          and(
            eq(ArtifactStateTable.userId, context.userId),
            eq(ArtifactStateTable.artifactId, artifactId.data),
            eq(ArtifactStateTable.versionId, versionId.data),
            eq(ArtifactStateTable.attemptId, attemptId.data),
            isNull(ArtifactTable.removedAt),
          ),
        )
        .get();
      if (!row || !isCurrentContext(context)) return null;
      return artifactStateDto(row.artifact_states);
    } catch {
      return null;
    }
  };

  const createArtifactVersion = async (
    context: AuthorizedContext,
    input: CreateArtifactVersionInput,
  ): Promise<CreateArtifactVersionResult> => {
    const parsedInput = validateCreateInput(input);
    assertCurrentContext(context);
    if (!parsedInput.policyDecision.allowed)
      throw new ArtifactStoreError('scope-denied');

    const validation = await validateActivityCandidate(
      parsedInput.candidate,
      context.signal,
    );
    if (!validation.ok) {
      const code: SafeErrorCode =
        validation.reason === 'cancelled'
          ? 'cancelled'
          : validation.reason === 'limit-exceeded'
            ? 'limit-exceeded'
            : 'invalid-input';
      throw new ArtifactStoreError(code, validation.reason);
    }
    assertCurrentContext(context);

    try {
      const result = db.transaction((tx) => {
        const existingVersion = tx
          .select()
          .from(ArtifactVersionTable)
          .where(eq(ArtifactVersionTable.id, parsedInput.requestId))
          .get();
        if (existingVersion) {
          const existingArtifact = tx
            .select()
            .from(ArtifactTable)
            .where(
              and(
                eq(ArtifactTable.userId, context.userId),
                eq(ArtifactTable.id, existingVersion.artifactId),
              ),
            )
            .get();
          const decision = readStoredDecision(existingVersion.policyDecision);
          if (
            !existingArtifact ||
            existingArtifact.removedAt !== null ||
            existingVersion.userId !== context.userId ||
            !decision ||
            (parsedInput.artifactId !== undefined &&
              parsedInput.artifactId !== existingArtifact.id) ||
            decision.candidate.sessionId !== parsedInput.sessionId ||
            decision.candidate.turnId !== parsedInput.turnId ||
            decision.reasonCode !== parsedInput.policyDecision.reasonCode ||
            decision.revision !== parsedInput.policyDecision.revision
          )
            throw new ArtifactStoreError('revision-conflict');
          const existingContent = buildCandidateBytes(
            existingVersion,
            decision,
          );
          if (existingContent.contentDigest !== validation.contentDigest)
            throw new ArtifactStoreError('revision-conflict');
          const initialState = tx
            .select()
            .from(ArtifactStateTable)
            .where(
              and(
                eq(ArtifactStateTable.userId, context.userId),
                eq(ArtifactStateTable.artifactId, existingArtifact.id),
                eq(ArtifactStateTable.versionId, existingVersion.id),
                eq(
                  ArtifactStateTable.attemptId,
                  decision.candidate.initialAttemptId,
                ),
              ),
            )
            .get();
          const version = artifactVersionDto(
            existingArtifact.id,
            existingVersion,
            true,
          );
          if (!initialState || !version)
            throw new ArtifactStoreError('storage-failed');
          return { version, attemptId: initialState.attemptId };
        }

        const session = tx
          .select()
          .from(StudySessionTable)
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, parsedInput.sessionId),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .get();
        if (!session) throw new ArtifactStoreError('not-found');
        if (!isCurrentContext(context))
          throw new ArtifactStoreError('session-changed');
        const turn = tx
          .select()
          .from(StudyTurnTable)
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.sessionId, session.id),
              eq(StudyTurnTable.id, parsedInput.turnId),
            ),
          )
          .get();
        if (
          !turn ||
          turn.generationEpoch !== session.generationEpoch ||
          !['generating', 'checking'].includes(turn.status)
        )
          throw new ArtifactStoreError('session-changed');
        if (turn.policyRevision !== parsedInput.policyDecision.revision)
          throw new ArtifactStoreError('permission-revoked');
        if (
          parsedInput.candidate.sourceReferences.some(
            (reference) =>
              reference.state !== 'current' ||
              (reference.courseId !== null &&
                reference.courseId !== session.courseId),
          )
        )
          throw new ArtifactStoreError('scope-denied');

        let artifact = parsedInput.artifactId
          ? tx
              .select()
              .from(ArtifactTable)
              .where(
                and(
                  eq(ArtifactTable.userId, context.userId),
                  eq(ArtifactTable.id, parsedInput.artifactId),
                  eq(ArtifactTable.originatingSessionId, session.id),
                  eq(ArtifactTable.courseId, session.courseId),
                  isNull(ArtifactTable.removedAt),
                ),
              )
              .get()
          : undefined;
        if (parsedInput.artifactId && !artifact)
          throw new ArtifactStoreError('scope-denied');
        if (!artifact) {
          const artifactId = createId();
          const createdAt = now();
          tx.insert(ArtifactTable)
            .values({
              id: artifactId,
              userId: context.userId,
              courseId: session.courseId,
              currentVersionId: null,
              originatingSessionId: session.id,
              title: validation.candidate.title,
              objective: validation.candidate.objective,
              retained: false,
              revision: 0,
              removedAt: null,
              createdAt,
              updatedAt: createdAt,
            })
            .run();
          artifact = tx
            .select()
            .from(ArtifactTable)
            .where(eq(ArtifactTable.id, artifactId))
            .get();
        }
        if (!artifact) throw new ArtifactStoreError('storage-failed');

        const attemptId = createId();
        const createdAt = now();
        // The shared immutable-version table has no metadata columns for this payload.
        const decision: StoredArtifactDecision = {
          allowed: true,
          reasonCode: parsedInput.policyDecision.reasonCode,
          revision: parsedInput.policyDecision.revision,
          candidate: {
            title: validation.candidate.title,
            objective: validation.candidate.objective,
            accessibleExplanation: validation.candidate.accessibleExplanation,
            sessionId: session.id,
            turnId: turn.id,
            initialAttemptId: attemptId,
          },
        };
        tx.insert(ArtifactVersionTable)
          .values({
            id: parsedInput.requestId,
            artifactId: artifact.id,
            userId: context.userId,
            contentDigest: validation.contentDigest,
            html: validation.candidate.html,
            css: validation.candidate.css,
            javascript: validation.candidate.javascript,
            runtimeVersion: validation.candidate.runtimeVersion,
            sourceReferences: validation.candidate.sourceReferences,
            policyDecision: decision as unknown as JsonValue,
            createdAt,
          })
          .run();
        tx.insert(ArtifactStateTable)
          .values({
            id: createId(),
            userId: context.userId,
            artifactId: artifact.id,
            versionId: parsedInput.requestId,
            attemptId,
            stateRevision: 0,
            state: {},
            createdAt,
            updatedAt: createdAt,
          })
          .run();
        tx.update(ArtifactTable)
          .set({
            currentVersionId: parsedInput.requestId,
            title: validation.candidate.title,
            objective: validation.candidate.objective,
            revision: artifact.revision + 1,
            updatedAt: createdAt,
          })
          .where(
            and(
              eq(ArtifactTable.userId, context.userId),
              eq(ArtifactTable.id, artifact.id),
              isNull(ArtifactTable.removedAt),
            ),
          )
          .run();
        if (!isCurrentContext(context))
          throw new ArtifactStoreError('session-changed');
        const version = tx
          .select()
          .from(ArtifactVersionTable)
          .where(eq(ArtifactVersionTable.id, parsedInput.requestId))
          .get();
        const versionDto = version
          ? artifactVersionDto(artifact.id, version)
          : null;
        if (!versionDto) throw new ArtifactStoreError('storage-failed');
        return { version: versionDto, attemptId };
      });
      assertCurrentContext(context);
      return result;
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError('storage-failed');
    }
  };

  const checkpointArtifactState = async (
    context: AuthorizedContext,
    input: CheckpointArtifactStateInput,
  ): Promise<ArtifactStateDTO> => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new ArtifactStoreError('invalid-input');
    if (
      Object.keys(input).some(
        (key) =>
          !['runId', 'sequence', 'expectedRevision', 'state'].includes(key),
      )
    )
      throw new ArtifactStoreError('invalid-input');
    const runId = idSchema.safeParse(input?.runId);
    const sequence = input?.sequence;
    const expectedRevision = revisionSchema.safeParse(input?.expectedRevision);
    const parsedState = jsonValueSchema.safeParse(input?.state);
    if (
      !runId.success ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      !expectedRevision.success ||
      !parsedState.success
    )
      throw new ArtifactStoreError('invalid-input');
    let serializedState: string;
    try {
      serializedState = JSON.stringify(parsedState.data);
    } catch {
      throw new ArtifactStoreError('invalid-input');
    }
    if (Buffer.byteLength(serializedState, 'utf8') > activityStateByteLimit)
      throw new ArtifactStoreError('limit-exceeded');
    assertCurrentContext(context);
    const binding = activeRuns.get(runId.data);
    if (
      !binding ||
      binding.userId !== context.userId ||
      binding.accountEpoch !== context.epoch
    )
      throw new ArtifactStoreError('scope-denied');

    try {
      const checkpointResult = db.transaction((tx) => {
        if (!isCurrentContext(context))
          throw new ArtifactStoreError('session-changed');
        const session = tx
          .select()
          .from(StudySessionTable)
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, binding.sessionId),
              eq(StudySessionTable.courseId, binding.courseId),
              eq(
                StudySessionTable.generationEpoch,
                binding.sessionGenerationEpoch,
              ),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .get();
        const artifact = tx
          .select()
          .from(ArtifactTable)
          .where(
            and(
              eq(ArtifactTable.userId, context.userId),
              eq(ArtifactTable.id, binding.artifactId),
              eq(ArtifactTable.courseId, binding.courseId),
              isNull(ArtifactTable.removedAt),
            ),
          )
          .get();
        if (!session || !artifact)
          throw new ArtifactStoreError('session-changed');
        const stateRow = tx
          .select()
          .from(ArtifactStateTable)
          .where(
            and(
              eq(ArtifactStateTable.userId, context.userId),
              eq(ArtifactStateTable.artifactId, binding.artifactId),
              eq(ArtifactStateTable.versionId, binding.versionId),
              eq(ArtifactStateTable.attemptId, binding.attemptId),
            ),
          )
          .get();
        if (!stateRow) throw new ArtifactStoreError('not-found');
        const receipt = binding.latestCheckpointReceipt;
        if (receipt && sequence === receipt.sequence) {
          if (
            expectedRevision.data !== receipt.expectedRevision ||
            !isDeepStrictEqual(parsedState.data, receipt.state) ||
            stateRow.stateRevision !== receipt.dto.stateRevision ||
            !isDeepStrictEqual(stateRow.state, receipt.state)
          )
            throw new ArtifactStoreError('revision-conflict');
          if (!isCurrentContext(context))
            throw new ArtifactStoreError('session-changed');
          return { dto: structuredClone(receipt.dto), replayed: true };
        }
        if (receipt && sequence < receipt.sequence)
          throw new ArtifactStoreError('revision-conflict');
        if (stateRow.stateRevision !== expectedRevision.data)
          throw new ArtifactStoreError('revision-conflict');
        if (!isCurrentContext(context))
          throw new ArtifactStoreError('session-changed');
        const updatedAt = now();
        const update = tx
          .update(ArtifactStateTable)
          .set({
            state: parsedState.data,
            stateRevision: expectedRevision.data + 1,
            updatedAt,
          })
          .where(
            and(
              eq(ArtifactStateTable.userId, context.userId),
              eq(ArtifactStateTable.id, stateRow.id),
              eq(ArtifactStateTable.stateRevision, expectedRevision.data),
            ),
          )
          .run();
        if (update.changes !== 1)
          throw new ArtifactStoreError('revision-conflict');
        const persisted = tx
          .select()
          .from(ArtifactStateTable)
          .where(eq(ArtifactStateTable.id, stateRow.id))
          .get();
        const dto = persisted ? artifactStateDto(persisted) : null;
        if (!dto) throw new ArtifactStoreError('storage-failed');
        return { dto, replayed: false };
      });
      assertCurrentContext(context);
      if (!checkpointResult.replayed)
        binding.latestCheckpointReceipt = {
          sequence,
          expectedRevision: expectedRevision.data,
          state: structuredClone(parsedState.data),
          dto: structuredClone(checkpointResult.dto),
        };
      return checkpointResult.dto;
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError('storage-failed');
    }
  };

  const resetArtifactAttempt = async (
    context: AuthorizedContext,
    input: {
      artifactId: string;
      versionId: string;
      attemptId: string;
      requestId: string;
    },
  ): Promise<ArtifactStateDTO> => {
    const artifactId = idSchema.safeParse(input?.artifactId);
    const versionId = idSchema.safeParse(input?.versionId);
    const attemptId = idSchema.safeParse(input?.attemptId);
    const requestId = requestIdSchema.safeParse(input?.requestId);
    if (
      !artifactId.success ||
      !versionId.success ||
      !attemptId.success ||
      !requestId.success
    )
      throw new ArtifactStoreError('invalid-input');
    assertCurrentContext(context);
    try {
      const nextAttempt = db.transaction((tx) => {
        const artifact = tx
          .select()
          .from(ArtifactTable)
          .where(
            and(
              eq(ArtifactTable.userId, context.userId),
              eq(ArtifactTable.id, artifactId.data),
              isNull(ArtifactTable.removedAt),
            ),
          )
          .get();
        const version = tx
          .select()
          .from(ArtifactVersionTable)
          .where(
            and(
              eq(ArtifactVersionTable.userId, context.userId),
              eq(ArtifactVersionTable.artifactId, artifactId.data),
              eq(ArtifactVersionTable.id, versionId.data),
            ),
          )
          .get();
        const previousAttempt = tx
          .select()
          .from(ArtifactStateTable)
          .where(
            and(
              eq(ArtifactStateTable.userId, context.userId),
              eq(ArtifactStateTable.artifactId, artifactId.data),
              eq(ArtifactStateTable.versionId, versionId.data),
              eq(ArtifactStateTable.attemptId, attemptId.data),
            ),
          )
          .get();
        if (!artifact || !version || !previousAttempt)
          throw new ArtifactStoreError('not-found');
        const decision = readStoredDecision(version.policyDecision);
        if (!decision) throw new ArtifactStoreError('storage-failed');
        if (version.runtimeVersion !== 1)
          throw new ArtifactStoreError('unsupported');

        const repeatedAttempt = tx
          .select()
          .from(ArtifactStateTable)
          .where(
            and(
              eq(ArtifactStateTable.userId, context.userId),
              eq(ArtifactStateTable.artifactId, artifactId.data),
              eq(ArtifactStateTable.versionId, versionId.data),
              eq(ArtifactStateTable.attemptId, requestId.data),
            ),
          )
          .get();
        if (repeatedAttempt) {
          const dto = artifactStateDto(repeatedAttempt);
          if (!dto) throw new ArtifactStoreError('storage-failed');
          return dto;
        }

        const createdAt = now();
        tx.insert(ArtifactStateTable)
          .values({
            id: createId(),
            userId: context.userId,
            artifactId: artifactId.data,
            versionId: versionId.data,
            attemptId: requestId.data,
            stateRevision: 0,
            state: {},
            createdAt,
            updatedAt: createdAt,
          })
          .run();
        tx.update(ArtifactTable)
          .set({ revision: artifact.revision + 1, updatedAt: createdAt })
          .where(
            and(
              eq(ArtifactTable.userId, context.userId),
              eq(ArtifactTable.id, artifactId.data),
              isNull(ArtifactTable.removedAt),
            ),
          )
          .run();
        const inserted = tx
          .select()
          .from(ArtifactStateTable)
          .where(
            and(
              eq(ArtifactStateTable.userId, context.userId),
              eq(ArtifactStateTable.artifactId, artifactId.data),
              eq(ArtifactStateTable.versionId, versionId.data),
              eq(ArtifactStateTable.attemptId, requestId.data),
            ),
          )
          .get();
        const dto = inserted ? artifactStateDto(inserted) : null;
        if (!dto) throw new ArtifactStoreError('storage-failed');
        return dto;
      });
      for (const [runId, binding] of activeRuns) {
        if (
          binding.userId === context.userId &&
          binding.artifactId === artifactId.data &&
          binding.versionId === versionId.data &&
          binding.attemptId === attemptId.data
        )
          activeRuns.delete(runId);
      }
      assertCurrentContext(context);
      return nextAttempt;
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError('storage-failed');
    }
  };

  const saveArtifactToContext = async (
    context: AuthorizedContext,
    input: {
      artifactId: string;
      versionId: string;
      courseId?: string | null;
      requestId: string;
    },
  ): Promise<ContextItemDTO> => {
    const artifactId = idSchema.safeParse(input?.artifactId);
    const versionId = idSchema.safeParse(input?.versionId);
    const courseId =
      input?.courseId === undefined || input.courseId === null
        ? { success: true as const, data: input?.courseId ?? null }
        : idSchema.safeParse(input.courseId);
    const requestId = requestIdSchema.safeParse(input?.requestId);
    if (
      !artifactId.success ||
      !versionId.success ||
      !courseId.success ||
      !requestId.success
    )
      throw new ArtifactStoreError('invalid-input');
    assertCurrentContext(context);

    try {
      const savedItem = db.transaction((tx) => {
        const artifact = tx
          .select()
          .from(ArtifactTable)
          .where(
            and(
              eq(ArtifactTable.userId, context.userId),
              eq(ArtifactTable.id, artifactId.data),
              isNull(ArtifactTable.removedAt),
            ),
          )
          .get();
        const version = tx
          .select()
          .from(ArtifactVersionTable)
          .where(
            and(
              eq(ArtifactVersionTable.userId, context.userId),
              eq(ArtifactVersionTable.artifactId, artifactId.data),
              eq(ArtifactVersionTable.id, versionId.data),
            ),
          )
          .get();
        if (!artifact || !version) throw new ArtifactStoreError('not-found');
        const decision = readStoredDecision(version.policyDecision);
        if (!decision) throw new ArtifactStoreError('storage-failed');
        if (courseId.data !== null) {
          if (courseId.data !== artifact.courseId)
            throw new ArtifactStoreError('scope-denied');
          const course = tx
            .select({ id: CourseTable.id })
            .from(CourseTable)
            .where(
              and(
                eq(CourseTable.userId, context.userId),
                eq(CourseTable.id, courseId.data),
              ),
            )
            .get();
          if (!course) throw new ArtifactStoreError('scope-denied');
        }
        if (!isCurrentContext(context))
          throw new ArtifactStoreError('session-changed');

        const sourceKey = `activity:${artifact.id}:version:${version.id}`;
        let item = tx
          .select()
          .from(ContextItemTable)
          .where(
            and(
              eq(ContextItemTable.userId, context.userId),
              eq(ContextItemTable.originatingSourceId, sourceKey),
              isNull(ContextItemTable.removedAt),
            ),
          )
          .get();
        if (item) {
          const link = tx
            .select()
            .from(ContextLinkTable)
            .where(
              and(
                eq(ContextLinkTable.userId, context.userId),
                eq(ContextLinkTable.itemId, item.id),
                courseId.data === null
                  ? isNull(ContextLinkTable.courseId)
                  : eq(ContextLinkTable.courseId, courseId.data),
                isNull(ContextLinkTable.sessionId),
              ),
            )
            .get();
          if (!link) throw new ArtifactStoreError('scope-denied');
          const dto = toContextItemDto(
            item,
            courseId.data,
            artifact.id,
            version.id,
          );
          return dto;
        }

        const { candidate: storedCandidate, contentDigest } =
          buildCandidateBytes(version, decision);
        if (contentDigest !== version.contentDigest)
          throw new ArtifactStoreError('storage-failed');
        const sourceReferences = snapshotSourceReferences(
          version.sourceReferences,
        );
        const savedPayload = JSON.stringify({
          format: 'scholaros-activity-v1',
          artifactId: artifact.id,
          versionId: version.id,
          contentDigest: version.contentDigest,
          runtimeVersion: version.runtimeVersion,
          title: storedCandidate.title,
          objective: storedCandidate.objective,
          accessibleExplanation: storedCandidate.accessibleExplanation,
          sourceReferences,
        });
        const savedAt = now();
        const itemId = createId();
        const contextVersionId = createId();
        item = {
          id: itemId,
          userId: context.userId,
          title: storedCandidate.title,
          kind: 'activity',
          provenance: 'ai-generated',
          currentVersionId: contextVersionId,
          status: 'complete',
          revision: 0,
          removedAt: null,
          originatingSessionId: artifact.originatingSessionId,
          originatingSourceId: sourceKey,
          createdAt: savedAt,
          updatedAt: savedAt,
        };
        tx.insert(ContextItemTable).values(item).run();
        tx.insert(ContextVersionTable)
          .values({
            id: contextVersionId,
            userId: context.userId,
            itemId,
            attemptId: requestId.data,
            originalHash: version.contentDigest,
            contentHash: createHash('sha256')
              .update(savedPayload)
              .digest('hex'),
            mimeType: 'application/vnd.scholaros.activity+json',
            byteLength: Buffer.byteLength(savedPayload, 'utf8'),
            originalStorageKey: null,
            extractedText: savedPayload,
            extractionStatus: 'complete',
            uncertainty: null,
            pageCount: null,
            interpretedPages: [],
            locators: [],
            createdAt: savedAt,
          })
          .run();
        tx.insert(ContextLinkTable)
          .values({
            id: createId(),
            userId: context.userId,
            itemId,
            courseId: courseId.data,
            sessionId: null,
            retainedInLibrary: true,
            createdAt: savedAt,
          })
          .run();
        tx.update(ArtifactTable)
          .set({
            retained: true,
            revision: artifact.revision + 1,
            updatedAt: savedAt,
          })
          .where(
            and(
              eq(ArtifactTable.userId, context.userId),
              eq(ArtifactTable.id, artifact.id),
              isNull(ArtifactTable.removedAt),
            ),
          )
          .run();
        if (!isCurrentContext(context))
          throw new ArtifactStoreError('session-changed');
        return toContextItemDto(item, courseId.data, artifact.id, version.id);
      });
      assertCurrentContext(context);
      return savedItem;
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError('storage-failed');
    }
  };

  const authorizeActivityRun = async (
    context: AuthorizedContext,
    input: AuthorizeActivityRunInput,
  ): Promise<AuthorizedActivityRun> => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new ArtifactStoreError('invalid-input');
    if (
      Object.keys(input).some(
        (key) =>
          ![
            'sessionId',
            'artifactId',
            'versionId',
            'attemptId',
            'requestId',
          ].includes(key),
      )
    )
      throw new ArtifactStoreError('invalid-input');
    const sessionId = idSchema.safeParse(input?.sessionId);
    const artifactId = idSchema.safeParse(input?.artifactId);
    const versionId = idSchema.safeParse(input?.versionId);
    const attemptId = idSchema.safeParse(input?.attemptId);
    const requestId = requestIdSchema.safeParse(input?.requestId);
    if (
      !sessionId.success ||
      !artifactId.success ||
      !versionId.success ||
      !attemptId.success ||
      !requestId.success
    )
      throw new ArtifactStoreError('invalid-input');
    assertCurrentContext(context);

    const authorizationReplay = [...activeRuns.entries()].find(
      ([, binding]) =>
        binding.userId === context.userId &&
        binding.accountEpoch === context.epoch &&
        binding.requestId === requestId.data,
    );
    if (authorizationReplay) {
      const [runId, binding] = authorizationReplay;
      if (
        binding.sessionId !== sessionId.data ||
        binding.artifactId !== artifactId.data ||
        binding.versionId !== versionId.data ||
        binding.attemptId !== attemptId.data
      )
        throw new ArtifactStoreError('revision-conflict');

      try {
        const replayStatus = db.transaction((tx) => {
          const session = tx
            .select()
            .from(StudySessionTable)
            .where(
              and(
                eq(StudySessionTable.userId, context.userId),
                eq(StudySessionTable.id, binding.sessionId),
                eq(StudySessionTable.courseId, binding.courseId),
                eq(
                  StudySessionTable.generationEpoch,
                  binding.sessionGenerationEpoch,
                ),
                isNull(StudySessionTable.deletedAt),
              ),
            )
            .get();
          const artifact = tx
            .select()
            .from(ArtifactTable)
            .where(
              and(
                eq(ArtifactTable.userId, context.userId),
                eq(ArtifactTable.id, binding.artifactId),
                eq(ArtifactTable.courseId, binding.courseId),
                isNull(ArtifactTable.removedAt),
              ),
            )
            .get();
          const version = tx
            .select()
            .from(ArtifactVersionTable)
            .where(
              and(
                eq(ArtifactVersionTable.userId, context.userId),
                eq(ArtifactVersionTable.artifactId, binding.artifactId),
                eq(ArtifactVersionTable.id, binding.versionId),
              ),
            )
            .get();
          const state = tx
            .select()
            .from(ArtifactStateTable)
            .where(
              and(
                eq(ArtifactStateTable.userId, context.userId),
                eq(ArtifactStateTable.artifactId, binding.artifactId),
                eq(ArtifactStateTable.versionId, binding.versionId),
                eq(ArtifactStateTable.attemptId, binding.attemptId),
              ),
            )
            .get();
          if (!session || !artifact || !version || !state) return 'stale';
          return version.runtimeVersion === 1 ? 'current' : 'unsupported';
        });
        if (replayStatus === 'stale') {
          activeRuns.delete(runId);
          throw new ArtifactStoreError('session-changed');
        }
        if (replayStatus === 'unsupported')
          throw new ArtifactStoreError('unsupported');
        assertCurrentContext(context);
        return structuredClone(binding.authorization);
      } catch (error) {
        if (error instanceof ArtifactStoreError) throw error;
        throw new ArtifactStoreError('storage-failed');
      }
    }

    for (const [runId, binding] of activeRuns) {
      if (
        binding.userId === context.userId &&
        binding.sessionId === sessionId.data &&
        binding.artifactId === artifactId.data &&
        binding.versionId === versionId.data &&
        binding.attemptId === attemptId.data
      )
        activeRuns.delete(runId);
    }
    if (activeRuns.size >= 64) throw new ArtifactStoreError('busy');

    try {
      const authorizedRun = db.transaction((tx) => {
        const session = tx
          .select()
          .from(StudySessionTable)
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, sessionId.data),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .get();
        const artifact = tx
          .select()
          .from(ArtifactTable)
          .where(
            and(
              eq(ArtifactTable.userId, context.userId),
              eq(ArtifactTable.id, artifactId.data),
              isNull(ArtifactTable.removedAt),
            ),
          )
          .get();
        const version = tx
          .select()
          .from(ArtifactVersionTable)
          .where(
            and(
              eq(ArtifactVersionTable.userId, context.userId),
              eq(ArtifactVersionTable.artifactId, artifactId.data),
              eq(ArtifactVersionTable.id, versionId.data),
            ),
          )
          .get();
        const stateRow = tx
          .select()
          .from(ArtifactStateTable)
          .where(
            and(
              eq(ArtifactStateTable.userId, context.userId),
              eq(ArtifactStateTable.artifactId, artifactId.data),
              eq(ArtifactStateTable.versionId, versionId.data),
              eq(ArtifactStateTable.attemptId, attemptId.data),
            ),
          )
          .get();
        if (!session || !artifact || !version || !stateRow)
          throw new ArtifactStoreError('not-found');
        if (artifact.courseId !== session.courseId)
          throw new ArtifactStoreError('scope-denied');
        if (version.runtimeVersion !== 1)
          throw new ArtifactStoreError('unsupported');
        const decision = readStoredDecision(version.policyDecision);
        if (!decision) throw new ArtifactStoreError('storage-failed');
        if (
          decision.candidate.sessionId !== sessionId.data &&
          !artifact.retained
        )
          throw new ArtifactStoreError('scope-denied');
        const content = buildCandidateBytes(version, decision);
        if (content.contentDigest !== version.contentDigest)
          throw new ArtifactStoreError('storage-failed');
        if (!isCurrentContext(context))
          throw new ArtifactStoreError('session-changed');

        const runId = createId();
        const state = artifactStateDto(stateRow);
        if (!state) throw new ArtifactStoreError('storage-failed');
        const bundle = {
          title: content.candidate.title,
          objective: content.candidate.objective,
          html: version.html,
          css: version.css,
          javascript: version.javascript,
          accessibleExplanation: content.candidate.accessibleExplanation,
          runtimeVersion: version.runtimeVersion,
        };
        const bundleByteLength = Buffer.byteLength(
          JSON.stringify(bundle),
          'utf8',
        );
        if (bundleByteLength > acceptedActivityBundleByteLimit)
          throw new ArtifactStoreError('limit-exceeded');
        return {
          runId,
          sessionId: session.id,
          artifactId: artifact.id,
          versionId: version.id,
          attemptId: stateRow.attemptId,
          contentDigest: version.contentDigest,
          bundle,
          sourceReferences: snapshotSourceReferences(version.sourceReferences),
          digestSourceReferences: version.sourceReferences,
          state,
          courseId: session.courseId,
          sessionGenerationEpoch: session.generationEpoch,
        };
      });
      assertCurrentContext(context);
      const {
        courseId: _courseId,
        sessionGenerationEpoch: _generationEpoch,
        ...result
      } = authorizedRun;
      activeRuns.set(authorizedRun.runId, {
        userId: context.userId,
        accountEpoch: context.epoch,
        sessionId: authorizedRun.sessionId,
        sessionGenerationEpoch: authorizedRun.sessionGenerationEpoch,
        courseId: authorizedRun.courseId,
        artifactId: authorizedRun.artifactId,
        versionId: authorizedRun.versionId,
        attemptId: authorizedRun.attemptId,
        requestId: requestId.data,
        authorization: result,
      });
      context.signal.addEventListener(
        'abort',
        () => activeRuns.delete(authorizedRun.runId),
        { once: true },
      );
      return structuredClone(result);
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError('storage-failed');
    }
  };

  const releaseActivityRun = (input: ReleaseActivityRunInput) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    if (Object.keys(input).some((key) => !['runId', 'requestId'].includes(key)))
      return;

    const parsedRunId =
      input.runId === undefined ? undefined : idSchema.safeParse(input.runId);
    const parsedRequestId =
      input.requestId === undefined
        ? undefined
        : requestIdSchema.safeParse(input.requestId);
    if (
      (parsedRunId !== undefined && !parsedRunId.success) ||
      (parsedRequestId !== undefined && !parsedRequestId.success) ||
      (parsedRunId === undefined && parsedRequestId === undefined)
    )
      return;

    if (parsedRunId?.success) {
      const binding = activeRuns.get(parsedRunId.data);
      if (
        binding &&
        (parsedRequestId === undefined ||
          (parsedRequestId.success &&
            binding.requestId === parsedRequestId.data))
      )
        activeRuns.delete(parsedRunId.data);
      return;
    }

    if (!parsedRequestId?.success) return;
    let matchingRunId: string | undefined;
    for (const [runId, binding] of activeRuns) {
      if (binding.requestId !== parsedRequestId.data) continue;
      if (matchingRunId !== undefined) return;
      matchingRunId = runId;
    }
    if (matchingRunId !== undefined) activeRuns.delete(matchingRunId);
  };

  const dispose = () => activeRuns.clear();

  return {
    getArtifactVersion,
    getArtifactState,
    createArtifactVersion,
    checkpointArtifactState,
    resetArtifactAttempt,
    saveArtifactToContext,
    authorizeActivityRun,
    releaseActivityRun,
    dispose,
  };
};

export type ArtifactStore = ReturnType<typeof createArtifactStore>;
