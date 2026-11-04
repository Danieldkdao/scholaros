import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContextItemDTO } from '@scholaros/services/learning/context-contracts';
import {
  createStudySessionInputSchema,
  studyActivities,
} from '@scholaros/services/learning/study-contracts';
import type {
  StudyActivity,
  StudySessionDTO,
} from '@scholaros/services/learning/study-contracts';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@scholaros/ui/components/combobox';
import { Alert, AlertDescription } from '@scholaros/ui/components/alert';
import { Button } from '@scholaros/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@scholaros/ui/components/dialog';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { Checkbox } from '@scholaros/ui/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@scholaros/ui/components/field';
import { Input } from '@scholaros/ui/components/input';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@scholaros/ui/components/select';
import { Textarea } from '@scholaros/ui/components/textarea';
import { BookOpen, CircleAlert, Loader2, Plus } from 'lucide-react';
import type { CourseDetail, CourseSummary } from '../../courses/types';
import { useCourses } from '../../courses/hooks/use-courses';
import { formatCollectionState } from '../../courses/lib/formatters';
import { errorMessage } from '../../../lib/error-message';
import { getStudyApi } from '../hooks/use-study-history';
import { formatStudyActivity } from '../lib/formatters';

export type StudySetupPrefill = {
  activity?: StudyActivity;
  courseId?: string;
  targetAssignmentId?: string;
  topic?: string;
  contextItemIds?: string[];
};

const durationChoices = ['15', '25', '45', 'custom', 'untimed'] as const;

type DurationChoice = (typeof durationChoices)[number];

export type StudySetupProps = {
  accountId: string;
  initialSetup?: StudySetupPrefill;
  offline?: boolean;
  onStarted?: (session: StudySessionDTO) => void | Promise<void>;
};

const formatDurationChoice = (choice: DurationChoice) => {
  switch (choice) {
    case '15':
      return '15 minutes';
    case '25':
      return '25 minutes';
    case '45':
      return '45 minutes';
    case 'custom':
      return 'Custom duration';
    case 'untimed':
      return 'Untimed';
    default: {
      const exhaustive: never = choice;
      return exhaustive;
    }
  }
};

const toPrefillKey = (prefill: StudySetupPrefill | undefined) =>
  JSON.stringify(prefill ?? null);

const courseSearchLabel = (course: CourseSummary) =>
  [course.name, course.code, course.term, course.sourceName]
    .filter(Boolean)
    .join(' ');

const isStudyActivity = (value: unknown): value is StudyActivity =>
  typeof value === 'string' && studyActivities.includes(value as StudyActivity);

const asDurationChoice = (value: unknown): DurationChoice | null =>
  typeof value === 'string' && durationChoices.includes(value as DurationChoice)
    ? (value as DurationChoice)
    : null;

const getDurationMinutes = (choice: DurationChoice, customValue: string) => {
  if (choice === 'untimed') return null;
  if (choice === 'custom') {
    const parsed = Number(customValue);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 240
      ? parsed
      : Number.NaN;
  }
  return Number(choice);
};

const contextItemsForCourse = (items: ContextItemDTO[], courseId: string) =>
  items
    .filter(
      (item) =>
        item.usable &&
        !item.source?.removed &&
        (item.courseIds.length === 0 || item.courseIds.includes(courseId)),
    )
    .sort((left, right) =>
      left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }),
    );

