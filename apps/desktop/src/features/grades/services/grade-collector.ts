import { createHash } from 'node:crypto';
import type { Page } from '@browserbasehq/stagehand';
import { academicTasks } from '../../onboarding/services/academic-tasks';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import { createMissionNavigator } from '../../onboarding/services/mission-navigation';
import { getWorkspace } from '../../onboarding/services/browser-workspace';
import { readPage } from '../../onboarding/services/page-content';
import type {
  EvidenceTriState,
  ObservedGrade,
} from '@scholaros/services/learning/grade-contracts';
import { instantSchema } from '@scholaros/services/learning/product-contracts';
import type {
  AuthorizedContext,
  Id,
} from '@scholaros/services/learning/product-contracts';
import { locatorSchema } from '@scholaros/services/learning/context-contracts';
import type { Locator } from '@scholaros/services/learning/context-contracts';

const maxGradePageCharacters = 20_000;
const maxFeedbackCharacters = 8_000;

export type GradeSourceRecord = {
  assignmentId: Id;
  assignmentIdentity: string;
  courseId: Id;
  connectionId: Id | null;
  connectionHost: string | null;
  assignmentUrl: string | null;
  assignmentTitle: string;
  courseTitle: string;
  sourceVersion: string;
  eligible: boolean;
  suppressed: boolean;
  policyRevision: number;
};

export type GradeObservation = {
  sourceUrl: string;
  sourceTitle: string;
  observedAt: string;
  grade: ObservedGrade | null;
  completion: EvidenceTriState;
  remainingOpportunity: EvidenceTriState;
  feedback: string | null;
  conflicts: string[];
  contentDigest: string;
  locators: {
    grade: Locator | null;
    completion: Locator | null;
    opportunity: Locator | null;
    feedback: Locator | null;
  };
};

type GradePageSnapshot = {
  url: string;
  title: string;
  text: string;
  observedAt: string;
  truncated?: boolean;
};

type GradeValue = {
  grade: ObservedGrade;
  locator: Locator;
};

type OpportunityFacts = {
  submission: EvidenceTriState;
  resubmission: EvidenceTriState;
  retake: EvidenceTriState;
  aggregate: EvidenceTriState;
  observed: boolean;
  conflict: boolean;
};

const normalizeLine = (line: string) => line.replace(/\s+/g, ' ').trim();

const labelValue = (line: string, labels: RegExp) => {
  const match = line.match(labels);
  return match?.[1]?.trim() ?? null;
};

const parseObservedGrade = (value: string): ObservedGrade | null => {
  const normalized = normalizeLine(value).replace(/[.]+$/, '');
  if (
    !normalized ||
    /^(?:--|—|n\/a|not graded|ungraded|pending)$/i.test(normalized)
  )
    return null;
  const points = normalized.match(
    /^(-?\d+(?:\.\d+)?)\s*(?:\/|out of|of)\s*(-?\d+(?:\.\d+)?)(?:\s*(?:points?|pts?))?$/i,
  );
  if (points) {
    const earned = Number(points[1]);
    const possible = Number(points[2]);
    if (Number.isFinite(earned) && Number.isFinite(possible))
      return { scale: 'points', earned, possible };
  }
  const percentage = normalized.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (percentage) {
    const earned = Number(percentage[1]);
    if (Number.isFinite(earned)) return { scale: 'percentage', earned };
  }
  if (/^pass$/i.test(normalized)) return { scale: 'pass-fail', value: 'pass' };
  if (/^fail(?:ed)?$/i.test(normalized))
    return { scale: 'pass-fail', value: 'fail' };
  if (/^[a-f][+-]?$/i.test(normalized))
    return { scale: 'letter', value: normalized.toUpperCase() };
  return normalized.length <= 100
    ? { scale: 'other', value: normalized }
    : null;
};

const readGradeValues = (lines: string[]) => {
  const values: GradeValue[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const value = labelValue(
      line,
      /^(?:(?:current|final|earned|official)\s+)?(?:grade|score|result)\s*[:-]?\s*(.*)$/i,
    );
    if (value === null) continue;
    const candidate = value || lines[index + 1] || '';
    const grade = parseObservedGrade(candidate);
    if (!grade) continue;
    const label = line.match(/^[^:-]+/)?.[0]?.trim() || 'Grade';
    values.push({
      grade,
      locator: { kind: 'heading', heading: label.slice(0, 300) },
    });
  }
  return values;
};

const parseCompletion = (lines: string[]) => {
  const facts: EvidenceTriState[] = [];
  for (const line of lines) {
    const value = labelValue(
      line,
      /^(?:(?:assignment|coursework|work)\s+status|completion(?:\s+status)?|status)\s*[:-]\s*(.*)$/i,
    );
    const candidate =
      value ??
      (/^(?:completed|reopened|re-opened|incomplete|in progress)$/i.test(line)
        ? line
        : null);
    if (!candidate) continue;
    if (
      /^(?:re-?opened|incomplete|in progress|open|not completed)$/i.test(
        candidate,
      )
    )
      facts.push('no');
    else if (/^(?:complete|completed)$/i.test(candidate)) facts.push('yes');
  }
  const distinct = [...new Set(facts)];
  return {
    value: distinct.length === 1 ? distinct[0]! : 'unknown',
    conflict: distinct.length > 1,
    observed: distinct.length > 0,
  };
};

