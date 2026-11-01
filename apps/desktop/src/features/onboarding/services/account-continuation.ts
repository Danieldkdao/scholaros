import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from '@browserbasehq/stagehand';
import { isAcademicUrl, isReadNavigation } from '../lib/browser-policy';
import { isSignInPage } from '../lib/connection-policy';

const accountPickerMessage =
  'Sign in manually in your study browser, or specify one account to choose in this resource’s notes.';
const credentialMessage =
  'This resource needs you to sign in manually in your study browser.';

export class AccountContinuationError extends Error {}

const accountFromNotes = (specific: string | null, general: string) => {
  const notes =
    specific && /\b(?:choose|select|use|click)\b|@/i.test(specific)
      ? specific
      : general;
  const instructions = notes
    .split(/[;\n,]|\.\s+/)
    .filter(
      (instruction) =>
        /\b(?:choose|select|use|click)\b/i.test(instruction) &&
        !/\b(?:not|never|avoid|except|unless|don['’]t|besides|other than|but)\b/i.test(
          instruction,
        ),
    );
  const emails = [
    ...new Set(
      instructions
        .join(' ')
        .toLowerCase()
        .match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g),
    ),
  ];
  return emails.length === 1 ? emails[0] : null;
};

// This function is serialized into the browser; all DOM checks stay inside it.
const inspectPicker = ({
  email,
  prepare,
  expectedUrl,
}: {
  email: string | null;
  prepare: boolean;
  expectedUrl: string;
}) => {
  // Google updates fragments without updating Stagehand's cached document URL.
  if (location.href.split('#')[0] !== expectedUrl.split('#')[0]) return 'stale';
  const visible = (element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    if (
      !box.width ||
      !box.height ||
      element.closest('[hidden], [inert]') ||
      getComputedStyle(element).visibility !== 'visible'
    )
      return false;
    for (
      let parent: HTMLElement | null = element;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      if (
        style.display === 'none' ||
        style.opacity === '0' ||
        style.contentVisibility === 'hidden'
      )
        return false;
    }
    return true;
  };
  // Account pickers include language selectors; only editable fields require manual sign-in.
  if (
    [
      ...document.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]',
      ),
    ].some(visible)
  )
    return 'credentials';
  const accounts = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-identifier], button[data-email], a[data-email], [role="button"], [role="link"]',
    ),
  ].filter(visible);
  const offered = accounts.filter((element) => {
    const identifier = (
      element.getAttribute('data-identifier') ??
      element.getAttribute('data-email') ??
      element.innerText
    )
      .trim()
      .toLowerCase();
    const emails =
      identifier.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
    return (
      emails.length === 1 &&
      !accounts.some(
        (other) =>
          other !== element &&
          element.contains(other) &&
          /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(
            other.getAttribute('data-identifier') ??
              other.getAttribute('data-email') ??
              other.innerText,
          ),
      )
    );
  });
  if (!offered.length) return 'waiting';
  const matches = offered.filter((element) => {
    const identifier = (
      element.getAttribute('data-identifier') ??
      element.getAttribute('data-email') ??
      element.innerText
    ).toLowerCase();
    return (
      email &&
      (identifier.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []).some(
        (value) => value === email,
      )
    );
  });
  if (matches.length !== 1) return 'unmatched';
  const target =
    matches[0].closest<HTMLElement>(
      '[role="link"], [role="button"], a, button',
    ) ?? matches[0];
  if (
    /\b(?:signed out|logged out|sign in)\b/i.test(target.innerText) ||
    target.getAttribute('aria-disabled') === 'true' ||
    target.hasAttribute('disabled')
  )
    return 'credentials';
  if (prepare && email)
    target.setAttribute('data-scholaros-account-choice', email);
  return 'selected';
};

