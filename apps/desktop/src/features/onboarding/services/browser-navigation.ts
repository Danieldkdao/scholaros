import type { Stagehand, Page } from '@browserbasehq/stagehand';
import type { BrowserNavigationMode } from '@scholaros/env/browser-navigation';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import {
  academicPageIdentity,
  hasCourseRouteIdentity,
  isCourseNavigationTarget,
  isReadNavigation,
  type CourseNavigationScope,
} from '../lib/browser-policy';
import { createDecisionNavigationAdapter } from './decision-navigation';
import { createInoutNavigationAdapter } from './inout-navigation';
import { toBrowserCapabilityError } from './browser-mode';

export type ResourceExtractionRequest = AgentRequestSchema & {
  kind: 'courses' | 'assignments' | 'announcements' | 'materials';
};

export type BrowserNavigationChoice = {
  operation: 'NAVIGATE' | 'DONE' | 'BLOCKED';
  target: string | null;
  navigationHandled?: boolean;
};

export type BrowserNavigationDependencies = {
  page: Page;
  stagehand?: Stagehand;
  hosts: string[];
  signal: AbortSignal;
  isCurrent: () => boolean;
  assertReadable: () => void;
  onWait?: (milliseconds: number) => void;
  courseScope?: CourseNavigationScope | null;
};

export type BrowserNavigationAdapter = {
  setCourseScope?: (scope: CourseNavigationScope | null) => void;
  discoverCourses: (input: {
    goal: string;
    notes: string;
    pages: AgentRequestSchema['pages'];
    targets: NonNullable<AgentRequestSchema['targets']>;
  }) => Promise<string[]>;
  choose: (input: {
    goal: string;
    notes: string;
    memory?: AgentRequestSchema['memory'];
    pages: AgentRequestSchema['pages'];
    targets: NonNullable<AgentRequestSchema['targets']>;
  }) => Promise<BrowserNavigationChoice | null>;
  extract: (request: ResourceExtractionRequest) => Promise<unknown>;
};

export type CourseScopedBrowserNavigationAdapter = BrowserNavigationAdapter & {
  setCourseScope: (scope: CourseNavigationScope | null) => void;
};

export const createBrowserNavigationAdapter = (
  mode: BrowserNavigationMode,
  dependencies: BrowserNavigationDependencies,
): CourseScopedBrowserNavigationAdapter => {
  let courseScope = dependencies.courseScope ?? null;
  const adapter = (() => {
    switch (mode) {
      case 'decision':
        return createDecisionNavigationAdapter(dependencies);
      case 'inout':
        return createInoutNavigationAdapter(dependencies);
    }
  })();
  const assertCurrentPage = async (pages: AgentRequestSchema['pages']) => {
    const observedUrl = pages.at(-1)?.url;
    const currentUrl = await dependencies.page.url();
    const observedIdentity = observedUrl
      ? academicPageIdentity(observedUrl)
      : null;
    const currentIdentity = academicPageIdentity(currentUrl);
    if (
      !observedIdentity ||
      currentIdentity !== observedIdentity ||
      !isReadNavigation(currentUrl, dependencies.hosts)
    )
      throw new Error('The current page changed before browser inference.');
    return currentUrl;
  };
  const assertCourseExtractionScope = async (
    request: ResourceExtractionRequest,
  ) => {
    const currentUrl = await assertCurrentPage(request.pages);
    const courseUrl = request.context?.courseUrl;
    if (
      courseUrl &&
      (!courseScope ||
        academicPageIdentity(courseScope.courseUrl) !==
          academicPageIdentity(courseUrl))
    )
      throw new Error('The selected course has not been verified for reading.');
    if (
      (courseScope &&
        !isCourseNavigationTarget(
          currentUrl,
          courseScope,
          dependencies.hosts,
        )) ||
      (!courseScope && hasCourseRouteIdentity(currentUrl))
    )
      throw new Error('The current page is outside the verified course scope.');
    return { courseScope, currentUrl };
  };
  return {
    setCourseScope: (scope) => {
      courseScope = scope;
    },
    discoverCourses: async (input) => {
      try {
        const currentUrl = await assertCurrentPage(input.pages);
        if (courseScope || hasCourseRouteIdentity(currentUrl)) return [];
        const targets = input.targets.filter((target) =>
          isReadNavigation(target.url, dependencies.hosts),
        );
        if (!targets.length) return [];
        const courseTargetIds = await adapter.discoverCourses({
          ...input,
          targets,
        });
        const currentAfter = await dependencies.page.url();
        if (
          academicPageIdentity(currentAfter) !==
          academicPageIdentity(currentUrl)
        )
          throw new Error('The page changed during course discovery.');
        return courseTargetIds;
      } catch (error) {
        throw toBrowserCapabilityError(error);
      }
    },
    choose: async (input) => {
      try {
        const currentUrl = await assertCurrentPage(input.pages);
        const scope = courseScope;
        if (!scope && hasCourseRouteIdentity(currentUrl))
          return { operation: 'BLOCKED', target: null };
        const targets = input.targets.filter(
          (target) =>
            isReadNavigation(target.url, dependencies.hosts) &&
            (!scope ||
              isCourseNavigationTarget(target.url, scope, dependencies.hosts)),
        );
        if (!targets.length) return { operation: 'BLOCKED', target: null };
        const choice = await adapter.choose({ ...input, targets });
        if (!choice) return null;
        const selected = targets.find((target) => target.id === choice.target);
        if (choice.operation === 'NAVIGATE' && !selected)
          return { operation: 'BLOCKED', target: null };
        const currentAfter = await dependencies.page.url();
        if (
          choice.navigationHandled &&
          (!selected ||
            academicPageIdentity(currentAfter) !==
              academicPageIdentity(selected.url) ||
            !isReadNavigation(currentAfter, dependencies.hosts) ||
            (scope &&
              !isCourseNavigationTarget(
                currentAfter,
                scope,
                dependencies.hosts,
              )))
        )
          return { operation: 'BLOCKED', target: null };
        if (
          !choice.navigationHandled &&
          academicPageIdentity(currentAfter) !==
            academicPageIdentity(currentUrl)
        )
          throw new Error('The current page changed during course navigation.');
        return choice;
      } catch (error) {
        throw toBrowserCapabilityError(error);
      }
    },
    extract: async (request) => {
      try {
        const scope = await assertCourseExtractionScope(request);
        const result = await adapter.extract(request);
        const currentAfter = await dependencies.page.url();
        if (
          academicPageIdentity(currentAfter) !==
            academicPageIdentity(scope.currentUrl) ||
          !isReadNavigation(currentAfter, dependencies.hosts) ||
          (scope.courseScope &&
            !isCourseNavigationTarget(
              currentAfter,
              scope.courseScope,
              dependencies.hosts,
            ))
        )
          throw new Error(
            'The page changed outside the verified course scope.',
          );
        return result;
      } catch (error) {
        throw toBrowserCapabilityError(error);
      }
    },
  };
};