export const StudySetup = ({
  accountId,
  initialSetup,
  offline = false,
  onStarted,
}: StudySetupProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const {
    snapshot,
    loading: coursesLoading,
    loadError: coursesError,
    reload: reloadCourses,
  } = useCourses(accountId);
  const [activity, setActivity] = useState<StudyActivity | null>(null);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [targetAssignmentId, setTargetAssignmentId] = useState<string | null>(
    null,
  );
  const [topic, setTopic] = useState('');
  const [selectedContextItemIds, setSelectedContextItemIds] = useState<
    string[]
  >([]);
  const [durationChoice, setDurationChoice] = useState<DurationChoice>('25');
  const [customDuration, setCustomDuration] = useState('30');
  const [courseDetail, setCourseDetail] = useState<CourseDetail | null>(null);
  const [courseDetailLoading, setCourseDetailLoading] = useState(false);
  const [courseDetailError, setCourseDetailError] = useState<string | null>(
    null,
  );
  const [contextItems, setContextItems] = useState<ContextItemDTO[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [materialSearch, setMaterialSearch] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [prefillNotice, setPrefillNotice] = useState<string | null>(null);
  const prefillKey = toPrefillKey(initialSetup);
  const lastPrefillKey = useRef<string | null>(null);
  const userChangedCourse = useRef(false);
  const courseRequest = useRef(0);
  const contextRequest = useRef(0);
  const createRequestIds = useRef(new Map<string, string>());
  const createdSession = useRef<{
    fingerprint: string;
    session: StudySessionDTO;
  } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (lastPrefillKey.current === prefillKey) return;
    lastPrefillKey.current = prefillKey;
    if (Object.keys(initialSetup ?? {}).length > 0) setDialogOpen(true);
    userChangedCourse.current = false;
    setActivity(
      isStudyActivity(initialSetup?.activity) ? initialSetup.activity : null,
    );
    setSelectedCourseId(initialSetup?.courseId ?? null);
    setTargetAssignmentId(initialSetup?.targetAssignmentId ?? null);
    setTopic(
      typeof initialSetup?.topic === 'string'
        ? initialSetup.topic.slice(0, 1000)
        : '',
    );
    setSelectedContextItemIds(
      Array.isArray(initialSetup?.contextItemIds)
        ? [
            ...new Set(
              initialSetup.contextItemIds.filter(
                (id) => typeof id === 'string',
              ),
            ),
          ].slice(0, 20)
        : [],
    );
    setPrefillNotice(null);
    setFieldErrors({});
    setSubmitError(null);
    createRequestIds.current.clear();
    createdSession.current = null;
  }, [initialSetup, prefillKey]);

  const courses = snapshot?.courses ?? [];
  const selectedCourse =
    courses.find((course) => course.id === selectedCourseId) ?? null;
  const courseIsStale =
    Boolean(selectedCourseId) &&
    !coursesLoading &&
    (!selectedCourse || selectedCourse.sourceState === 'removed');
  const assignments = (courseDetail?.assignments ?? []).filter(
    (assignment) => assignment.active,
  );
  const selectedTargetFound = Boolean(
    targetAssignmentId &&
    assignments.some((assignment) => assignment.id === targetAssignmentId),
  );
  const selectedTargetIsStale = Boolean(
    targetAssignmentId && courseDetail && !selectedTargetFound,
  );
  const selectedTargetNeedsVerification = Boolean(
    targetAssignmentId && !selectedTargetFound,
  );
  const materials = useMemo(
    () =>
      selectedCourseId
        ? contextItemsForCourse(contextItems, selectedCourseId)
        : [],
    [contextItems, selectedCourseId],
  );
  const visibleMaterials = useMemo(() => {
    const search = materialSearch.trim().toLowerCase();
    return search
      ? materials.filter((item) => item.title.toLowerCase().includes(search))
      : materials;
  }, [materialSearch, materials]);
  const durationMinutes = getDurationMinutes(durationChoice, customDuration);
  const durationIsInvalid =
    typeof durationMinutes === 'number' && !Number.isFinite(durationMinutes);
  const activityItems = studyActivities.map((item) => ({
    value: item,
    label: formatStudyActivity(item).label,
  }));
  const assignmentItems = [
    { value: '__none__', label: 'No specific assignment' },
    ...assignments.map((item) => ({ value: item.id, label: item.title })),
    ...(selectedTargetIsStale
      ? [
          {
            value: targetAssignmentId as string,
            label: 'Recommended assignment unavailable',
          },
        ]
      : []),
    ...(selectedTargetNeedsVerification && !courseDetail
      ? [
          {
            value: targetAssignmentId as string,
            label: 'Verifying recommended assignment',
          },
        ]
      : []),
  ];

  useEffect(() => {
    const attempt = ++courseRequest.current;
    setCourseDetail(null);
    setCourseDetailError(null);
    if (!accountId || !selectedCourseId || !selectedCourse || courseIsStale) {
      setCourseDetailLoading(false);
      return;
    }
    setCourseDetailLoading(true);
    void window.scholar
      .getCourse(selectedCourseId)
      .then((loaded) => {
        if (attempt !== courseRequest.current) return;
        if (!loaded) {
          setCourseDetailError(
            'Course details are unavailable. You can start without a target, but no assignment can be selected.',
          );
          return;
        }
        setCourseDetail(loaded);
      })
      .catch((cause) => {
        if (attempt === courseRequest.current)
          setCourseDetailError(
            errorMessage(cause, 'Could not verify this course’s assignments.'),
          );
      })
      .finally(() => {
        if (attempt === courseRequest.current) setCourseDetailLoading(false);
      });
    return () => {
      courseRequest.current += 1;
    };
  }, [accountId, courseIsStale, selectedCourse, selectedCourseId]);

  const prefill = useMemo(
    () => JSON.parse(prefillKey) as StudySetupPrefill | null,
    [prefillKey],
  );

  useEffect(() => {
    const attempt = ++contextRequest.current;
    setContextItems([]);
    setContextError(null);
    if (!accountId || !selectedCourseId || courseIsStale) {
      setContextLoading(false);
      return;
    }
    setContextLoading(true);
    void Promise.all([
      getStudyApi().listContextItems({ courseId: selectedCourseId, limit: 50 }),
      getStudyApi().listContextItems({ courseId: null, limit: 50 }),
    ])
      .then(async ([coursePage, personalPage]) => {
        if (attempt !== contextRequest.current) return;
        if (!coursePage || !personalPage) {
          setContextError(
            'Saved materials could not be checked. You can continue without adding materials.',
          );
          setSelectedContextItemIds([]);
          return;
        }
        const listed = new Map(
          [...coursePage.items, ...personalPage.items].map((item) => [
            item.id,
            item,
          ]),
        );
        const prefillMatchesCourse =
          !userChangedCourse.current && prefill?.courseId === selectedCourseId;
        const prefillIds = prefillMatchesCourse
          ? (prefill?.contextItemIds ?? [])
          : [];
        const missingIds = prefillIds.filter((itemId) => !listed.has(itemId));
        const verifiedPrefill = await Promise.all(
          missingIds.map(async (itemId) => {
            const result = await getStudyApi()
              .getContextItem({ itemId })
              .catch(() => null);
            const item = result?.item;
            return item &&
              item.usable &&
              !item.source?.removed &&
              (item.courseIds.length === 0 ||
                item.courseIds.includes(selectedCourseId))
              ? item
              : null;
          }),
        );
        if (attempt !== contextRequest.current) return;
        for (const item of verifiedPrefill) if (item) listed.set(item.id, item);
        const allowed = contextItemsForCourse(
          [...listed.values()],
          selectedCourseId,
        );
        const allowedIds = new Set(allowed.map((item) => item.id));
        const invalidPrefill = prefillIds.some(
          (itemId) => !allowedIds.has(itemId),
        );
        setContextItems(allowed);
        if (invalidPrefill) {
          setSelectedContextItemIds(
            prefillIds.filter((itemId) => allowedIds.has(itemId)),
          );
          setPrefillNotice(
            'Some recommended materials are no longer available for this course and were removed from the selection.',
          );
        }
      })
      .catch((cause) => {
        if (attempt === contextRequest.current) {
          setContextError(
            errorMessage(cause, 'Could not load saved study materials.'),
          );
          if (
            !userChangedCourse.current &&
            prefill?.courseId === selectedCourseId &&
            prefill.contextItemIds?.length
          ) {
            setSelectedContextItemIds([]);
            setPrefillNotice(
              'Recommended materials could not be verified and were removed from the selection.',
            );
          }
        }
      })
      .finally(() => {
        if (attempt === contextRequest.current) setContextLoading(false);
      });
    return () => {
      contextRequest.current += 1;
    };
  }, [accountId, courseIsStale, prefill, selectedCourseId]);

  const toggleMaterial = useCallback(
    (itemId: string, checked: boolean | 'indeterminate') => {
      setSelectedContextItemIds((current) => {
        if (checked === true) {
          if (current.includes(itemId) || current.length >= 20) return current;
          return [...current, itemId];
        }
        return current.filter((id) => id !== itemId);
      });
      setSubmitError(null);
    },
    [],
  );

  const start = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitError(null);
    const errors: Record<string, string> = {};
    if (!activity) errors.activity = 'Choose a study activity.';
    if (!selectedCourseId || courseIsStale)
      errors.course = 'Choose a current course.';
    if (selectedTargetNeedsVerification)
      errors.target = selectedTargetIsStale
        ? 'Choose an assignment that belongs to this course, or clear the target.'
        : 'Wait for this assignment to be verified or clear the target.';
    if (durationIsInvalid)
      errors.duration = 'Choose a duration from 1 to 240 minutes.';
    if (offline)
      errors.offline = 'Reconnect to start or change a study session.';
    setFieldErrors(errors);
    if (
      Object.keys(errors).length ||
      !activity ||
      !selectedCourseId ||
      durationIsInvalid
    )
      return;

    const contextIds = selectedContextItemIds.filter((itemId) =>
      materials.some((item) => item.id === itemId),
    );
    const payload = {
      courseId: selectedCourseId,
      activity,
      ...(targetAssignmentId ? { targetAssignmentId } : {}),
      ...(topic.trim() ? { topic: topic.trim() } : {}),
      contextItemIds: contextIds,
      durationMinutes,
    };
    const fingerprint = JSON.stringify(payload);
    if (createdSession.current?.fingerprint === fingerprint) {
      setSubmitting(true);
      try {
        await onStarted?.(createdSession.current.session);
        if (mounted.current) setDialogOpen(false);
      } catch {
        if (mounted.current)
          setSubmitError(
            'Your session is saved, but could not be opened. Resume it from study history.',
          );
      } finally {
        if (mounted.current) setSubmitting(false);
      }
      return;
    }
    const requestId =
      createRequestIds.current.get(fingerprint) ?? crypto.randomUUID();
    createRequestIds.current.set(fingerprint, requestId);
    const parsed = createStudySessionInputSchema.safeParse({
      requestId,
      ...payload,
    });
    if (!parsed.success) {
      setSubmitError('Check the study setup fields and try again.');
      return;
    }

    setSubmitting(true);
    try {
      const created = await getStudyApi().createStudySession(parsed.data);
      if (!mounted.current) return;
      createRequestIds.current.delete(fingerprint);
      createdSession.current = { fingerprint, session: created };
      try {
        await onStarted?.(created);
        if (mounted.current) setDialogOpen(false);
      } catch {
        if (mounted.current)
          setSubmitError(
            'Your session is saved, but could not be opened. Resume it from study history.',
          );
      }
    } catch (cause) {
      if (mounted.current)
        setSubmitError(
          errorMessage(
            cause,
            'Could not start this study session. Your setup is still here.',
          ),
        );
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };

  const chooseCourse = (course: CourseSummary | null) => {
    userChangedCourse.current = true;
    setSelectedCourseId(course?.id ?? null);
    setTargetAssignmentId(null);
    setSelectedContextItemIds([]);
    setFieldErrors({});
    setSubmitError(null);
    setPrefillNotice(null);
  };

  const chooseActivity = (value: unknown) => {
    if (!isStudyActivity(value)) return;
    setActivity(value);
    setFieldErrors((current) => ({ ...current, activity: '' }));
    setSubmitError(null);
  };

  const chooseDuration = (value: unknown) => {
    const choice = asDurationChoice(value);
    if (!choice) return;
    setDurationChoice(choice);
    setFieldErrors((current) => ({ ...current, duration: '' }));
    setSubmitError(null);
  };

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => {
        if (!submitting) setDialogOpen(open);
      }}
    >
      <TooltipWrapper content="Start a study session">
        <DialogTrigger
          render={
            <Button
              type="button"
              size="icon"
              aria-label="Start a study session"
            />
          }
        >
          <Plus aria-hidden="true" />
        </DialogTrigger>
      </TooltipWrapper>
      <DialogContent className="sm:max-w-2xl" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle>Start a study session</DialogTitle>
          <DialogDescription>
            Choose one activity, one course, and how long you would like to
            focus.
          </DialogDescription>
        </DialogHeader>
        {offline && (
          <Alert>
            <CircleAlert aria-hidden="true" />
            <AlertDescription>
              Offline history is read-only. Reconnect to start or change a study
              session.
            </AlertDescription>
          </Alert>
        )}
        {coursesError && (
          <Alert>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              {coursesError}
              <Button variant="outline" onClick={() => void reloadCourses()}>
                Retry courses
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {!coursesLoading && !coursesError && courses.length === 0 && (
          <Alert>
            <AlertDescription>
              No courses are available yet. Add or sync a course before starting
              a study session.
            </AlertDescription>
          </Alert>
        )}
        <form
          className="flex flex-col gap-6"
          noValidate
          onSubmit={(event) => void start(event)}
        >
          <FieldGroup>
            <Field>
              <FieldLabel id="study-activity-label" htmlFor="study-activity">
                Activity
              </FieldLabel>
              <Select
                value={activity}
                onValueChange={chooseActivity}
                items={activityItems}
              >
                <SelectTrigger
                  id="study-activity"
                  className="w-full"
                  aria-label="Study activity"
                  aria-labelledby="study-activity-label"
                  aria-invalid={Boolean(fieldErrors.activity)}
                  aria-describedby={
                    fieldErrors.activity ? 'study-activity-error' : undefined
                  }
                  disabled={offline || submitting}
                >
                  <SelectValue>
                    {activity
                      ? formatStudyActivity(activity).label
                      : 'Choose one activity'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {studyActivities.map((item) => {
                    const formatted = formatStudyActivity(item);
                    return (
                      <SelectItem key={item} value={item}>
                        <formatted.Icon aria-hidden="true" />
                        {formatted.label}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <FieldError id="study-activity-error">
                {fieldErrors.activity}
              </FieldError>
            </Field>

            <Field>
              <FieldLabel htmlFor="study-course">Course</FieldLabel>
              <Combobox<CourseSummary>
                items={courses}
                value={selectedCourse}
                onValueChange={chooseCourse}
                itemToStringLabel={courseSearchLabel}
                isItemEqualToValue={(item, value) => item.id === value.id}
              >
                <ComboboxInput
                  id="study-course"
                  aria-label="Course"
                  aria-invalid={Boolean(fieldErrors.course || courseIsStale)}
                  aria-describedby={
                    fieldErrors.course || courseIsStale
                      ? 'study-course-error'
                      : undefined
                  }
                  placeholder={
                    coursesLoading
                      ? 'Loading courses…'
                      : 'Search and choose one course'
                  }
                  className="w-full [&_input]:text-base"
                  disabled={
                    offline ||
                    submitting ||
                    coursesLoading ||
                    courses.length === 0
                  }
                />
                <ComboboxContent>
                  <ComboboxEmpty>No courses match your search.</ComboboxEmpty>
                  <ComboboxList>
                    {(item: CourseSummary) => (
                      <ComboboxItem key={item.id} value={item} className="py-2">
                        <span className="flex min-w-0 flex-col gap-1">
                          <span className="truncate">{item.name}</span>
                          <span className="truncate text-muted-foreground">
                            {[item.code, item.term, item.sourceName]
                              .filter(Boolean)
                              .join('  ')}
                          </span>
                        </span>
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              {courseIsStale && (
                <FieldError id="study-course-error">
                  That course is no longer available. Select a current course to
                  continue.
                </FieldError>
              )}
              {!courseIsStale && fieldErrors.course && (
                <FieldError id="study-course-error">
                  {fieldErrors.course}
                </FieldError>
              )}
            </Field>

            {activity === 'review-graded-mistakes' && (
              <Alert>
                <CircleAlert aria-hidden="true" />
                <AlertDescription>
                  <span>
                    Reviewing graded mistakes requires current connected-source
                    verification.
                  </span>{' '}
                  <span>
                    Choosing this activity does not grant permission to view
                    grades or answers.
                  </span>
                </AlertDescription>
              </Alert>
            )}

            {selectedCourse && !courseIsStale && (
              <>
                {formatCollectionState(
                  'assignments',
                  selectedCourse.assignmentsStatus,
                  selectedCourse.assignmentCount,
                ) && (
                  <Alert>
                    <CircleAlert aria-hidden="true" />
                    <AlertDescription>
                      {formatCollectionState(
                        'assignments',
                        selectedCourse.assignmentsStatus,
                        selectedCourse.assignmentCount,
                      )}{' '}
                      Verify requirements in the connected source before relying
                      on them.
                    </AlertDescription>
                  </Alert>
                )}
                <Field>
                  <FieldLabel id="study-target-label">
                    Target assignment or source (optional)
                  </FieldLabel>
                  <Select
                    value={targetAssignmentId ?? '__none__'}
                    onValueChange={(value) => {
                      setTargetAssignmentId(
                        value === '__none__' || typeof value !== 'string'
                          ? null
                          : value,
                      );
                      setFieldErrors((current) => ({
                        ...current,
                        target: '',
                      }));
                    }}
                    items={assignmentItems}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="Target assignment"
                      aria-labelledby="study-target-label"
                      aria-invalid={Boolean(
                        fieldErrors.target || selectedTargetIsStale,
                      )}
                      aria-describedby={
                        fieldErrors.target || selectedTargetIsStale
                          ? 'study-target-error'
                          : undefined
                      }
                      disabled={offline || submitting || courseDetailLoading}
                    >
                      <SelectValue>
                        {targetAssignmentId
                          ? (assignments.find(
                              (item) => item.id === targetAssignmentId,
                            )?.title ?? 'Assignment unavailable')
                          : 'No specific assignment'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">
                        No specific assignment
                      </SelectItem>
                      {assignments.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.title}
                        </SelectItem>
                      ))}
                      {selectedTargetIsStale && targetAssignmentId && (
                        <SelectItem value={targetAssignmentId} disabled>
                          Recommended assignment unavailable
                        </SelectItem>
                      )}
                      {selectedTargetNeedsVerification &&
                        !courseDetail &&
                        targetAssignmentId && (
                          <SelectItem value={targetAssignmentId} disabled>
                            Verifying recommended assignment
                          </SelectItem>
                        )}
                    </SelectContent>
                  </Select>
                  {courseDetailError && (
                    <FieldDescription>{courseDetailError}</FieldDescription>
                  )}
                  {selectedTargetIsStale && (
                    <FieldError id="study-target-error">
                      The recommended assignment is no longer available in this
                      course. Choose another target or clear it.
                    </FieldError>
                  )}
                  {selectedTargetNeedsVerification &&
                    !selectedTargetIsStale &&
                    !courseDetailError && (
                      <FieldDescription role="status">
                        Verifying the recommended assignment for this course…
                      </FieldDescription>
                    )}
                  {!selectedTargetIsStale && fieldErrors.target && (
                    <FieldError id="study-target-error">
                      {fieldErrors.target}
                    </FieldError>
                  )}
                </Field>

                <Field>
                  <FieldLabel htmlFor="study-topic">
                    Topic or study goal (optional)
                  </FieldLabel>
                  <Textarea
                    id="study-topic"
                    aria-label="Topic or study goal"
                    aria-describedby="study-topic-description"
                    value={topic}
                    maxLength={1000}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder="For example, compare mitosis and meiosis"
                    className="w-full text-base"
                    disabled={offline || submitting}
                  />
                  <FieldDescription id="study-topic-description">
                    This helps focus the session but cannot expand course or
                    source permissions.
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="study-material-search">
                    Supplementary saved materials (optional)
                  </FieldLabel>
                  <Input
                    id="study-material-search"
                    aria-label="Search saved study materials"
                    type="search"
                    value={materialSearch}
                    onChange={(event) => setMaterialSearch(event.target.value)}
                    placeholder="Search this course and personal materials"
                    className="w-full text-base"
                    disabled={offline || submitting || contextLoading}
                  />
                  {contextLoading && (
                    <p
                      role="status"
                      className="flex items-center gap-2 text-base text-muted-foreground"
                    >
                      <Loader2
                        className="size-4 animate-spin"
                        aria-hidden="true"
                      />
                      Loading saved materials…
                    </p>
                  )}
                  {contextError && (
                    <FieldDescription>{contextError}</FieldDescription>
                  )}
                  {prefillNotice && (
                    <FieldDescription role="status">
                      {prefillNotice}
                    </FieldDescription>
                  )}
                  {selectedContextItemIds.length >= 20 && (
                    <FieldDescription>
                      Choose up to 20 materials.
                    </FieldDescription>
                  )}
                  {materials.length > 0 && (
                    <fieldset className="flex max-h-60 flex-col gap-2 overflow-y-auto rounded-md border p-3">
                      <legend className="px-1 text-base">
                        Available materials
                      </legend>
                      {visibleMaterials.map((item) => {
                        const checked = selectedContextItemIds.includes(
                          item.id,
                        );
                        return (
                          <label
                            key={item.id}
                            htmlFor={`study-material-${item.id}`}
                            className="flex items-start gap-2"
                          >
                            <Checkbox
                              id={`study-material-${item.id}`}
                              checked={checked}
                              disabled={
                                offline ||
                                submitting ||
                                contextLoading ||
                                (!checked &&
                                  selectedContextItemIds.length >= 20)
                              }
                              onCheckedChange={(value) =>
                                toggleMaterial(item.id, value)
                              }
                            />
                            <span className="flex min-w-0 items-center gap-2 text-base">
                              <BookOpen
                                className="size-4 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                              <span className="truncate">{item.title}</span>
                            </span>
                          </label>
                        );
                      })}
                      {visibleMaterials.length === 0 && (
                        <p
                          role="status"
                          className="text-base text-muted-foreground"
                        >
                          No saved materials match this search.
                        </p>
                      )}
                    </fieldset>
                  )}
                  {!contextLoading &&
                    !contextError &&
                    selectedCourseId &&
                    materials.length === 0 && (
                      <FieldDescription>
                        No saved materials are available for this course yet.
                      </FieldDescription>
                    )}
                </Field>
              </>
            )}

            <Field>
              <FieldLabel id="study-duration-label">Duration</FieldLabel>
              <Select
                value={durationChoice}
                onValueChange={chooseDuration}
                items={durationChoices.map((value) => ({
                  value,
                  label: formatDurationChoice(value),
                }))}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label="Study duration"
                  aria-labelledby="study-duration-label"
                  aria-invalid={Boolean(
                    fieldErrors.duration || durationIsInvalid,
                  )}
                  aria-describedby="study-duration-description"
                  disabled={offline || submitting}
                >
                  <SelectValue>
                    {formatDurationChoice(durationChoice)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {durationChoices.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {formatDurationChoice(choice)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {durationChoice === 'custom' && (
                <Input
                  aria-label="Custom duration in minutes"
                  type="number"
                  min={1}
                  max={240}
                  step={1}
                  value={customDuration}
                  onChange={(event) => setCustomDuration(event.target.value)}
                  aria-invalid={durationIsInvalid}
                  aria-describedby={
                    durationIsInvalid || fieldErrors.duration
                      ? 'study-duration-description study-duration-error'
                      : 'study-duration-description'
                  }
                  className="w-full text-base"
                  disabled={offline || submitting}
                />
              )}
              <FieldDescription id="study-duration-description">
                Timed sessions use a continuous wall-clock deadline; leaving
                does not pause it.
              </FieldDescription>
              {(fieldErrors.duration || durationIsInvalid) && (
                <FieldError id="study-duration-error">
                  {fieldErrors.duration ||
                    'Choose a duration from 1 to 240 minutes.'}
                </FieldError>
              )}
            </Field>
          </FieldGroup>

          {submitError && (
            <Alert role="alert">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
          {fieldErrors.offline && (
            <FieldError>{fieldErrors.offline}</FieldError>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={
              offline ||
              submitting ||
              coursesLoading ||
              !activity ||
              !selectedCourseId ||
              courseIsStale ||
              selectedTargetNeedsVerification ||
              durationIsInvalid
            }
          >
            <LoadingSwap isLoading={submitting}>
              Start study session
            </LoadingSwap>
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
};