export const createAccountContinuation = (
  host: string,
  notes: string | null,
  generalNotes: string,
) => {
  const email = accountFromNotes(notes, generalNotes);
  let selected = false;
  let selections = 0;
  let lastSelectionAt = 0;
  let documents = 0;
  const isAuthenticationUrl = (value: string) => {
    if (!isAcademicUrl(value)) return false;
    const url = new URL(value);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    if (
      pathname.includes('%') ||
      /(?:^|[/_-])(?:logout|signout|revoke|delete|remove|register|signup)(?:$|[/_-])/i.test(
        pathname,
      ) ||
      [...url.searchParams.keys()].some((key) =>
        /^(?:action|operation|cmd|command|method|do)$/i.test(key),
      )
    )
      return false;
    if (url.hostname === host) return isSignInPage(host, pathname);
    if (
      host.endsWith('.schoology.com') &&
      url.hostname === 'app.schoology.com' &&
      /^\/login\/external_accounts\/receive\/google_apps\/?$/.test(pathname)
    )
      return true;
    return (
      url.hostname === 'accounts.google.com' &&
      /^\/(?:InteractiveLogin(?:\/)?$|AccountChooser|ServiceLogin|CheckCookie|(?:v\d+\/)?signin(?:\/|$)|o\/(?:oauth2|saml2)(?:\/|$))/i.test(
        pathname,
      )
    );
  };
  return {
    domains: [
      'accounts.google.com',
      ...(host.endsWith('.schoology.com') ? ['app.schoology.com'] : []),
    ],
    isAuthenticationUrl,
    allowRequest: (
      event: { request: { url: string; method: string }; resourceType: string },
      mainFrame: boolean,
    ) => {
      if (!isAuthenticationUrl(event.request.url)) return false;
      const url = new URL(event.request.url);
      if (
        event.resourceType === 'Document' &&
        mainFrame &&
        event.request.method === 'GET'
      )
        return ++documents <= 20;
      if (
        event.request.method === 'GET' &&
        ['Script', 'Stylesheet', 'Font', 'Image', 'Media'].includes(
          event.resourceType,
        )
      )
        return true;
      return (
        selected &&
        url.hostname === 'accounts.google.com' &&
        event.request.method === 'POST' &&
        ['XHR', 'Fetch'].includes(event.resourceType) &&
        /^\/(?:v\d+\/)?signin\/_\/AccountsSignInUi\/data\/batchexecute$/.test(
          url.pathname,
        )
      );
    },
    resume: async (
      page: Page,
      signal: AbortSignal,
      isCurrent: () => boolean = () => true,
    ) => {
      const deadline = Date.now() + 15_000;
      let emptyPolls = 0;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        const url = await page.url();
        if (isReadNavigation(url, [host])) {
          selected = false;
          return;
        }
        if (!isAuthenticationUrl(url))
          throw new AccountContinuationError(credentialMessage);
        const result = await page.evaluate(inspectPicker, {
          email,
          prepare: false,
          expectedUrl: url,
        });
        signal.throwIfAborted();
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        if (result === 'credentials')
          throw new AccountContinuationError(credentialMessage);
        if (result === 'unmatched')
          throw new AccountContinuationError(accountPickerMessage);
        // A cold picker can render before its click handlers are ready.
        if (
          result === 'selected' &&
          (!selected ||
            (selections < 3 && Date.now() - lastSelectionAt >= 1500))
        ) {
          if (++selections > 3)
            throw new AccountContinuationError(credentialMessage);
          selected = true;
          lastSelectionAt = Date.now();
          const prepared = await page.evaluate(inspectPicker, {
            email,
            prepare: true,
            expectedUrl: url,
          });
          if (prepared !== 'selected') {
            selected = false;
            throw new AccountContinuationError(credentialMessage);
          }
          signal.throwIfAborted();
          if (!isCurrent())
            throw new Error('Your session changed; sign in again.');
          await page
            .locator(`[data-scholaros-account-choice="${email}"]`)
            .click({ timeout: 2000 });
        } else if (result === 'waiting' && ++emptyPolls >= 40)
          throw new AccountContinuationError(credentialMessage);
        await delay(150, undefined, { signal });
      }
      throw new AccountContinuationError(credentialMessage);
    },
  };
};

export type AccountContinuation = ReturnType<typeof createAccountContinuation>;
