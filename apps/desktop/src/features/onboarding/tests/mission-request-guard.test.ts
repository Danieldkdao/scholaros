import { describe, expect, it, vi } from 'vitest';
import {
  handleMissionRequest,
  type BlockedRequest,
} from '../services/mission-request-guard';

const schoology = 'usd497.schoology.com';
const canvas = 'canvas.school.edu';

const decide = async (
  resourceType: string,
  url: string,
  method = 'GET',
  hosts = [schoology, canvas],
  onBlocked?: (blocked: BlockedRequest) => void,
) => {
  const send = vi.fn(
    async (_method: string, _params: Record<string, unknown>) => ({}),
  );
  const allowed = await handleMissionRequest(
    send,
    hosts,
    { requestId: '1', resourceType, request: { url, method } },
    onBlocked,
  );
  return { allowed, method: send.mock.calls[0]![0] };
};

describe('mission request protections', () => {
  it.each([
    [`https://${schoology}/iapi/course/active`, 'XHR'],
    [`https://${schoology}/home/upcoming_ajax`, 'Fetch'],
    [`https://${schoology}/course/12345/calendar_ajax`, 'XHR'],
    [`https://${canvas}/api/v1/courses/1/assignments`, 'XHR'],
  ])(
    'allows a same-origin read that any platform needs to render: %s',
    async (url, resourceType) => {
      expect((await decide(resourceType, url)).allowed).toBe(true);
    },
  );

  it.each([
    ['POST', `https://${schoology}/dropbox/submit`],
    ['PUT', `https://${schoology}/iapi/grades/grader_grade_data/1`],
    ['DELETE', `https://${schoology}/course/12345`],
    ['PATCH', `https://${schoology}/api/v1/courses/1`],
  ])('blocks a mutating %s request', async (method, url) => {
    const result = await decide('XHR', url, method);
    expect(result.allowed).toBe(false);
    expect(result.method).toBe('Fetch.failRequest');
  });

  it.each([
    [`https://${schoology}/course/12345/submit`, 'XHR'],
    [`https://${schoology}/home_page?token=abc`, 'Fetch'],
    [`https://${schoology}/course/1/enrollments/drop`, 'XHR'],
    [`https://${schoology}/messages/new`, 'XHR'],
  ])('blocks an unsafe data destination: %s', async (url, resourceType) => {
    expect((await decide(resourceType, url)).allowed).toBe(false);
  });

  it.each([
    'https://usentry.io/api/1/envelope/',
    'https://gainsight.example.com/track',
    'https://analytics.example.net/collect',
  ])('blocks a third-party data request: %s', async (url) => {
    expect((await decide('XHR', url)).allowed).toBe(false);
  });

  it.each([
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1:8080/api/courses',
    'https://localhost/internal-api',
    'https://files.internal/api',
  ])('blocks a private network destination: %s', async (url) => {
    expect((await decide('XHR', url)).allowed).toBe(false);
  });

  it.each([
    'https://asset-cdn.schoology.com/theme/bundle.js',
    'https://ui.schoology.com/platform/site-navigation-ui/nav.js',
    'https://assets.powerschool.com/pds/theme.css',
  ])('still loads a passive rendering asset: %s', async (url) => {
    const resourceType = url.endsWith('.css') ? 'Stylesheet' : 'Script';
    expect((await decide(resourceType, url)).allowed).toBe(true);
  });

  it.each([
    [`https://${schoology}/home_page`, 'Document'],
    [`https://other.example.org/home`, 'Document'],
    [`https://${schoology}/logout`, 'Document'],
  ])('applies the navigation policy to documents: %s', async (url, type) => {
    const authorized = url.includes(schoology) && !url.endsWith('/logout');
    expect((await decide(type, url)).allowed).toBe(authorized);
  });

  it('reports what was blocked so discovery can state the limitation', async () => {
    const blocked: BlockedRequest[] = [];
    await decide(
      'XHR',
      'https://usentry.io/api/1/envelope/',
      'POST',
      [schoology],
      (entry) => blocked.push(entry),
    );
    expect(blocked).toEqual([
      { host: 'usentry.io', resourceType: 'XHR', signInWall: false },
    ]);
  });

  it('labels a sign-in redirect as a wall the student can clear', async () => {
    const blocked: BlockedRequest[] = [];
    await decide(
      'Document',
      `https://${schoology}/login/external_accounts/send/google_apps`,
      'GET',
      [schoology],
      (entry) => blocked.push(entry),
    );
    expect(blocked).toEqual([
      { host: schoology, resourceType: 'Document', signInWall: true },
    ]);
  });

  it('does not report allowed requests as blocked', async () => {
    const blocked: unknown[] = [];
    await decide(
      'XHR',
      `https://${schoology}/iapi/course/active`,
      'GET',
      [schoology],
      (entry) => void blocked.push(entry),
    );
    expect(blocked).toEqual([]);
  });
});

describe('passive request actions', () => {
  it.each(['Image', 'Script', 'Font', 'Media', 'Stylesheet'])(
    'blocks an action disguised as %s',
    async (type) => {
      expect((await decide(type, `https://${schoology}/logout`)).allowed).toBe(
        false,
      );
      expect(
        (await decide(type, `https://${schoology}/deleteCourse/123`)).allowed,
      ).toBe(false);
    },
  );
});
