import { configureBrowserPolicy } from '../lib/browser-policy';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  academicPageIdentity,
  isCourseNavigationTarget,
  isAcademicUrl,
  isReadNavigation,
  isReadOnlyEmbed,
  hasCourseRouteIdentity,
  safeAcademicUrlPath,
} from '../lib/browser-policy';

const schoology = 'usd497.schoology.com';
const canvas = 'canvas.school.edu';
const classroom = 'classroom.google.com';
const portal = 'portal.example.edu';

const readOn = (host: string, value: string) => isReadNavigation(value, [host]);

describe('academic url eligibility', () => {
  it.each([
    'file:///etc/passwd',
    'http://localhost:3000',
    'https://127.0.0.1',
    'https://192.168.1.1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/courses',
    'javascript:alert(1)',
    'https://user:pass@school.edu',
    'https://school.edu.internal/courses',
  ])('rejects %s', (url) => expect(isAcademicUrl(url)).toBe(false));

  it.each([
    `https://${schoology}/`,
    `https://${canvas}/courses`,
    `https://${portal}/anything/at/all`,
  ])('allows an https page on an academic host: %s', (url) =>
    expect(isAcademicUrl(url)).toBe(true),
  );

  it('requires an exact approved host', () => {
    expect(readOn(canvas, `https://${canvas}.evil.com/courses`)).toBe(false);
    expect(readOn(schoology, `https://evil.com/?redirect=${schoology}`)).toBe(
      false,
    );
    expect(readOn('school.edu', `https://notschool.edu/`)).toBe(false);
  });
});

describe('connected entry pages are usable on any platform', () => {
  it.each([
    '/',
    '/home_page',
    '/course/12345',
    '/sections/9876',
    '/certificates',
    '/starred',
    '/analytics',
    '/timeline',
  ])('accepts a confirmed academic home or list page: %s', (path) =>
    expect(readOn(schoology, `https://${schoology}${path}`)).toBe(true),
  );

  it.each([
    '/?view=all',
    '/home_page?nav=42',
    '/courses?page=2&per_page=50',
    '/search?q=biology',
  ])('keeps an ordinary query route readable: %s', (path) =>
    expect(readOn(schoology, `https://${schoology}${path}`)).toBe(true),
  );

  it.each(['/#/courses', '/#/course/12345', '/dashboard#/sections/9'])(
    'keeps a single-page app fragment route readable: %s',
    (path) =>
      expect(readOn(schoology, `https://${schoology}${path}`)).toBe(true),
  );

  it.each([
    '/c/abc123',
    '/u/0/c/abc123',
    '/courses/1/announcements',
    '/courses/1/pages/additional-reading',
    '/courses/1/pages/poster-session',
    '/grades',
  ])('still allows known course and page reads: %s', (path) =>
    expect(readOn(classroom, `https://${classroom}${path}`)).toBe(true),
  );
});

describe('read-only protections survive generalization', () => {
  it('allows a published Slides embed without starting playback', () => {
    expect(
      isReadOnlyEmbed(
        'https://docs.google.com/presentation/d/e/published-deck/pubembed?start=false&loop=false',
      ),
    ).toBe(true);
    expect(
      isReadOnlyEmbed(
        'https://docs.google.com/presentation/d/e/published-deck/pubembed?start=true',
      ),
    ).toBe(false);
  });

  it.each([
    '/logout',
    '/sign-out',
    '/login/cas',
    '/courses/1/quizzes',
    '/courses/1/quizzes/3',
    '/courses/1/assessments',
    '/courses/1/assignments/2/submit',
    '/courses/1/assignments/new',
    '/courses/1/announcements/post',
    '/courses/1/discussions/2/reply',
    '/courses/1/messages/compose',
    '/courses/1/enrollments/drop',
    '/courses/1/unenroll',
    '/profile/edit',
    '/settings',
    '/admin',
    '/courses/1/files/upload',
    '/courses/1/grade_override',
    '/cart/checkout',
  ])('blocks an unsafe action path: %s', (path) =>
    expect(readOn(canvas, `https://${canvas}${path}`)).toBe(false),
  );

  it.each([
    '/courses/1?delete=true',
    '/home_page?action=submit',
    '/courses?redirect_uri=/logout',
    '/pages?id=1&update=true',
    '/home_page?send_message=1',
  ])('blocks an unsafe action parameter: %s', (path) =>
    expect(readOn(canvas, `https://${canvas}${path}`)).toBe(false),
  );

  it.each([
    '/home_page?token=secret',
    '/sso/start?code=abc123',
    '/callback?state=xyz&session=1',
    '/home_page?access_key=longlived',
    '/api?page=1&ticket=TGT-9999',
  ])('blocks a credential-bearing url: %s', (path) =>
    expect(readOn(canvas, `https://${canvas}${path}`)).toBe(false),
  );

  it.each([
    '/courses/1/announcements#submit',
    '/home_page#/logout',
    '/courses#/sections/1/edit',
    '/#compose-message',
  ])('blocks an unsafe action hidden in a fragment: %s', (path) =>
    expect(readOn(canvas, `https://${canvas}${path}`)).toBe(false),
  );

  it.each([
    '/courses/%2e%2e/settings',
    '/courses/1/%2E%2E/messages/compose',
    '/%252e%252e/settings',
    '/%6cogout',
    '/%73ubmit',
    '/%2flist%2flogout',
    '/c%61llback?code=1',
  ])('blocks an encoded or traversing bypass: %s', (path) =>
    expect(readOn(canvas, `https://${canvas}${path}`)).toBe(false),
  );

  it.each([
    'https://portal.example.edu/secure-page',
    'https://portal.example.edu/other',
  ])('stays inside the authorized host: %s', (url) =>
    expect(readOn(portal, url)).toBe(true),
  );
});

