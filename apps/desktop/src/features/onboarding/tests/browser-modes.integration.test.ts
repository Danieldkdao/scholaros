import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  localBrowser,
  Stagehand,
  type ClientLLM,
} from '@browserbasehq/stagehand';
import { z } from 'zod';
import {
  disconnectPageObserver,
  installPageObserver,
  readPageMutationState,
} from '../../watch/services/page-observer';
import { scanCourseCollection } from '../../courses/lib/course-content-scan';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import type { ObservedPage } from '../lib/academic-discovery';

const bridgeMocks = vi.hoisted(() => ({
  accountRequest: vi.fn(async () => ({ materials: [], coverage: 'complete' })),
}));
vi.mock('../../../lib/auth/main', () => ({
  accountRequest: bridgeMocks.accountRequest,
  isAccountSessionCurrent: () => true,
}));
vi.mock('../../../lib/auth/client', () => ({
  authClient: { getCookie: () => 'fixture-session=ready' },
}));
// The local HTTP fixture bypasses host eligibility; production policy tests it separately.
vi.mock('../lib/browser-policy', async (importOriginal) => {
  const policy = await importOriginal<typeof import('../lib/browser-policy')>();
  const isLocalFixtureUrl = (value: string, hosts: string[]) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'http:' &&
        url.hostname === '127.0.0.1' &&
        hosts.includes(url.hostname)
      );
    } catch {
      return false;
    }
  };
  return {
    ...policy,
    academicPageIdentity: (value: string) =>
      isLocalFixtureUrl(value, ['127.0.0.1'])
        ? new URL(value).href
        : policy.academicPageIdentity(value),
    isAcademicUrl: (value: string) =>
      isLocalFixtureUrl(value, ['127.0.0.1']) || policy.isAcademicUrl(value),
    isCourseNavigationTarget: (
      value: string,
      scope: {
        courseUrl: string;
        observedResourceRelationships: readonly {
          parentUrl: string;
          targetUrl: string;
        }[];
      },
      hosts: string[],
    ) => {
      if (
        !isLocalFixtureUrl(value, hosts) ||
        !isLocalFixtureUrl(scope.courseUrl, hosts)
      )
        return policy.isCourseNavigationTarget(value, scope, hosts);
      const target = new URL(value);
      const course = new URL(scope.courseUrl);
      const coursePath = course.pathname.replace(/\/+$/, '') || '/';
      return (
        target.origin === course.origin &&
        (target.pathname === coursePath ||
          (coursePath !== '/' && target.pathname.startsWith(`${coursePath}/`)))
      );
    },
    isReadNavigation: (value: string, hosts: string[]) =>
      isLocalFixtureUrl(value, hosts) || policy.isReadNavigation(value, hosts),
  };
});

import { createBrowserNavigationAdapter } from '../services/browser-navigation';

const enabled = process.env.RUN_BROWSER_INTEGRATION === '1';
const executable =
  process.env.BROWSER_EXECUTABLE ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const assignmentExtraction = (sourceUrl: string) => {
  const lab = {
    title: 'Lab report',
    description: null,
    kind: 'assignment',
    state: 'active-unsubmitted',
    due: {
      kind: 'date',
      date: '2026-12-01',
      original: 'December 1, 2026',
    },
    availableFrom: null,
    availableUntil: null,
    pointsPossible: null,
    url: null,
    sourceId: 'lab-1',
    resources: [],
    evidence: {
      sourceUrl,
      excerpts: ['Lab report due December 1, 2026'],
      targetIds: [],
    },
  };
  const midterm = {
    title: 'Midterm',
    description: null,
    kind: 'exam',
    state: 'active-unsubmitted',
    due: {
      kind: 'date',
      date: '2026-12-08',
      original: 'December 8, 2026',
    },
    availableFrom: null,
    availableUntil: null,
    pointsPossible: null,
    url: null,
    sourceId: 'midterm-1',
    resources: [],
    evidence: {
      sourceUrl,
      excerpts: ['Midterm due December 8, 2026'],
      targetIds: [],
    },
  };
  return {
    coverage: 'complete' as const,
    assignments: [lab, midterm, lab, midterm],
  };
};

