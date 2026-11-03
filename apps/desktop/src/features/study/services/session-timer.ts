import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { BetterSQLiteTransaction } from 'drizzle-orm/better-sqlite3';
import {
  idSchema,
  requestIdSchema,
  revisionSchema,
  type AuthorizedContext,
  type ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import {
  studySessionSchema,
  studyTimerSchema,
  type StudySessionDTO,
  type StudyTimerDTO,
} from '@scholaros/services/learning/study-contracts';
import { z } from 'zod';
import { db } from '../../../db';
import * as schema from '../../../db/schema';
import { StudyMessageTable, StudySessionTable } from '../../../db/schema';
import {
  StudySessionError,
  createStudySessionEvent,
  publishStudySessionEvent,
} from './session-events';

const expirySummaryLabel =
  'Your study time is up. Choose how you want to continue.';
const clockAnomalyLabel =
  'The device clock moved backward; your saved deadline was not changed.';

type TimerDatabase = typeof db;
type TimerTransaction = BetterSQLiteTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
type TimerOptions = {
  database?: TimerDatabase;
  now?: () => number;
  publish?: (event: ProductEventV1) => void;
};

type TimerCommandInput = {
  sessionId: string;
  requestId: string;
  expectedTimerRevision: number;
};

type TimerCommandMarker = {
  id: string;
  operation: 'finish' | 'extend' | 'continue';
  digest: string;
};

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const stableId = (value: string) => {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const toIso = (milliseconds: number) => {
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime()))
    throw new StudySessionError(
      'invalid-input',
      'The device clock is unavailable.',
    );
  return date.toISOString();
};

const toTimerDTO = (
  session: typeof StudySessionTable.$inferSelect,
): StudyTimerDTO =>
  studyTimerSchema.parse({
    deadlineAt: session.deadlineAt,
    revision: session.timerRevision,
    expiredRevision: session.expiredRevision,
    resolvedExpiredRevision: session.resolvedExpiredRevision,
    finishedAt: session.finishedAt,
  });

const toStudySessionDTO = (
  session: typeof StudySessionTable.$inferSelect,
): StudySessionDTO =>
  studySessionSchema.parse({
    id: session.id,
    courseId: session.courseId,
    title: session.title,
    activity: session.activity,
    targetAssignmentId: session.targetAssignmentId,
    topic: session.topic,
    status: session.status,
    revision: session.revision,
    generationEpoch: session.generationEpoch,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastOpenedAt: session.lastOpenedAt,
    draft: { text: session.draftText, revision: session.draftRevision },
    timer: toTimerDTO(session),
  });

const messageSequence = (
  transaction: TimerTransaction,
  userId: string,
  sessionId: string,
) => {
  const latestMessage = transaction
    .select({ sequence: StudyMessageTable.sequence })
    .from(StudyMessageTable)
    .where(
      and(
        eq(StudyMessageTable.userId, userId),
        eq(StudyMessageTable.sessionId, sessionId),
      ),
    )
    .orderBy(desc(StudyMessageTable.sequence))
    .limit(1)
    .get();
  return (latestMessage?.sequence ?? -1) + 1;
};

const insertTimerStatus = (
  transaction: TimerTransaction,
  input: {
    userId: string;
    sessionId: string;
    now: string;
    id: string;
    code: string;
    label: string;
  },
) => {
  const existingStudyMessage = transaction
    .select({ id: StudyMessageTable.id })
    .from(StudyMessageTable)
    .where(
      and(
        eq(StudyMessageTable.userId, input.userId),
        eq(StudyMessageTable.sessionId, input.sessionId),
        eq(StudyMessageTable.id, input.id),
      ),
    )
    .get();
  if (existingStudyMessage) return false;

  transaction
    .insert(StudyMessageTable)
    .values({
      id: input.id,
      userId: input.userId,
      sessionId: input.sessionId,
      sequence: messageSequence(transaction, input.userId, input.sessionId),
      turnId: null,
      role: 'system-status',
      status: 'accepted',
      parts: [{ kind: 'status', code: input.code, label: input.label }],
      gradeDerived: false,
      gradeConsentRevision: null,
      createdAt: input.now,
    })
    .run();
  return true;
};

const timerCommandDigest = (
  operation: TimerCommandMarker['operation'],
  payload: unknown,
) => sha256(JSON.stringify([operation, payload]));

