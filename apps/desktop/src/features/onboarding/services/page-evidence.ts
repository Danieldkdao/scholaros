import type { Page } from '@browserbasehq/stagehand';

// The probe runs inside the page, so everything it needs has to stay inline.
export const readPageEvidence = (page: Page) =>
  page.evaluate(() => ({
    origin: location.origin,
    host: location.hostname,
    pathname: location.pathname,
    href: location.href,
    title: document.title,
    // Only a sign-in field the student can actually see means they are still
    // signed out: password managers and pre-rendered auth modals leave hidden
    // zero-size inputs behind on signed-in dashboards.
    hasPasswordField: [
      ...document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    ].some((field) => {
      const box = field.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || field.closest('[hidden]'))
        return false;
      if (getComputedStyle(field).visibility !== 'visible') return false;
      for (
        let element: Element | null = field;
        element;
        element = element.parentElement
      ) {
        const style = getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.opacity === '0' ||
          style.contentVisibility === 'hidden'
        )
          return false;
      }
      return true;
    }),
    hasCanvasMarkers: !!document.querySelector(
      '.ic-DashboardCard, #dashboard-activity, #course_home_content',
    ),
    courseLinkCount: [
      ...document.querySelectorAll<HTMLAnchorElement>('a[href]'),
    ].filter((anchor) => /^\/courses\/\d+/.test(new URL(anchor.href).pathname))
      .length,
    // The link href is already resolved to an absolute address by the browser.
    icon:
      document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href ??
      null,
  }));