describe('Schoology materials identity', () => {
  it.each(['assignments', 'assessments', 'course_assessment'])(
    'equates the observed %s query link with its actual SPA filter destination',
    (filter) => {
      configureBrowserPolicy([]);
      const base = `https://${schoology}/course/12345/materials`;
      expect(academicPageIdentity(`${base}?list_filter=${filter}`)).toBe(
        academicPageIdentity(`${base}#!filter_type=${filter}`),
      );
      expect(
        academicPageIdentity(`${base}?list_filter=${filter}&f=42&page=2`),
      ).toBe(
        academicPageIdentity(`${base}?f=42&page=2#!filter_type=${filter}`),
      );
    },
  );
  it('preserves different courses, filters, folders, pagination, and other query identity', () => {
    const canonical = academicPageIdentity(
      `https://${schoology}/course/12345/materials?list_filter=assignments&f=42&page=2&view=details`,
    );
    for (const change of [
      '/course/99999/materials?f=42&page=2&view=details#!filter_type=assignments',
      '/course/12345/materials?f=42&page=2&view=details#!filter_type=assessments',
      '/course/12345/materials?f=43&page=2&view=details#!filter_type=assignments',
      '/course/12345/materials?f=42&page=3&view=details#!filter_type=assignments',
      '/course/12345/materials?f=42&page=2&view=summary#!filter_type=assignments',
    ]) {
      expect(academicPageIdentity(`https://${schoology}${change}`)).not.toBe(
        canonical,
      );
    }
    expect(
      academicPageIdentity(
        `https://${schoology}/course/12345/materials#!filter_type=assignments&access_token=secret`,
      ),
    ).toBeNull();
    expect(
      academicPageIdentity(
        `https://${portal}/course/12345/materials?list_filter=assignments`,
      ),
    ).not.toBe(
      academicPageIdentity(
        `https://${portal}/course/12345/materials#!filter_type=assignments`,
      ),
    );
  });
  it('ignores only Schoology transient router keys while keeping meaningful SPA routes', () => {
    expect(academicPageIdentity(`https://${schoology}/home#/?_k=abc123`)).toBe(
      academicPageIdentity(`https://${schoology}/home#/?_k=def456`),
    );
    expect(
      academicPageIdentity(
        `https://${schoology}/home#/courses/1?section=A&_k=abc123`,
      ),
    ).not.toBe(
      academicPageIdentity(
        `https://${schoology}/home#/courses/1?section=B&_k=def456`,
      ),
    );
    expect(academicPageIdentity(`https://${portal}/home#/?_k=abc123`)).not.toBe(
      academicPageIdentity(`https://${portal}/home#/?_k=def456`),
    );
  });
});