const availabilityValue = (value: string): EvidenceTriState => {
  if (/^(?:no|none|0|closed|disabled|not allowed|unavailable)$/i.test(value))
    return 'no';
  if (/^(?:yes|open|enabled|allowed|available|unlimited)$/i.test(value))
    return 'yes';
  const number = value.match(/^(\d+)\s*(?:remaining|available)?$/i);
  if (number) return Number(number[1]) > 0 ? 'yes' : 'no';
  return 'unknown';
};

const readOpportunityFacts = (lines: string[]): OpportunityFacts => {
  const facts: OpportunityFacts = {
    submission: 'unknown',
    resubmission: 'unknown',
    retake: 'unknown',
    aggregate: 'unknown',
    observed: false,
    conflict: false,
  };
  const saveFact = (
    field: keyof Pick<
      OpportunityFacts,
      'submission' | 'resubmission' | 'retake' | 'aggregate'
    >,
    value: EvidenceTriState,
  ) => {
    facts.observed = true;
    const existing = facts[field];
    if (existing !== 'unknown' && value !== 'unknown' && existing !== value)
      facts.conflict = true;
    if (value !== 'unknown') facts[field] = value;
  };
  for (const line of lines) {
    const aggregate = line.match(
      /^(?:opportunity|submission availability|attempt availability)\s*[:-]\s*(.*)$/i,
    )?.[1];
    if (
      aggregate &&
      /^(?:no further|no remaining|none remaining).*(?:submission|resubmission|retake|attempt)/i.test(
        aggregate,
      )
    )
      saveFact('aggregate', 'no');
    else if (
      aggregate &&
      /(?:more|remaining|available|allowed).*(?:submission|resubmission|retake|attempt)/i.test(
        aggregate,
      )
    )
      saveFact('aggregate', 'yes');

    const remaining = line.match(
      /^(?:(submissions?|resubmissions?|retakes?|attempts?)\s+remaining|remaining\s+(submissions?|resubmissions?|retakes?|attempts?))\s*[:-]\s*(.*)$/i,
    );
    if (remaining) {
      const kind = `${remaining[1] ?? ''} ${remaining[2] ?? ''}`.toLowerCase();
      const value = availabilityValue(remaining[3] ?? '');
      if (kind.includes('resubmission')) saveFact('resubmission', value);
      else if (kind.includes('retake') || kind.includes('attempt'))
        saveFact('retake', value);
      else saveFact('submission', value);
    }

    const opportunity = line.match(
      /^(?:submission|resubmission|retake|attempt)\s+(?:opportunity|available|allowed)\s*[:-]\s*(.*)$/i,
    );
    if (opportunity) {
      const value = availabilityValue(opportunity[1] ?? '');
      if (/^resubmission/i.test(line)) saveFact('resubmission', value);
      else if (/^(?:retake|attempt)/i.test(line)) saveFact('retake', value);
      else saveFact('submission', value);
    }
  }
  return facts;
};

const remainingOpportunityFrom = (facts: OpportunityFacts) => {
  const dimensions = [facts.submission, facts.resubmission, facts.retake];
  const hasOpen = dimensions.includes('yes') || facts.aggregate === 'yes';
  const everyOpportunityClosed = dimensions.every((fact) => fact === 'no');
  if (
    facts.conflict ||
    (hasOpen && (facts.aggregate === 'no' || everyOpportunityClosed))
  )
    return { value: 'unknown' as const, conflict: true };
  if (hasOpen) return { value: 'yes' as const, conflict: false };
  if (facts.aggregate === 'no' || everyOpportunityClosed)
    return { value: 'no' as const, conflict: false };
  return { value: 'unknown' as const, conflict: false };
};

const readFeedback = (lines: string[]) => {
  const index = lines.findIndex((line) =>
    /^(?:teacher\s+)?(?:instructor\s+)?feedback\s*[:-]?/i.test(line),
  );
  if (index < 0) return { value: null, locator: null };
  const firstLine = lines[index]!.replace(
    /^(?:teacher\s+)?(?:instructor\s+)?feedback\s*[:-]?\s*/i,
    '',
  );
  const followingLines: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (
      /^(?:grade|score|result|status|completion|submission|resubmission|retake|attempts? remaining|remaining attempts)\b/i.test(
        line,
      )
    )
      break;
    followingLines.push(line);
  }
  const content = [firstLine, ...followingLines]
    .filter(Boolean)
    .join('\n')
    .trim()
    .slice(0, maxFeedbackCharacters);
  return {
    value: content || null,
    locator: { kind: 'heading' as const, heading: 'Feedback' },
  };
};

const gradeIdentity = (grade: ObservedGrade) => JSON.stringify(grade);

