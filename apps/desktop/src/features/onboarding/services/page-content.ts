import { missionTraffic } from './mission-traffic';
import type { Page } from '@browserbasehq/stagehand';
import { academicPageIdentity, isReadNavigation } from '../lib/browser-policy';

export const readPage = async (page: Page) => {
  const snapshot = await page.evaluate(() => {
    const content =
      [
        ...document.querySelectorAll<HTMLElement>(
          'main, [role="main"], #content',
        ),
      ].find((element) => (element.innerText ?? '').trim().length > 0) ??
      document.body;
    return {
      url: location.href,
      title: document.title,
      // innerText keeps hidden and script content out of model context.
      text: content.innerText.replace(/\s+/g, ' ').trim().slice(0, 16_000),
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
        .filter((link) => link.label)
        .slice(0, 300),
      password: !!document.querySelector('input[type="password"]'),
      error: !!document.querySelector(
        '#main-frame-error, #sub-frame-error, .neterror',
      ),
    };
  });
  // Identity is sanitized here, outside the page, so evidence, source checks,
  // and persistence all agree on which page was observed.
  const identity = academicPageIdentity(snapshot.url);
  if (!identity) throw new Error('This page cannot be read safely.');
  missionTraffic.assertPageContent(identity, snapshot.text);
  return {
    ...snapshot,
    url: identity,
    links: snapshot.links.filter((link) => {
      try {
        return isReadNavigation(link.url, [new URL(link.url).hostname]);
      } catch {
        return false;
      }
    }),
  };
};

// Course lists hide behind a collapsed nav control. Only a control that already
// declares itself a collapsed disclosure and names courses is toggled; forms,
// submit buttons, and app action hooks are never touched.
export const revealCourseNavigation = async (page: Page) =>
  page.evaluate(() => {
    const affordance =
      /^(?:(?:view|show|open|browse)\s+)?(?:(?:all|my|your|current|active)\s+)?(?:courses|classes|sections|(?:course|class)\s+(?:list|dashboard))$/i;
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        'nav button[aria-expanded="false"], [role="navigation"] button[aria-expanded="false"]',
      ),
    ];
    const target = controls.find((control) => {
      const name = (
        control.textContent ||
        control.getAttribute('aria-label') ||
        ''
      ).trim();
      return (
        affordance.test(name.replace(/\s+/g, ' ')) &&
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
      target.tagName === 'A' ||
      target.getAttribute('type') === 'submit' ||
      target.dataset.action
    )
      return 'refused';
    target.click();
    return 'opened';
  });