describe('page identity', () => {
  it('preserves the path, query and fragment that distinguish a page', () => {
    expect(
      academicPageIdentity(`https://${schoology}/home_page?nav=42#/sections/9`),
    ).toBe(`https://${schoology}/home_page?nav=42#/sections/9`);
  });

  it('keeps distinct query routes distinct instead of collapsing them', () => {
    const first = academicPageIdentity(`https://${portal}/search?q=biology`);
    const second = academicPageIdentity(`https://${portal}/search?q=chem`);
    expect(first).not.toBe(second);
  });

  it('drops credential parameters from the persisted identity', () => {
    expect(
      academicPageIdentity(`https://${portal}/home?token=abc&view=all`),
    ).toBe(`https://${portal}/home?view=all`);
  });

  it('normalizes a default document path and rejects unsafe urls', () => {
    expect(academicPageIdentity(`https://${portal}`)).toBe(
      `https://${portal}/`,
    );
    expect(academicPageIdentity('http://portal.example.edu/home')).toBeNull();
    expect(
      academicPageIdentity(`https://${portal}/home?action=delete`),
    ).toBeNull();
  });

  it('gives the same identity a navigation check accepts', () => {
    const url = `https://${schoology}/course/12345?tab=overview`;
    expect(readOn(schoology, url)).toBe(true);
    expect(academicPageIdentity(url)).toBe(url);
  });
});

describe('encoded credential and action boundaries', () => {
  it.each([
    '/#/courses?access_token=secret',
    '/?%2574oken=secret',
    '/deleteCourse/123',
    '/?action=deleteCourse',
  ])('refuses %s', (path) => {
    expect(
      isReadNavigation(`https://school.example${path}`, ['school.example']),
    ).toBe(false);
  });
  it('never persists credentials from a fragment or encoded key', () => {
    expect(
      academicPageIdentity(
        'https://school.example/#/courses?access_token=secret',
      ),
    ).toBeNull();
    expect(
      academicPageIdentity('https://school.example/?%2574oken=secret'),
    ).not.toContain('secret');
  });
});

it('refuses unknown action selectors while permitting explicit read operations', () => {
  expect(
    isReadNavigation('https://school.example/api?action=doSomething', [
      'school.example',
    ]),
  ).toBe(false);
  expect(
    isReadNavigation('https://school.example/api?action=listCourses', [
      'school.example',
    ]),
  ).toBe(true);
  for (const action of ['list', 'read', 'get']) {
    expect(
      isReadNavigation(`https://school.example/api?action=${action}`, [
        'school.example',
      ]),
    ).toBe(true);
  }
});

beforeEach(() =>
  configureBrowserPolicy([
    'accept',
    'add',
    'admin',
    'assessment',
    'assessments',
    'authenticate',
    'callback',
    'cancel',
    'cas',
    'checkout',
    'comment',
    'compose',
    'confirm',
    'create',
    'decline',
    'delete',
    'destroy',
    'discard',
    'drop',
    'edit',
    'enroll',
    'enrollment',
    'erase',
    'exam',
    'exams',
    'import',
    'inbox',
    'login',
    'logout',
    'logoff',
    'manage',
    'message',
    'messages',
    'new',
    'oauth',
    'outbox',
    'override',
    'pay',
    'post',
    'preferences',
    'publish',
    'purchase',
    'purge',
    'quiz',
    'quizzes',
    'reject',
    'remove',
    'reply',
    'respond',
    'save',
    'send',
    'settings',
    'signin',
    'signout',
    'submission',
    'submissions',
    'submit',
    'sso',
    'take',
    'update',
    'upload',
    'withdraw',
    'unenroll',
    'dosomething',
  ]),
);

it('allows exam and test preparation URLs by default and applies only user-selected words', () => {
  configureBrowserPolicy([]);
  for (const path of [
    '/courses/1/quizzes',
    '/exams',
    '/assessments',
    '/courses/1/materials/2',
    '/courses/1/assignments/42',
    '/submission',
    '/api?action=listCourses',
  ]) {
    expect(readOn(canvas, `https://${canvas}${path}`)).toBe(true);
  }
  expect(
    readOn(canvas, 'https://canvas.school.edu/api?action=doSomething'),
  ).toBe(false);
  configureBrowserPolicy(['quiz']);
  expect(readOn(canvas, `https://${canvas}/quiz/1`)).toBe(false);
  expect(readOn(canvas, `https://${canvas}/exams`)).toBe(true);
  configureBrowserPolicy([]);
});