describe.skipIf(!enabled)('Stagehand browser compatibility', () => {
  it('uses the custom structured callback on its explicit page and cleans up a closed operation', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'scholaros-stagehand-'));
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (path === '/biology')
        response.end(
          '<main><h1>Biology 101</h1><a href="/details">Assignment details</a></main>',
        );
      else if (path === '/details')
        response.end(
          '<main><h1>Worksheet 1</h1><p>Read chapter one.</p></main>',
        );
      else if (path === '/biology/assignments')
        response.end(
          '<main><h1>Biology 101 Assignments</h1><p>Lab report due December 1, 2026</p><p>Midterm due December 8, 2026</p></main>',
        );
      else response.end('<main><h1>Chemistry 202</h1></main>');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No fixture port.');
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await localBrowser.launch({
      executablePath: executable,
      userDataDir: profile,
      headless: true,
      keepAlive: false,
    });
    const callbacks: Array<{ messages: unknown; responseFormat?: unknown }> =
      [];
    let releaseInference: (() => void) | undefined;
    let inferenceEntered: (() => void) | undefined;
    const delayedInference = new Promise<void>((resolve) => {
      releaseInference = resolve;
    });
    const enteredInference = new Promise<void>((resolve) => {
      inferenceEntered = resolve;
    });
    let holdNextCallback = false;
    const generate: ClientLLM['generate'] = async (params) => {
      callbacks.push({
        messages: params.messages,
        responseFormat: params.responseFormat,
      });
      if (holdNextCallback) {
        holdNextCallback = false;
        inferenceEntered?.();
        await delayedInference;
      }
      const responseFormat = params.responseFormat;
      if (responseFormat?.type !== 'json_schema')
        throw new Error('Stagehand did not request structured output.');
      const schema = responseFormat.schema as {
        properties?: Record<string, unknown>;
      };
      const elements = schema.properties?.elements as
        | { items?: { properties?: Record<string, unknown> } }
        | undefined;
      const elementId =
        JSON.stringify(params.messages).match(
          /\[(\d+-\d+)\] link: Assignment details/,
        )?.[1] ?? JSON.stringify(params.messages).match(/\[(\d+-\d+)\]/)?.[1];
      const structuredContent = elements
        ? {
            elements: [
              {
                elementId: elementId ?? '',
                description: 'Open assignment details',
                method: 'click',
                arguments: [],
              },
            ],
          }
        : 'progress' in (schema.properties ?? {})
          ? { progress: 'Read the assignment.', completed: true }
          : 'assignments' in (schema.properties ?? {})
            ? assignmentExtraction(`${origin}/biology/assignments`)
            : 'materials' in (schema.properties ?? {})
              ? { materials: [], coverage: 'complete' }
              : { title: 'Worksheet 1', text: 'Read chapter one.' };
      const content = JSON.stringify(structuredContent);
      return {
        role: 'assistant',
        content: { type: 'text', text: content },
        outputFormat: 'json_schema',
        structuredContent,
      } as unknown as Awaited<ReturnType<ClientLLM['generate']>>;
    };
    let stagehand = await Stagehand.create({
      browser,
      logging: { level: 'off' },
      model: { generate },
    });
    try {
      const page = await browser.context.newPage();
      const distractor = await browser.context.newPage();
      await page.goto(`${origin}/biology`);
      await distractor.goto(`${origin}/chemistry`);
      const actions = await stagehand.observe('Open assignment details', {
        page,
      });
      expect(actions.data).toContainEqual(
        expect.objectContaining({
          method: 'click',
          description: 'Open assignment details',
        }),
      );
      expect(JSON.stringify(callbacks[0]?.messages)).toContain('Biology 101');
      expect(JSON.stringify(callbacks[0]?.messages)).not.toContain(
        'Chemistry 202',
      );
      const acted = await stagehand.act(actions.data[0]!, { page });
      expect(acted.data.success).toBe(true);
      await page.waitForFunction(() => location.pathname === '/details');
      const extractionSchema = z.object({
        title: z.string(),
        text: z.string(),
      }) as unknown as NonNullable<Parameters<typeof stagehand.extract>[1]>;
      const extracted = await stagehand.extract(
        'Read the assignment title and instructions.',
        extractionSchema,
        { page },
      );
      expect(extracted.data).toEqual({
        title: 'Worksheet 1',
        text: 'Read chapter one.',
      });
      expect(callbacks).toHaveLength(3);
      expect(callbacks.every((call) => call.responseFormat)).toBe(true);

      const extractionRequest = {
        kind: 'materials' as const,
        goal: 'Read the course materials',
        notes: '',
        pages: [
          {
            url: `${origin}/details`,
            title: 'Worksheet 1',
            text: 'Read chapter one.',
          },
        ],
      };
      const adapterDependencies = {
        page,
        hosts: ['127.0.0.1'],
        signal: new AbortController().signal,
        isCurrent: () => true,
        assertReadable: () => undefined,
      };
      const decisionAdapter = createBrowserNavigationAdapter(
        'decision',
        adapterDependencies,
      );
      const inoutAdapter = createBrowserNavigationAdapter('inout', {
        ...adapterDependencies,
        stagehand,
      });
      const decisionResult = await decisionAdapter.extract(extractionRequest);
      const inoutResult = await inoutAdapter.extract(extractionRequest);
      expect(decisionResult).toEqual({ materials: [], coverage: 'complete' });
      expect(inoutResult).toEqual(decisionResult);
      expect(bridgeMocks.accountRequest).toHaveBeenCalledWith(
        '/api/agent',
        { ...extractionRequest, browserNavigationMode: 'decision' },
        expect.any(AbortSignal),
      );

      const coursePage = await browser.context.newPage();
      await coursePage.goto(`${origin}/biology/assignments`);
      const assignmentPage: ObservedPage = {
        url: await coursePage.url(),
        title: await coursePage.title(),
        text: await coursePage.evaluate(() => document.body.innerText),
        links: [],
        retrievedAt: new Date().toISOString(),
      };
      const assignmentResult = assignmentExtraction(assignmentPage.url);
      bridgeMocks.accountRequest.mockResolvedValueOnce(
        assignmentResult as never,
      );
      const courseScope = {
        courseUrl: assignmentPage.url,
        observedResourceRelationships: [],
      };
      const scanErrors: string[] = [];
      const scanWith = (navigation: typeof decisionAdapter) =>
        scanCourseCollection({
          from: assignmentPage,
          kind: 'assignments',
          host: '127.0.0.1',
          identityScope: {
            accountId: 'synthetic-student',
            connectionId: 'synthetic-canvas',
            courseId: 'biology-101',
          },
          courseName: 'Biology 101',
          excludedUrls: [],
          notes: '',
          context: {
            openFrom: async () => {
              throw new Error('The complete fixture has no detail pages.');
            },
            assertReadable: () => undefined,
            navigation,
          },
          onError: (error) => scanErrors.push(error),
          request: async (request: AgentRequestSchema) => {
            throw new Error(`Unexpected ${request.kind} fallback request.`);
          },
          signal: new AbortController().signal,
          isCurrent: () => true,
        });
      const decisionCourseAdapter = createBrowserNavigationAdapter('decision', {
        ...adapterDependencies,
        page: coursePage,
        courseScope,
      });
      const inoutCourseAdapter = createBrowserNavigationAdapter('inout', {
        ...adapterDependencies,
        page: coursePage,
        stagehand,
        courseScope,
      });
      const decisionScan = await scanWith(decisionCourseAdapter);
      const inoutScan = await scanWith(inoutCourseAdapter);
      expect(
        decisionScan.status,
        JSON.stringify({ decisionScan, scanErrors }),
      ).toBe('complete');
      expect(inoutScan.status, JSON.stringify({ inoutScan, scanErrors })).toBe(
        'complete',
      );
      expect(
        decisionScan.items.map((item) => item.content?.sourceId).sort(),
      ).toEqual(['lab-1', 'midterm-1']);
      expect(
        inoutScan.items.map((item) => item.content?.sourceId).sort(),
      ).toEqual(['lab-1', 'midterm-1']);
      expect(
        inoutScan.items.map((item) => item.content?.evidence.sourceUrl),
      ).toEqual([assignmentPage.url, assignmentPage.url]);
      expect(inoutScan.items.map((item) => item.content)).toEqual(
        decisionScan.items.map((item) => item.content),
      );

      await installPageObserver(page);
      const observerBeforeMutation = await readPageMutationState(page);
      await page.evaluate(() => {
        document.body.innerHTML = '<main>Worksheet 2 due December 1</main>';
      });
      await page.waitForFunction(() =>
        document.body.innerText.includes('Worksheet 2'),
      );
      const observerAfterMutation = await readPageMutationState(page);
      expect(observerAfterMutation.revision).toBeGreaterThan(
        observerBeforeMutation.revision,
      );
      await page.evaluate(() =>
        history.pushState(null, '', `${location.pathname}#upcoming`),
      );
      const observerAfterRouteChange = await readPageMutationState(page);
      expect(observerAfterRouteChange.url).toContain('#upcoming');
      expect(observerAfterRouteChange.revision).toBeGreaterThan(
        observerAfterMutation.revision,
      );
      await page.goto(`${origin}/biology`);
      const observerAfterDocumentChange = await readPageMutationState(page);
      expect(observerAfterDocumentChange.installed).toBe(true);
      expect(observerAfterDocumentChange.documentId).not.toBe(
        observerAfterRouteChange.documentId,
      );
      await disconnectPageObserver(page);

      await stagehand.close();
      stagehand = await Stagehand.create({
        browser,
        logging: { level: 'off' },
        model: { generate },
        selfHeal: false,
      });
      expect(await browser.context.pages()).toContainEqual(
        expect.objectContaining({ pageId: page.pageId }),
      );

      const closingPage = await browser.context.newPage(`${origin}/biology`);
      holdNextCallback = true;
      const operation = stagehand.observe('Find the course heading', {
        page: closingPage,
      });
      await enteredInference;
      await closingPage.close();
      releaseInference?.();
      const staleObservation = await operation;
      await expect(
        stagehand.act(staleObservation.data[0]!, { page: closingPage }),
      ).rejects.toThrow();
      expect(await browser.context.pages()).not.toContainEqual(
        expect.objectContaining({ pageId: closingPage.pageId }),
      );
      await stagehand.close();
      stagehand = await Stagehand.create({
        browser,
        logging: { level: 'off' },
      });
      await stagehand.close();
    } finally {
      await stagehand.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  }, 120_000);
});
