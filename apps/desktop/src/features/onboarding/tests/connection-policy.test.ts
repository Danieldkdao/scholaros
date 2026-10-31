import { configureBrowserPolicy } from '../lib/browser-policy';
import { beforeEach, describe, expect, it } from 'vitest';
import { classifyCapturedPage, isSignInPage } from '../lib/connection-policy';

const canvasEvidence = {
  origin: 'https://canvas.school.edu',
  host: 'canvas.school.edu',
  pathname: '/courses',
  href: 'https://canvas.school.edu/courses',
  title: 'Dashboard',
  hasPasswordField: false,
  hasCanvasMarkers: true,
  courseLinkCount: 4,
};

describe('academic connection classification', () => {
  it('verifies Canvas only when course evidence is present', () => {
    expect(classifyCapturedPage(canvasEvidence)).toMatchObject({
      kind: 'canvas',
      status: 'verified',
      url: 'https://canvas.school.edu/courses',
    });
  });

  it('accepts a Schoology home page as a connectable academic resource', () => {
    expect(
      classifyCapturedPage({
        origin: 'https://usd497.schoology.com',
        host: 'usd497.schoology.com',
        pathname: '/',
        href: 'https://usd497.schoology.com/',
        title: 'Home | Schoology',
        hasPasswordField: false,
        hasCanvasMarkers: false,
        courseLinkCount: 0,
      }),
    ).toMatchObject({
      kind: 'resource',
      status: 'needs-sign-in',
      url: 'https://usd497.schoology.com/',
      name: 'Home | Schoology',
    });
  });

  it('does not verify a Canvas host without course evidence', () => {
    expect(
      classifyCapturedPage({
        ...canvasEvidence,
        hasCanvasMarkers: false,
        courseLinkCount: 0,
      }),
    ).toMatchObject({ kind: 'canvas', status: 'needs-sign-in' });
  });

  it('does not verify a generic academic site automatically', () => {
    expect(
      classifyCapturedPage({
        ...canvasEvidence,
        origin: 'https://library.school.edu',
        host: 'library.school.edu',
        pathname: '/research',
        href: 'https://library.school.edu/research',
        hasCanvasMarkers: false,
        courseLinkCount: 0,
      }),
    ).toMatchObject({ kind: 'resource', status: 'needs-sign-in' });
  });

  it('distinguishes Google Classroom from Canvas', () => {
    expect(
      classifyCapturedPage({
        ...canvasEvidence,
        origin: 'https://classroom.google.com',
        host: 'classroom.google.com',
        pathname: '/c/abc123',
        href: 'https://classroom.google.com/c/abc123',
        hasCanvasMarkers: false,
        courseLinkCount: 0,
      }),
    ).toMatchObject({ kind: 'classroom', status: 'needs-sign-in' });
  });

  it.each([{ pathname: '/login' }, { hasPasswordField: true }])(
    'refuses to connect a sign-in page: %o',
    (change) => {
      expect(() =>
        classifyCapturedPage({ ...canvasEvidence, ...change }),
      ).toThrow(
        'Finish signing in, then open your course dashboard before connecting this site.',
      );
    },
  );

  it.each([
    {
      name: 'a query route',
      href: 'https://portal.example.edu/search?q=biology',
      pathname: '/search',
      expected: 'https://portal.example.edu/search?q=biology',
    },
    {
      name: 'a single-page app fragment',
      href: 'https://portal.example.edu/#/courses',
      pathname: '/',
      expected: 'https://portal.example.edu/#/courses',
    },
    {
      name: 'a Schoology dashboard query',
      href: 'https://usd497.schoology.com/home_page?nav=42',
      pathname: '/home_page',
      expected: 'https://usd497.schoology.com/home_page?nav=42',
    },
  ])(
    'persists the identity that distinguishes $name',
    ({ href, pathname, expected }) => {
      expect(
        classifyCapturedPage({
          ...canvasEvidence,
          origin: new URL(href).origin,
          host: new URL(href).hostname,
          pathname,
          href,
          hasCanvasMarkers: false,
          courseLinkCount: 0,
        }).url,
      ).toBe(expected);
    },
  );

  it('drops credential parameters before persisting a connection', () => {
    expect(
      classifyCapturedPage({
        ...canvasEvidence,
        pathname: '/home_page',
        href: 'https://canvas.school.edu/home_page?token=abc&view=all',
      }).url,
    ).toBe('https://canvas.school.edu/home_page?view=all');
  });

  it.each([
    {
      pathname: '/course/1/submit',
      href: 'https://canvas.school.edu/course/1/submit',
    },
    {
      pathname: '/dashboard',
      href: 'https://canvas.school.edu/dashboard?action=delete',
    },
  ])('refuses to connect an action url: %o', ({ pathname, href }) => {
    expect(() =>
      classifyCapturedPage({ ...canvasEvidence, pathname, href }),
    ).toThrow('open your course dashboard');
  });
});

it('accepts a Khan Academy learner dashboard beneath a profile route', () => {
  expect(
    classifyCapturedPage({
      ...canvasEvidence,
      origin: 'https://www.khanacademy.org',
      host: 'www.khanacademy.org',
      pathname: '/profile/student/courses',
      href: 'https://www.khanacademy.org/profile/student/courses',
      title: 'Learner home | Khan Academy',
      hasCanvasMarkers: false,
      courseLinkCount: 0,
    }),
  ).toMatchObject({ host: 'www.khanacademy.org', kind: 'resource' });
});

it.each(['/lessons/algebra', '/courses/sso101', '/courses/authorization'])(
  'does not mistake a content path for sign-in: %s',
  (path) => {
    expect(isSignInPage('school.edu', path)).toBe(false);
  },
);

it.each(['/login', '/auth/sign-in', '/oauth/authorize', '/%6cogin'])(
  'recognizes a sign-in route: %s',
  (path) => {
    expect(isSignInPage('school.edu', path)).toBe(true);
  },
);

beforeEach(() => configureBrowserPolicy(['submit', 'delete']));