describe('mandatory GET mutation protections', () => {
  it.each([
    '/logout',
    '/courses/1/delete',
    '/courses/1/assignments/42/submit',
    '/?action=delete',
    '/api?method=POST',
    '/api?cmd=remove',
    '/api?op=unknown',
    '/api?task=unknown',
    '/api?action=unknownOperation',
  ])(
    'blocks destructive or uncertain GET actions without user word blocks: %s',
    (path) => {
      configureBrowserPolicy([]);
      expect(readOn(canvas, `https://${canvas}${path}`)).toBe(false);
    },
  );

  it('keeps read-only action parameters and ordinary assessment pages available', () => {
    configureBrowserPolicy([]);
    expect(
      readOn(canvas, 'https://canvas.school.edu/api?action=readAssignments'),
    ).toBe(true);
    expect(
      readOn(canvas, 'https://canvas.school.edu/api?task=listCourses'),
    ).toBe(true);
    expect(readOn(canvas, 'https://canvas.school.edu/courses/1/exams/2')).toBe(
      true,
    );
    expect(
      readOn(canvas, 'https://canvas.school.edu/courses/1/quizzes/3'),
    ).toBe(true);
  });
});

describe('course membership evidence', () => {
  it('distinguishes a course-list route from a course-specific route', () => {
    expect(hasCourseRouteIdentity('https://canvas.school.edu/courses')).toBe(
      false,
    );
    expect(
      hasCourseRouteIdentity('https://canvas.school.edu/course?id=101'),
    ).toBe(true);
    expect(
      hasCourseRouteIdentity(
        'https://canvas.school.edu/courses/101/assignments?courseId=202',
      ),
    ).toBe(true);
    expect(
      hasCourseRouteIdentity(
        'https://canvas.school.edu/courses/101/assignments',
      ),
    ).toBe(true);
  });

  it('omits credential-bearing route segments from diagnostics', () => {
    expect(
      safeAcademicUrlPath('https://canvas.school.edu/courses/101/analytics'),
    ).toBe('/courses/101/analytics');
    expect(
      safeAcademicUrlPath(
        'https://canvas.school.edu/courses/101/ticket/secret',
      ),
    ).toBeNull();
  });

  const scope = {
    courseUrl: 'https://canvas.school.edu/courses/101',
    observedResourceRelationships: [
      {
        parentUrl: 'https://canvas.school.edu/courses/101/modules',
        targetUrl: 'https://docs.example.edu/biology/lab-guide',
      },
    ],
  } as const;

  it('allows the verified course tree and resources observed from it', () => {
    expect(
      isCourseNavigationTarget(
        'https://canvas.school.edu/courses/101/assignments',
        scope,
        ['canvas.school.edu', 'docs.example.edu'],
      ),
    ).toBe(true);
    expect(
      isCourseNavigationTarget(
        'https://docs.example.edu/biology/lab-guide',
        scope,
        ['canvas.school.edu', 'docs.example.edu'],
      ),
    ).toBe(true);
  });

  it('rejects same-host sibling courses and unproven direct, cached, or redirect URLs', () => {
    for (const url of [
      'https://canvas.school.edu/courses/202/assignments',
      'https://canvas.school.edu/courses/303/assignments',
      'https://canvas.school.edu/courses/101/assignments?courseId=202',
      'https://docs.example.edu/biology/other-course',
    ])
      expect(
        isCourseNavigationTarget(url, scope, [
          'canvas.school.edu',
          'docs.example.edu',
        ]),
      ).toBe(false);
  });

  it('rejects query-identified sibling course pages at shared paths', () => {
    const queryScope = {
      ...scope,
      courseUrl: 'https://canvas.school.edu/course?id=101',
    };
    expect(
      isCourseNavigationTarget(
        'https://canvas.school.edu/course?id=202',
        queryScope,
        ['canvas.school.edu'],
      ),
    ).toBe(false);
  });

  it('requires an observed reachable parent for external resource relationships', () => {
    expect(
      isCourseNavigationTarget(
        'https://docs.example.edu/biology/lab-guide',
        {
          ...scope,
          observedResourceRelationships: [
            {
              parentUrl: 'https://canvas.school.edu/courses/202',
              targetUrl: 'https://docs.example.edu/biology/lab-guide',
            },
          ],
        },
        ['canvas.school.edu', 'docs.example.edu'],
      ),
    ).toBe(false);
  });
});