const timerCommandMarker = (
  userId: string,
  input: TimerCommandInput,
  operation: TimerCommandMarker['operation'],
  payload: unknown,
): TimerCommandMarker => ({
  id: stableId(
    `study-timer-command\0${userId}\0${input.sessionId}\0${input.requestId}`,
  ),
  operation,
  digest: timerCommandDigest(operation, payload),
});

const readSession = (
  transaction: TimerTransaction,
  context: AuthorizedContext,
  sessionId: string,
) =>
  transaction
    .select()
    .from(StudySessionTable)
    .where(
      and(
        eq(StudySessionTable.userId, context.userId),
        eq(StudySessionTable.id, sessionId),
        isNull(StudySessionTable.deletedAt),
      ),
    )
    .get();

const publishChange = (
  publish: TimerOptions['publish'],
  context: AuthorizedContext,
  sessionId: string,
  revision: number,
  operationId?: string,
  outcome?: ProductEventV1['outcome'],
) => {
  if (!publish) return;
  const event = createStudySessionEvent(context, {
    revision,
    sessionId,
    ...(operationId ? { operationId } : {}),
    ...(outcome ? { outcome } : {}),
  });
  publishStudySessionEvent(publish, event);
};

const getTimerCommandReplay = (
  transaction: TimerTransaction,
  userId: string,
  sessionId: string,
  marker: TimerCommandMarker,
) => {
  const existingStudyMessage = transaction
    .select()
    .from(StudyMessageTable)
    .where(
      and(
        eq(StudyMessageTable.userId, userId),
        eq(StudyMessageTable.sessionId, sessionId),
        eq(StudyMessageTable.id, marker.id),
      ),
    )
    .get();
  if (!existingStudyMessage) return false;

  const [part] = existingStudyMessage.parts;
  if (
    part?.kind !== 'status' ||
    part.code !== `study-timer-command:${marker.operation}:${marker.digest}`
  )
    throw new StudySessionError(
      'revision-conflict',
      'This timer request ID was already used for a different action.',
    );
  return true;
};

const timerCommandInputSchema = z.strictObject({
  sessionId: idSchema,
  requestId: requestIdSchema,
  expectedTimerRevision: revisionSchema,
});
const extendStudyTimerInputSchema = z.strictObject({
  sessionId: idSchema,
  requestId: requestIdSchema,
  expectedTimerRevision: revisionSchema,
  durationMinutes: z.number().int().min(1).max(240),
});

