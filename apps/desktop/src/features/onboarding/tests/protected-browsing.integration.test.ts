import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { localBrowser, Stagehand } from '@browserbasehq/stagehand';
import { scanConnection } from '../services/connection-scan';
import { createMissionNavigator } from '../services/mission-navigation';
import type { ActiveWorkspace } from '../services/browser-workspace';
import type { AcademicConnection } from '../types';

const electronTestState = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  electronTestState.userData = mkdtempSync(
    join(tmpdir(), 'scholaros-protected-db-'),
  );
  const app = {
    getPath: () => electronTestState.userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    once: vi.fn(),
  };
  return { app, default: { app } };
});

vi.mock('../../../lib/auth/main', () => ({
  accountRequest: async (
    _route: string,
    input: { targets: Array<{ id: string; label: string }> },
  ) => ({
    courseTargetIds: input.targets
      .filter((target) => target.label === 'Biology 101')
      .map((target) => target.id),
  }),
}));
vi.mock('../services/browser-mode', () => ({
  getBrowserNavigationMode: async () => 'decision',
}));
afterAll(() =>
  rmSync(electronTestState.userData, { recursive: true, force: true }),
);

// Browser integration is opt-in and uses an empty temporary profile, never a student's profile.
const enabled = process.env.RUN_BROWSER_INTEGRATION === '1';
const executable =
  process.env.BROWSER_EXECUTABLE ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const host = 'district.schoology.com';
const origin = `https://${host}`;
const email = 'student@example.test';
const NativeWebSocket = globalThis.WebSocket;

const isChromeDebuggingPortAvailable = async (port: number) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(250),
    });
    return response.ok;
  } catch {
    return false;
  }
};

