import { missionTraffic } from './mission-traffic';
import { readPageEvidence } from './page-evidence';
import type { Page } from '@browserbasehq/stagehand';
import { academicPageIdentity, isReadNavigation } from '../lib/browser-policy';

export const readPage = async (page: Page, fullContent = false) => {
  const snapshot = await page.evaluate((readAll: boolean) => {
    const content = readAll
      ? document.body
      : ([
          ...document.querySelectorAll<HTMLElement>(
            'main, [role="main"], #content',
          ),
        ].find((element) => (element.innerText ?? '').trim().length > 0) ??
        document.body);
    return {
      url: location.href,
      title: document.title,
      // innerText keeps hidden and script content out of model context.
      text: readAll
        ? content.innerText.replace(/\s+/g, ' ').trim()
        : content.innerText.replace(/\s+/g, ' ').trim().slice(0, 16000),
      links: [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
        .filter((anchor) => !!anchor.getClientRects().length)
        .map((anchor) => ({
          label: (anchor.innerText || anchor.getAttribute('aria-label') || '')
            .trim()
            .slice(0, 300),
          url: anchor.href,
          // Nearby list or card text distinguishes a course from a menu item.
          context: (
            anchor.closest<HTMLElement>(
              'li, tr, [role="listitem"], [aria-label]',
            )?.innerText ?? ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200),
        }))
        .filter((link) => link.label),
      password: !!document.querySelector('input[type="password"]'),
      error: !!document.querySelector(
        '#main-frame-error, #sub-frame-error, .neterror',
      ),
    };
  }, fullContent);
  // Identity is sanitized here, outside the page, so evidence, source checks,
  // and persistence all agree on which page was observed.
  const identity = academicPageIdentity(snapshot.url);
  if (!identity) throw new Error('This page cannot be read safely.');
  missionTraffic.assertPageContent(identity, snapshot.text);
  return {
    ...snapshot,
    password: snapshot.password
      ? (await readPageEvidence(page)).hasPasswordField
      : false,
    url: identity,
    linksTruncated: !fullContent && snapshot.links.length > 300,
    links: (fullContent ? snapshot.links : snapshot.links.slice(0, 300)).filter(
      (link) => {
        try {
          return isReadNavigation(link.url, [new URL(link.url).hostname]);
        } catch {
          return false;
        }
      },
    ),
  };
};

// Prepare only a course disclosure, then use real browser input to open it.
export const revealCourseNavigation = async (
  page: Page,
  scope: 'courses' | 'content' = 'courses',
) => {
  const outcome = await page.evaluate((mode: string) => {
    const affordance =
      /^(?:(?:view|show|open|browse)\s+)?(?:(?:all|my|your|current|active)\s+)?(?:courses|classes|sections|(?:course|class)\s+(?:list|dashboard))$/i;
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        ':is(button, [role="button"], [role="tab"]):not([aria-expanded="true"]), :is(nav, [role="navigation"], header, [role="banner"]) a[href^="#"]:not([aria-expanded="true"])',
      ),
    ];
    const target = controls.find((control) => {
      const name = (
        control.getAttribute('aria-label') ||
        control.innerText ||
        control.textContent ||
        ''
      ).trim();
      const contentControl =
        /^(?:(?:view|show|open|all)\s+)?(?:assignments|announcements|classwork|homework|modules|materials|content|folders|load more|show more|next page)$/i.test(
          name.replace(/\s+/g, ' '),
        ) ||
        (control.getAttribute('aria-expanded') === 'false' &&
          !!control.getAttribute('aria-controls'));
      return (
        (mode === 'content'
          ? contentControl &&
            !control.hasAttribute('data-scholaros-content-opened') &&
            control.getAttribute('aria-selected') !== 'true'
          : affordance.test(name.replace(/\s+/g, ' '))) &&
        !control.hasAttribute('disabled') &&
        !control.closest('[hidden], [inert]') &&
        getComputedStyle(control).display !== 'none' &&
        getComputedStyle(control).visibility !== 'hidden'
      );
    });
    if (!target) return 'not-found';
    if (
      (target as HTMLButtonElement).form ||
      target.closest('form') ||
      (target.tagName === 'A' &&
        !!target.getAttribute('href') &&
        !target.getAttribute('href')!.startsWith('#')) ||
      target.getAttribute('type') === 'submit' ||
      target.dataset.action
    )
      return 'refused';
    if (
      mode === 'content' &&
      !/^(?:(?:load|show) more|next page)$/i.test(
        (
          target.getAttribute('aria-label') ||
          target.innerText ||
          target.textContent ||
          ''
        ).trim(),
      )
    )
      target.setAttribute('data-scholaros-content-opened', '');
    document
      .querySelector('[data-scholaros-course-menu]')
      ?.removeAttribute('data-scholaros-course-menu');
    target.setAttribute('data-scholaros-course-menu', '');
    return 'opened';
  }, scope);
  if (outcome === 'opened') {
    await page.locator('[data-scholaros-course-menu]').click({ timeout: 2000 });
    // Opening the menu can start the request that supplies the course links.
    await page.waitForLoadState('networkidle', 6000).catch(() => undefined);
  }
  return outcome;
};