export const parseGradePage = (
  snapshot: GradePageSnapshot,
): GradeObservation => {
  const source = new URL(snapshot.url);
  if (!['http:', 'https:'].includes(source.protocol))
    throw new Error('Grade evidence must come from a protected web page.');
  if (!instantSchema.safeParse(snapshot.observedAt).success)
    throw new Error('Grade observation time is invalid.');
  const lines = snapshot.text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const gradeValues = readGradeValues(lines);
  const uniqueGrades = [
    ...new Map(
      gradeValues.map((item) => [gradeIdentity(item.grade), item]),
    ).values(),
  ];
  const completion = parseCompletion(lines);
  const opportunityFacts = readOpportunityFacts(lines);
  const opportunity = remainingOpportunityFrom(opportunityFacts);
  const feedback = readFeedback(lines);
  const truncated = snapshot.truncated === true;
  const conflicts = [
    ...(uniqueGrades.length > 1 ? ['multiple-grades'] : []),
    ...(completion.conflict ? ['completion-conflict'] : []),
    ...(opportunity.conflict ? ['opportunity-conflict'] : []),
    ...(truncated ? ['source-observation-truncated'] : []),
  ];
  const grade =
    !truncated && uniqueGrades.length === 1 ? uniqueGrades[0]!.grade : null;
  const completionValue =
    truncated || completion.conflict ? 'unknown' : completion.value;
  const opportunityValue =
    truncated || opportunity.conflict ? 'unknown' : opportunity.value;
  const gradeLocator =
    !truncated && uniqueGrades.length === 1 ? uniqueGrades[0]!.locator : null;
  const feedbackValue = truncated ? null : feedback.value;
  const contentDigest = createHash('sha256')
    .update(`${source.href}\n${snapshot.text}`)
    .digest('hex');
  const locators = {
    grade: gradeLocator,
    completion: completion.observed
      ? { kind: 'heading' as const, heading: 'Completion status' }
      : null,
    opportunity: opportunityFacts.observed
      ? { kind: 'heading' as const, heading: 'Submission availability' }
      : null,
    feedback: feedbackValue ? feedback.locator : null,
  };
  for (const locator of Object.values(locators))
    if (locator && !locatorSchema.safeParse(locator).success)
      throw new Error('Grade evidence locator is invalid.');
  return {
    sourceUrl: source.href,
    sourceTitle: snapshot.title.slice(0, 300),
    observedAt: snapshot.observedAt,
    grade,
    completion: completionValue,
    remainingOpportunity: opportunityValue,
    feedback: feedbackValue,
    conflicts,
    contentDigest,
    locators,
  };
};

const collectPage = async (
  context: AuthorizedContext,
  source: GradeSourceRecord,
  signal: AbortSignal,
): Promise<GradeObservation> => {
  signal.throwIfAborted();
  if (!context.isCurrent())
    throw new Error('Your session changed; sign in again.');
  if (!source.eligible || source.suppressed)
    throw new Error(
      'This assignment is not currently eligible for grade verification.',
    );
  if (!source.connectionHost || !source.assignmentUrl || !source.connectionId)
    throw new Error('The assignment has no eligible academic connection.');
  const sourceIdentity = academicPageIdentity(source.assignmentUrl);
  if (
    !sourceIdentity ||
    !isReadNavigation(source.assignmentUrl, [source.connectionHost])
  )
    throw new Error(
      'The assignment source is outside the authorized course connection.',
    );
  const workspace = await getWorkspace(
    context.userId,
    () => context.isCurrent() && !signal.aborted,
  );
  if (workspace.userId !== context.userId)
    throw new Error('The academic browser belongs to another account.');
  const page: Page = await workspace.browser.context.newPage();
  try {
    const isCurrent = () => context.isCurrent() && !signal.aborted;
    const navigate = createMissionNavigator(
      () => workspace.browser.context,
      [source.connectionHost],
      signal,
      isCurrent,
      { scopeId: `grade:${source.courseId}:${source.assignmentId}` },
    );
    await navigate(page, source.assignmentUrl);
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    const pageSnapshot = await readPage(page);
    if (pageSnapshot.password)
      throw new Error('This academic connection needs you to sign in again.');
    if (academicPageIdentity(pageSnapshot.url) !== sourceIdentity)
      throw new Error(
        'The observed grade page did not match the assignment source.',
      );
    const visible = await page.evaluate((maxCharacters: number) => {
      const text = document.body?.innerText ?? '';
      return {
        url: location.href,
        title: document.title,
        text: text.slice(0, maxCharacters),
        truncated: text.length > maxCharacters,
      };
    }, maxGradePageCharacters);
    if (academicPageIdentity(visible.url) !== sourceIdentity)
      throw new Error(
        'The academic browser navigated away from the observed assignment.',
      );
    return parseGradePage({
      ...visible,
      observedAt: new Date().toISOString(),
    });
  } finally {
    await page.close().catch(() => undefined);
  }
};

export const collectGradeObservation = (
  context: AuthorizedContext,
  source: GradeSourceRecord,
  signal: AbortSignal,
) =>
  academicTasks.run(
    context.userId,
    (taskSignal) => collectPage(context, source, taskSignal),
    signal,
    `grades:${source.courseId}:${source.assignmentId}`,
    { exclusive: true },
  );