export const createStudyTimer = ({
  database = db,
  now = Date.now,
  publish,
}: TimerOptions = {}) => {
  const reconcileStudyDeadline = async (
    context: AuthorizedContext,
    rawInput: { sessionId: string },
  ): Promise<StudyTimerDTO> => {
    const parsedInput = z
      .strictObject({ sessionId: idSchema })
      .safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError('invalid-input', 'Invalid study session.');
    if (!context.isCurrent() || context.signal.aborted)
      throw new StudySessionError(
        'session-changed',
        'Your account session changed.',
      );

    try {
      const result = database.transaction((transaction) => {
        const existingStudySession = readSession(
          transaction,
          context,
          parsedInput.data.sessionId,
        );
        if (!existingStudySession)
          throw new StudySessionError('not-found', 'Study session not found.');

        const nowMs = now();
        const nowIso = toIso(nowMs);
        const deadlineMs = existingStudySession.deadlineAt
          ? Date.parse(existingStudySession.deadlineAt)
          : null;
        const backwards = nowMs < Date.parse(existingStudySession.updatedAt);
        let changed = false;
        let updatedStudySession = existingStudySession;

        if (backwards) {
          const anomalyId = stableId(
            `study-clock-anomaly\0${context.userId}\0${existingStudySession.id}\0${existingStudySession.timerRevision}`,
          );
          const insertedAnomaly = insertTimerStatus(transaction, {
            userId: context.userId,
            sessionId: existingStudySession.id,
            now: nowIso,
            id: anomalyId,
            code: `study-clock-anomaly:${existingStudySession.timerRevision}`,
            label: clockAnomalyLabel,
          });
          changed ||= insertedAnomaly;
        }

        const expired =
          deadlineMs !== null &&
          Number.isFinite(deadlineMs) &&
          deadlineMs <= nowMs;
        if (
          expired &&
          existingStudySession.expiredRevision !==
            existingStudySession.timerRevision
        ) {
          const expiryId = stableId(
            `study-timer-expired\0${context.userId}\0${existingStudySession.id}\0${existingStudySession.timerRevision}`,
          );
          insertTimerStatus(transaction, {
            userId: context.userId,
            sessionId: existingStudySession.id,
            now: nowIso,
            id: expiryId,
            code: `study-timer-expired:${existingStudySession.timerRevision}`,
            label: expirySummaryLabel,
          });
          updatedStudySession = transaction
            .update(StudySessionTable)
            .set({
              expiredRevision: existingStudySession.timerRevision,
              revision: existingStudySession.revision + 1,
              updatedAt: nowIso,
            })
            .where(
              and(
                eq(StudySessionTable.userId, context.userId),
                eq(StudySessionTable.id, existingStudySession.id),
                eq(
                  StudySessionTable.generationEpoch,
                  existingStudySession.generationEpoch,
                ),
                isNull(StudySessionTable.deletedAt),
              ),
            )
            .returning()
            .get()!;
          changed = true;
        } else if (changed) {
          updatedStudySession = transaction
            .update(StudySessionTable)
            .set({
              revision: existingStudySession.revision + 1,
              updatedAt: nowIso,
            })
            .where(
              and(
                eq(StudySessionTable.userId, context.userId),
                eq(StudySessionTable.id, existingStudySession.id),
                eq(
                  StudySessionTable.generationEpoch,
                  existingStudySession.generationEpoch,
                ),
                isNull(StudySessionTable.deletedAt),
              ),
            )
            .returning()
            .get()!;
        }

        return {
          timer: toTimerDTO(updatedStudySession),
          revision: updatedStudySession.revision,
          changed,
          expired,
          sessionId: updatedStudySession.id,
          timerRevision: updatedStudySession.timerRevision,
        };
      });
      if (!context.isCurrent() || context.signal.aborted)
        throw new StudySessionError(
          'session-changed',
          'Your account session changed.',
        );
      if (result.changed)
        publishChange(
          publish,
          context,
          result.sessionId,
          result.revision,
          `study-timer-${result.sessionId}-${result.timerRevision}`,
          result.expired ? 'completed' : 'attention',
        );
      return result.timer;
    } catch (error) {
      if (error instanceof StudySessionError) throw error;
      throw new StudySessionError(
        'storage-failed',
        'The study timer could not be read.',
      );
    }
  };

  const finishStudySession = async (
    context: AuthorizedContext,
    rawInput: TimerCommandInput,
  ): Promise<StudySessionDTO> => {
    const parsedInput = timerCommandInputSchema.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError('invalid-input', 'Invalid timer action.');
    if (!context.isCurrent() || context.signal.aborted)
      throw new StudySessionError(
        'session-changed',
        'Your account session changed.',
      );
    const marker = timerCommandMarker(
      context.userId,
      parsedInput.data,
      'finish',
      parsedInput.data.expectedTimerRevision,
    );

    try {
      const result = database.transaction((transaction) => {
        const existingStudySession = readSession(
          transaction,
          context,
          parsedInput.data.sessionId,
        );
        if (!existingStudySession)
          throw new StudySessionError('not-found', 'Study session not found.');
        if (
          getTimerCommandReplay(
            transaction,
            context.userId,
            existingStudySession.id,
            marker,
          )
        )
          return { session: existingStudySession, changed: false };
        if (existingStudySession.finishedAt)
          return { session: existingStudySession, changed: false };
        if (
          existingStudySession.timerRevision !==
          parsedInput.data.expectedTimerRevision
        )
          throw new StudySessionError(
            'revision-conflict',
            'The study timer changed.',
          );

        const nowIso = toIso(now());
        const updatedStudySession = transaction
          .update(StudySessionTable)
          .set({
            status: 'finished',
            finishedAt: nowIso,
            timerRevision: existingStudySession.timerRevision + 1,
            resolvedExpiredRevision:
              existingStudySession.expiredRevision ??
              existingStudySession.resolvedExpiredRevision,
            revision: existingStudySession.revision + 1,
            updatedAt: nowIso,
          })
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, existingStudySession.id),
              eq(
                StudySessionTable.timerRevision,
                parsedInput.data.expectedTimerRevision,
              ),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!updatedStudySession)
          throw new StudySessionError(
            'revision-conflict',
            'The study timer changed.',
          );
        insertTimerStatus(transaction, {
          userId: context.userId,
          sessionId: updatedStudySession.id,
          now: nowIso,
          id: marker.id,
          code: `study-timer-command:${marker.operation}:${marker.digest}`,
          label: 'Study session finished.',
        });
        return { session: updatedStudySession, changed: true };
      });
      if (!context.isCurrent() || context.signal.aborted)
        throw new StudySessionError(
          'session-changed',
          'Your account session changed.',
        );
      if (result.changed)
        publishChange(
          publish,
          context,
          result.session.id,
          result.session.revision,
          parsedInput.data.requestId,
          'completed',
        );
      return toStudySessionDTO(result.session);
    } catch (error) {
      if (error instanceof StudySessionError) throw error;
      throw new StudySessionError(
        'storage-failed',
        'The study session could not be finished.',
      );
    }
  };

  const extendStudySession = async (
    context: AuthorizedContext,
    rawInput: TimerCommandInput & { durationMinutes: number },
  ): Promise<StudyTimerDTO> => {
    const parsedInput = extendStudyTimerInputSchema.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError('invalid-input', 'Invalid timer action.');
    if (!context.isCurrent() || context.signal.aborted)
      throw new StudySessionError(
        'session-changed',
        'Your account session changed.',
      );
    const marker = timerCommandMarker(
      context.userId,
      parsedInput.data,
      'extend',
      [
        parsedInput.data.expectedTimerRevision,
        parsedInput.data.durationMinutes,
      ],
    );

    try {
      const result = database.transaction((transaction) => {
        const existingStudySession = readSession(
          transaction,
          context,
          parsedInput.data.sessionId,
        );
        if (!existingStudySession)
          throw new StudySessionError('not-found', 'Study session not found.');
        if (
          getTimerCommandReplay(
            transaction,
            context.userId,
            existingStudySession.id,
            marker,
          )
        )
          return {
            timer: toTimerDTO(existingStudySession),
            revision: existingStudySession.revision,
            changed: false,
            sessionId: existingStudySession.id,
          };
        if (existingStudySession.finishedAt)
          throw new StudySessionError(
            'revision-conflict',
            'A finished session cannot be extended.',
          );
        if (
          existingStudySession.timerRevision !==
          parsedInput.data.expectedTimerRevision
        )
          throw new StudySessionError(
            'revision-conflict',
            'The study timer changed.',
          );

        const nowMs = now();
        const nowIso = toIso(nowMs);
        const oldDeadlineMs = existingStudySession.deadlineAt
          ? Date.parse(existingStudySession.deadlineAt)
          : null;
        const baseDeadlineMs =
          oldDeadlineMs !== null &&
          Number.isFinite(oldDeadlineMs) &&
          oldDeadlineMs > nowMs
            ? oldDeadlineMs
            : nowMs;
        const updatedStudySession = transaction
          .update(StudySessionTable)
          .set({
            deadlineAt: toIso(
              baseDeadlineMs + parsedInput.data.durationMinutes * 60_000,
            ),
            timerRevision: existingStudySession.timerRevision + 1,
            resolvedExpiredRevision:
              existingStudySession.expiredRevision ??
              existingStudySession.resolvedExpiredRevision,
            revision: existingStudySession.revision + 1,
            updatedAt: nowIso,
          })
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, existingStudySession.id),
              eq(
                StudySessionTable.timerRevision,
                parsedInput.data.expectedTimerRevision,
              ),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!updatedStudySession)
          throw new StudySessionError(
            'revision-conflict',
            'The study timer changed.',
          );
        insertTimerStatus(transaction, {
          userId: context.userId,
          sessionId: updatedStudySession.id,
          now: nowIso,
          id: marker.id,
          code: `study-timer-command:${marker.operation}:${marker.digest}`,
          label: 'Study time extended.',
        });
        return {
          timer: toTimerDTO(updatedStudySession),
          revision: updatedStudySession.revision,
          changed: true,
          sessionId: updatedStudySession.id,
        };
      });
      if (!context.isCurrent() || context.signal.aborted)
        throw new StudySessionError(
          'session-changed',
          'Your account session changed.',
        );
      if (result.changed)
        publishChange(
          publish,
          context,
          result.sessionId,
          result.revision,
          parsedInput.data.requestId,
        );
      return result.timer;
    } catch (error) {
      if (error instanceof StudySessionError) throw error;
      throw new StudySessionError(
        'storage-failed',
        'The study timer could not be extended.',
      );
    }
  };

  const continueStudyUntimed = async (
    context: AuthorizedContext,
    rawInput: TimerCommandInput,
  ): Promise<StudyTimerDTO> => {
    const parsedInput = timerCommandInputSchema.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError('invalid-input', 'Invalid timer action.');
    if (!context.isCurrent() || context.signal.aborted)
      throw new StudySessionError(
        'session-changed',
        'Your account session changed.',
      );
    const marker = timerCommandMarker(
      context.userId,
      parsedInput.data,
      'continue',
      parsedInput.data.expectedTimerRevision,
    );

    try {
      const result = database.transaction((transaction) => {
        const existingStudySession = readSession(
          transaction,
          context,
          parsedInput.data.sessionId,
        );
        if (!existingStudySession)
          throw new StudySessionError('not-found', 'Study session not found.');
        if (
          getTimerCommandReplay(
            transaction,
            context.userId,
            existingStudySession.id,
            marker,
          )
        )
          return {
            timer: toTimerDTO(existingStudySession),
            revision: existingStudySession.revision,
            changed: false,
            sessionId: existingStudySession.id,
          };
        if (existingStudySession.finishedAt)
          throw new StudySessionError(
            'revision-conflict',
            'A finished session cannot continue.',
          );
        if (
          existingStudySession.timerRevision !==
          parsedInput.data.expectedTimerRevision
        )
          throw new StudySessionError(
            'revision-conflict',
            'The study timer changed.',
          );

        const nowIso = toIso(now());
        const updatedStudySession = transaction
          .update(StudySessionTable)
          .set({
            deadlineAt: null,
            timerRevision: existingStudySession.timerRevision + 1,
            resolvedExpiredRevision:
              existingStudySession.expiredRevision ??
              existingStudySession.resolvedExpiredRevision,
            revision: existingStudySession.revision + 1,
            updatedAt: nowIso,
          })
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, existingStudySession.id),
              eq(
                StudySessionTable.timerRevision,
                parsedInput.data.expectedTimerRevision,
              ),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!updatedStudySession)
          throw new StudySessionError(
            'revision-conflict',
            'The study timer changed.',
          );
        insertTimerStatus(transaction, {
          userId: context.userId,
          sessionId: updatedStudySession.id,
          now: nowIso,
          id: marker.id,
          code: `study-timer-command:${marker.operation}:${marker.digest}`,
          label: 'Study session will continue without a timer.',
        });
        return {
          timer: toTimerDTO(updatedStudySession),
          revision: updatedStudySession.revision,
          changed: true,
          sessionId: updatedStudySession.id,
        };
      });
      if (!context.isCurrent() || context.signal.aborted)
        throw new StudySessionError(
          'session-changed',
          'Your account session changed.',
        );
      if (result.changed)
        publishChange(
          publish,
          context,
          result.sessionId,
          result.revision,
          parsedInput.data.requestId,
        );
      return result.timer;
    } catch (error) {
      if (error instanceof StudySessionError) throw error;
      throw new StudySessionError(
        'storage-failed',
        'The study timer could not be updated.',
      );
    }
  };

  const reconcileDueStudyDeadlines = async (
    context: AuthorizedContext,
    limit = 100,
  ): Promise<number> => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new StudySessionError(
        'invalid-input',
        'Invalid timer reconciliation limit.',
      );
    if (!context.isCurrent() || context.signal.aborted)
      throw new StudySessionError(
        'session-changed',
        'Your account session changed.',
      );
    try {
      const nowIso = toIso(now());
      const dueSessions = database
        .select({ id: StudySessionTable.id })
        .from(StudySessionTable)
        .where(
          and(
            eq(StudySessionTable.userId, context.userId),
            isNull(StudySessionTable.deletedAt),
            isNull(StudySessionTable.finishedAt),
            lte(StudySessionTable.deadlineAt, nowIso),
            sql`${StudySessionTable.expiredRevision} is null or ${StudySessionTable.expiredRevision} <> ${StudySessionTable.timerRevision}`,
          ),
        )
        .orderBy(StudySessionTable.deadlineAt)
        .limit(limit)
        .all();
      for (const session of dueSessions)
        await reconcileStudyDeadline(context, { sessionId: session.id });
      return dueSessions.length;
    } catch (error) {
      if (error instanceof StudySessionError) throw error;
      throw new StudySessionError(
        'storage-failed',
        'Expired study sessions could not be reconciled.',
      );
    }
  };

  return {
    reconcileStudyDeadline,
    finishStudySession,
    extendStudySession,
    continueStudyUntimed,
    reconcileDueStudyDeadlines,
  };
};

const defaultTimer = createStudyTimer();

export const reconcileStudyDeadline = defaultTimer.reconcileStudyDeadline;
export const finishStudySession = defaultTimer.finishStudySession;
export const extendStudySession = defaultTimer.extendStudySession;
export const continueStudyUntimed = defaultTimer.continueStudyUntimed;
export const reconcileDueStudyDeadlines =
  defaultTimer.reconcileDueStudyDeadlines;
