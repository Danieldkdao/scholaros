import {
  courseContentEvidenceSchema,
  navigationDecisionSchema,
} from '@scholaros/services/ai/schemas';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import { outcomeFromError } from '../../onboarding/lib/discovery-outcomes';
import {
  childItemsFrom,
  childPageTarget,
  type CourseChildKind,
} from './course-content';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import type { CourseListContext } from '../../onboarding/services/connection-scan';
import type { CourseChildItem, CourseChildScan } from '../types';

export const scanCourseCollection = async ({
  from,
  kind,
  host,
  courseName,
  excludedUrls,
  notes,
  context,
  request,
  signal,
  isCurrent,
  onProgress,
}: {
  from: ObservedPage;
  kind: CourseChildKind;
  host: string;
  courseName: string;
  excludedUrls: string[];
  notes: string;
  context: Pick<
    CourseListContext,
    'openFrom' | 'assertReadable' | 'revealContent'
  >;
  request: (body: AgentRequestSchema) => Promise<unknown>;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onProgress?: (scan: CourseChildScan) => void;
}): Promise<CourseChildScan> => {
  const items = new Map<string, CourseChildItem>();
  const inactiveItems = new Map<string, CourseChildItem>();
  const seen = new Set<string>([from.url]);
  const frontier = new Map<
    string,
    { from: ObservedPage; label: string; url: string }
  >();
  const revealedStates = new Set<string>();
  let saving = false;
  let verified = false;
  let incomplete = false;
  const assertActive = () => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    context.assertReadable();
  };
  const goal = `Find all ${kind === 'assignments' ? 'currently active, unsubmitted assignments with their own due dates (including overdue work still open)' : 'announcements'} for ${courseName.slice(0, 100)} only; stay within this course and stop when this task is done, as of ${new Date().toISOString()}; verify lists and item details.`;
  const finish = (status: CourseChildScan['status']): CourseChildScan => ({
    status,
    items: [...items.values()],
    ...(inactiveItems.size
      ? { inactiveItems: [...inactiveItems.values()] }
      : {}),
  });
  try {
    let current = from;
    const direct = childPageTarget(from, kind, host);
    while (true) {
      assertActive();
      seen.add(current.url);
      frontier.delete(current.url);
      incomplete ||= !!current.linksTruncated;
      for (const link of current.links) {
        const identity = academicPageIdentity(link.url);
        if (
          !identity ||
          seen.has(identity) ||
          excludedUrls.some(
            (url) =>
              identity === url ||
              (!from.url.startsWith(`${url}/`) &&
                identity.startsWith(`${url}/`)),
          ) ||
          !isReadNavigation(link.url, [host])
        )
          continue;
        frontier.set(identity, {
          from: current,
          label: link.label,
          url: link.url,
        });
      }
      const text = current.text ?? '';
      // Overlap keeps an item split at a request boundary visible to extraction.
      for (let offset = 0; offset < Math.max(text.length, 1); offset += 11000) {
        assertActive();
        const result = courseContentEvidenceSchema.parse(
          await request({
            kind: 'course-content',
            goal,
            notes,
            pages: [
              {
                url: current.url,
                title: current.title.slice(0, 500),
                text: text.slice(offset, offset + 12000),
              },
            ],
          }),
        );
        assertActive();
        verified ||= result.coverage === 'complete';
        incomplete ||= result.coverage === 'partial';
        for (const card of result.cards) {
          if (card.sourceUrl !== current.url) {
            incomplete = true;
            continue;
          }
          if (kind === 'assignments' && card.kind === 'assignment') {
            if (card.assignmentState === 'unknown') incomplete = true;
            if (
              card.assignmentState === 'submitted' ||
              card.assignmentState === 'inactive'
            ) {
              for (const item of childItemsFrom([card], kind, current.url)) {
                const key = `${item.url}\n${item.title.toLowerCase()}`;
                items.delete(key);
                inactiveItems.set(key, item);
              }
            }
            if (card.assignmentState !== 'active-unsubmitted') continue;
          }
          for (const item of childItemsFrom([card], kind, current.url)) {
            const key = `${item.url}\n${item.title.toLowerCase()}`;
            if (!inactiveItems.has(key)) items.set(key, item);
          }
        }
        saving = true;
        onProgress?.(finish('partial'));
        saving = false;
      }
      if (direct && !seen.has(direct)) {
        current = await context.openFrom(from, direct);
        seen.add(direct);
        frontier.delete(direct);
        continue;
      }
      if (context.revealContent) {
        const state = JSON.stringify([
          current.url,
          current.text,
          current.links,
        ]);
        if (!revealedStates.has(state)) {
          revealedStates.add(state);
          const revealed = await context.revealContent(current);
          assertActive();
          if (revealed) {
            const nextState = JSON.stringify([
              revealed.url,
              revealed.text,
              revealed.links,
            ]);
            if (!revealedStates.has(nextState)) {
              current = revealed;
              continue;
            }
            incomplete = true;
          }
        }
      }
      let next: { from: ObservedPage; label: string; url: string } | undefined;
      while (frontier.size && !next) {
        assertActive();
        const batch = [...frontier.entries()].slice(0, 80);
        const targets = batch.map(([, link], index) => ({
          id: String(index + 1),
          label: link.label.slice(0, 300),
          url: link.url,
        }));
        const choice = navigationDecisionSchema.parse(
          await request({
            kind: 'choose',
            goal: `${goal} Explore modules, folders and pagination; open details to resolve unknown statuses; DONE only when no offered link adds evidence.`,
            notes,
            pages: [
              {
                url: current.url,
                title: current.title.slice(0, 500),
                text: text.slice(0, 12000),
              },
            ],
            targets,
          }),
        );
        assertActive();
        if (choice.operation === 'NAVIGATE') {
          const index = targets.findIndex(
            (target) => target.id === choice.target,
          );
          if (index < 0) throw new Error('The agent chose an unobserved page.');
          const [identity, selected] = batch[index];
          frontier.delete(identity);
          seen.add(identity);
          next = selected;
        } else {
          incomplete ||= choice.operation === 'BLOCKED';
          for (const [identity] of batch) frontier.delete(identity);
        }
      }
      if (!next)
        return finish(verified && !incomplete ? 'complete' : 'partial');
      current = await context.openFrom(next.from, next.url);
    }
  } catch (error) {
    if (saving || signal.aborted || !isCurrent()) throw error;
    return finish(
      items.size || inactiveItems.size ? 'partial' : outcomeFromError(error),
    );
  }
};