describe.skipIf(!enabled)('protected Chromium browsing', () => {
  it.each([false, true])(
    'continues trusted account selection and discovers rendered courses on repeat visits, forced chooser %s',
    async (forcePicker) => {
      const profile = await mkdtemp(
        join(tmpdir(), 'scholaros-browsing-fixture-'),
      );
      const port = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          const selectedPort =
            typeof address === 'object' && address ? address.port : 0;
          server.close((error) =>
            error ? reject(error) : resolve(selectedPort),
          );
        });
      });
      const browser = await localBrowser.launch({
        executablePath: executable,
        port,
        userDataDir: profile,
        headless: true,
        keepAlive: false,
      });
      let compatibilityStagehand: Stagehand | undefined;
      let pickerVisits = 0;
      let accountSelections = 0;
      const assetReads = new Set<string>();
      let bannerReads = 0;
      let blockedFrameWrites = 0;
      const assignmentReads = new Set<string>();
      let pdfReads = 0;
      const pdfRequestCookies: string[] = [];
      const pdfUrl = `${origin}/course/1/handout.pdf`;
      const pdfBytes = '%PDF-1.4\nprotected fixture';
      const fixture = (url: string, headers: Record<string, string>) => {
        const parsed = new URL(url);
        const cookie =
          Object.entries(headers).find(
            ([name]) => name.toLowerCase() === 'cookie',
          )?.[1] ?? '';
        if (
          parsed.hostname === host &&
          (parsed.pathname === '/home' || parsed.pathname === '/entry')
        ) {
          if (parsed.pathname === '/entry')
            return {
              status: 302,
              headers: {
                Location:
                  'https://accounts.google.com/v3/signin/accountchooser',
              },
              body: '',
            };
          if (!cookie.includes('fixture-session=ready'))
            return {
              status: 302,
              headers: {
                Location:
                  'https://accounts.google.com/v3/signin/accountchooser',
              },
              body: '',
            };
          return {
            body: `<html><head><title>School home</title><link rel="stylesheet" href="https://assets.example.test/site.css?Signature=fixture&Key-Pair-Id=fixture"><script src="https://assets.example.test/s_grade_item_add_form.js?token=fixture" defer></script><script>addEventListener('message', event => { if (event.origin === 'https://docs.google.com' && event.data === 'banner-ready') document.body.dataset.banner = 'ready'; });</script></head><body><header><a href="#courses" ${forcePicker ? '' : 'role="button" aria-expanded="false"'}>Courses</a><a id="open-popup" href="https://popup.invalid/popup" target="_blank" onclick="document.body.dataset.popupClick = event.isTrusted ? 'trusted' : 'synthetic'">Open resource</a></header><a href="${origin}/home">Course dashboard</a><main>Welcome to your academic dashboard and current learning resources.</main><aside><div class="upcoming-events">Art live class 2:20 pm</div><div id="upcoming"></div><div id="overdue"></div></aside><iframe src="https://docs.google.com/presentation/d/e/fixture-deck/pubembed?start=false&loop=false"></iframe><div id="courses" hidden></div></body></html>`,
          };
        }
        if (
          parsed.hostname === host &&
          /^\/home\/(upcoming|overdue)_submissions_ajax$/.test(parsed.pathname)
        ) {
          assignmentReads.add(parsed.pathname);
          const upcoming = parsed.pathname.includes('upcoming');
          return {
            type: 'application/json',
            body: JSON.stringify({
              html: upcoming
                ? '<p id="assignment">Biology worksheet due tomorrow</p>'
                : '<p id="late-assignment">Art worksheet overdue</p>',
            }),
          };
        }
        if (
          parsed.hostname === 'docs.google.com' &&
          parsed.pathname === '/presentation/d/e/fixture-deck/pubembed'
        ) {
          bannerReads += 1;
          return {
            body: '<html><body><main>Teacher\'s course banner</main><script src="https://slides-assets.example.test/frame.js" defer></script></body></html>',
          };
        }
        if (
          parsed.hostname === 'accounts.google.com' &&
          parsed.pathname === '/v3/signin/accountchooser'
        ) {
          pickerVisits += 1;
          return {
            body: `<html><head><title>Choose an account</title><script src="https://accounts.google.com/v3/signin/picker.js" defer></script></head><body><div role="link" data-identifier="${email}" tabindex="0">Student ${email}</div></body></html>`,
          };
        }
        if (
          parsed.hostname === 'accounts.google.com' &&
          parsed.pathname === '/v3/signin/picker.js'
        ) {
          return {
            type: 'application/javascript',
            body: `history.replaceState(null, '', location.href + '#identifier'); document.querySelector('[data-identifier]').addEventListener('click', (event) => { if (event.isTrusted) location.href = 'https://accounts.google.com/InteractiveLogin'; });`,
          };
        }
        if (
          parsed.hostname === 'accounts.google.com' &&
          parsed.pathname === '/InteractiveLogin'
        ) {
          const step = Number(parsed.searchParams.get('step') ?? 0);
          return {
            status: 302,
            headers: {
              Location:
                step < 6
                  ? `https://accounts.google.com/InteractiveLogin?step=${step + 1}`
                  : 'https://app.schoology.com/login/external_accounts/receive/google_apps',
            },
            body: '',
          };
        }
        if (
          parsed.hostname === 'app.schoology.com' &&
          parsed.pathname === '/login/external_accounts/receive/google_apps'
        )
          return {
            status: 302,
            headers: { Location: `${origin}/login/callback` },
            body: '',
          };
        if (parsed.hostname === host && parsed.pathname === '/login/callback') {
          accountSelections += 1;
          return {
            status: 302,
            headers: {
              Location: `${origin}/home`,
              'Set-Cookie':
                'fixture-session=ready; Path=/; Secure; SameSite=None',
            },
            body: '',
          };
        }
        if (
          ['assets.example.test', 'slides-assets.example.test'].includes(
            parsed.hostname,
          )
        ) {
          assetReads.add(parsed.pathname);
          if (parsed.pathname === '/frame.js')
            return {
              type: 'application/javascript',
              body: `fetch('/fixture-write', { method: 'POST' }).catch(() => {}); parent.postMessage('banner-ready', '${origin}');`,
            };
          return parsed.pathname.endsWith('.css')
            ? {
                type: 'text/css',
                body: 'body { background-color: rgb(1, 2, 3); }',
              }
            : {
                type: 'application/javascript',
                body: `for (const kind of ['upcoming', 'overdue']) fetch('/home/' + kind + '_submissions_ajax').then(response => response.json()).then(response => { document.querySelector('#' + kind).innerHTML = response.html; }).catch(() => {}); document.querySelector('header a').addEventListener('click', (event) => { if (!event.isTrusted) return; event.preventDefault(); const courses = document.querySelector('#courses'); courses.hidden = false; setTimeout(() => { courses.innerHTML = '<a href="${origin}/course/1">Biology 101</a>'; }, 350); event.currentTarget.setAttribute('aria-expanded', 'true'); });`,
              };
        }
        if (parsed.hostname === host && parsed.pathname === '/course/1')
          return {
            body: `<html><head><title>Biology 101</title></head><body><main>Biology 101 course materials<a href="${pdfUrl}">Course handout PDF</a></main></body></html>`,
          };
        if (
          parsed.hostname === host &&
          parsed.pathname === '/course/1/handout.pdf'
        ) {
          pdfReads += 1;
          pdfRequestCookies.push(cookie);
          return { type: 'application/pdf', body: pdfBytes };
        }
        return null;
      };
      class FixtureSocket extends NativeWebSocket {
        requests = new Map<
          string,
          { url: string; method: string; headers: Record<string, string> }
        >();
        constructor(url: string | URL) {
          super(url);
          this.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data));
            if (message.method === 'Fetch.requestPaused')
              this.requests.set(
                JSON.stringify([message.sessionId, message.params.requestId]),
                message.params.request,
              );
          });
        }
        override send(data: Parameters<WebSocket['send']>[0]) {
          const command = JSON.parse(String(data));
          if (
            command.method === 'Fetch.failRequest' &&
            this.requests.has(
              JSON.stringify([command.sessionId, command.params.requestId]),
            )
          ) {
            const url = this.requests.get(
              JSON.stringify([command.sessionId, command.params.requestId]),
            )?.url;
            if (url === 'https://docs.google.com/fixture-write')
              blockedFrameWrites += 1;
          }
          if (command.method === 'Fetch.continueRequest') {
            const request = this.requests.get(
              JSON.stringify([command.sessionId, command.params.requestId]),
            );
            const response = request
              ? fixture(request.url, request.headers)
              : null;
            if (response) {
              super.send(
                JSON.stringify({
                  id: command.id,
                  sessionId: command.sessionId,
                  method: 'Fetch.fulfillRequest',
                  params: {
                    requestId: command.params.requestId,
                    responseCode: response.status ?? 200,
                    responseHeaders: Object.entries({
                      'Content-Type': response.type ?? 'text/html',
                      ...response.headers,
                    }).map(([name, value]) => ({ name, value })),
                    body: Buffer.from(response.body).toString('base64'),
                  },
                }),
              );
              return;
            }
            super.send(
              JSON.stringify({
                id: command.id,
                sessionId: command.sessionId,
                method: 'Fetch.failRequest',
                params: {
                  requestId: command.params.requestId,
                  errorReason: 'BlockedByClient',
                },
              }),
            );
            return;
          }
          super.send(data);
        }
      }
      try {
        compatibilityStagehand = await Stagehand.create({
          browser,
          logging: { level: 'off' },
        });
        vi.stubGlobal('WebSocket', FixtureSocket);
        const workspace = {
          browser,
          cdpUrl: `http://127.0.0.1:${port}`,
        } as ActiveWorkspace;
        const connection: AcademicConnection = {
          id: 'fixture',
          host,
          name: 'School',
          url: `${origin}/${forcePicker ? 'entry' : 'home'}`,
          kind: 'resource',
          status: 'confirmed',
          verifiedAt: null,
          favicon: null,
          isCourseResource: true,
          notes: `If a Google account picker appears, choose ${email}.`,
        };
        const controller = new AbortController();
        const navigatePage = createMissionNavigator(
          browser.context,
          [host],
          controller.signal,
          () => true,
          {
            scopeId: forcePicker
              ? 'browser-fixture-forced'
              : 'browser-fixture-reuse',
          },
        );
        await browser.context.setDomainPolicy({
          allowedDomains: [host],
          blockedDomains: [],
        });
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await scanConnection({
            connection,
            workspace,
            hosts: [host],
            notes: '',
            isCurrent: () => true,
            signal: controller.signal,
            navigatePage,
            withCourseList: async (context) => {
              expect(
                await browser.context
                  .pages()
                  .then((pages) =>
                    pages
                      .at(-1)!
                      .evaluate(
                        () =>
                          document.querySelector('#late-assignment')
                            ?.textContent,
                      ),
                  ),
              ).toBe('Art worksheet overdue');
              expect(
                await browser.context
                  .pages()
                  .then((pages) =>
                    pages.at(-1)!.evaluate(() => document.body.dataset.banner),
                  ),
              ).toBe('ready');
              expect(
                await browser.context
                  .pages()
                  .then((pages) =>
                    pages
                      .at(-1)!
                      .evaluate(
                        () =>
                          document.querySelector('#assignment')?.textContent,
                      ),
                  ),
              ).toBe('Biology worksheet due tomorrow');
              expect(
                await browser.context
                  .pages()
                  .then(async (pages) =>
                    pages
                      .at(-1)!
                      .evaluate(
                        () => getComputedStyle(document.body).backgroundColor,
                      ),
                  ),
              ).toBe('rgb(1, 2, 3)');
              const parentPage = (await browser.context.pages()).at(-1)!;
              await parentPage.locator('#open-popup').click();
              expect(
                await parentPage.evaluate(
                  () => document.body.dataset.popupClick,
                ),
              ).toBe('trusted');
              const pageIds = (await browser.context.pages()).map(
                (page) => page.pageId,
              );
              await parentPage.waitForTimeout(500);
              expect(
                (await browser.context.pages()).map((page) => page.pageId),
              ).toEqual(pageIds);
              for (const popup of await browser.context.pages())
                if ((await popup.url()).endsWith('/popup')) await popup.close();
              if (!context.entries.some((entry) => entry.role === 'course'))
                return false;
              const before = (await browser.context.pages()).length;
              await context.withCoursePage(
                `${origin}/course/1`,
                async (course) => {
                  const pdf = await course.downloadPdf(
                    course.observed!,
                    pdfUrl,
                  );
                  expect(pdf.status).toBe('complete');
                  if (pdf.status === 'complete') {
                    expect(new TextDecoder().decode(pdf.bytes)).toBe(pdfBytes);
                    expect(pdf.url).toBe(pdfUrl);
                  }
                },
              );
              expect(pdfReads).toBeGreaterThan(0);
              expect(
                pdfRequestCookies.every((cookie) =>
                  cookie.includes('fixture-session=ready'),
                ),
              ).toBe(true);
              let entered = 0;
              let release!: () => void;
              const gate = new Promise<void>((resolve) => {
                release = resolve;
              });
              const workers = Promise.all(
                [1, 2].map(() =>
                  context.withCoursePage(
                    `${origin}/course/1`,
                    async (worker) => {
                      expect(worker.observed?.url).toBe(`${origin}/course/1`);
                      worker.assertReadable();
                      entered += 1;
                      await gate;
                    },
                  ),
                ),
              );
              try {
                await vi.waitFor(() => expect(entered).toBe(2), {
                  timeout: 15000,
                });
                expect((await browser.context.pages()).length).toBe(before + 2);
              } finally {
                release();
                await workers;
              }
              expect((await browser.context.pages()).length).toBe(before);
              return true;
            },
          });
          expect(
            result.outcome,
            JSON.stringify({
              result,
              pickerVisits,
              accountSelections,
              assetReads: [...assetReads],
            }),
          ).toBe('courses');
          expect(result.entries).toContainEqual(
            expect.objectContaining({
              url: `${origin}/course/1`,
              role: 'course',
            }),
          );
          expect(result.followed).toBe(true);
        }
        expect(accountSelections).toBe(forcePicker ? 2 : 1);
        expect(pickerVisits).toBeGreaterThan(0);
        expect(bannerReads).toBeGreaterThan(0);
        expect(blockedFrameWrites).toBeGreaterThan(0);
        expect(assignmentReads).toEqual(
          new Set([
            '/home/upcoming_submissions_ajax',
            '/home/overdue_submissions_ajax',
          ]),
        );
        expect(assetReads).toEqual(
          new Set(['/site.css', '/s_grade_item_add_form.js', '/frame.js']),
        );
      } finally {
        vi.unstubAllGlobals();
        await compatibilityStagehand?.close().catch(() => undefined);
        await browser.close();
        try {
          await vi.waitFor(
            async () =>
              expect(await isChromeDebuggingPortAvailable(port)).toBe(false),
            { interval: 100, timeout: 5000 },
          );
        } finally {
          await rm(profile, { recursive: true, force: true });
        }
      }
    },
    120_000,
  );
});
