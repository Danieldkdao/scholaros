import { describe, expect, it } from 'vitest';
import {
  academicPageIdentity,
  isAcademicUrl,
  isReadNavigation,
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
});
