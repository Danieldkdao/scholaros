// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAccountContinuation } from '../services/account-continuation';

const host = 'school.example.edu';
const email = 'student@school.example.edu';
const pickerUrl = 'https://accounts.google.com/v3/signin/accountchooser';
const notes = `If an account picker appears, choose ${email}.`;
const signal = () => new AbortController().signal;
const page = {
  url: async () => location.href,
  evaluate: async (read: (...args: never[]) => unknown, input: never) =>
    read(input),
  locator: (selector: string) => ({
    click: async () => {
      document.querySelector<HTMLElement>(selector)!.click();
    },
  }),
};
const picker = () => {
  vi.stubGlobal('location', new URL(pickerUrl));
  document.body.innerHTML = `<div role="link" data-identifier="personal@example.com">Personal personal@example.com</div><div role="link" data-identifier="${email}">Student ${email}</div>`;
};
const continuation = (specific: string | null = notes, general = '') =>
  createAccountContinuation(host, specific, general);

beforeEach(() => {
  picker();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
    height: 30,
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent ?? '';
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('selects only the existing account named in resource notes and returns to the resource', async () => {
  const selected = vi.fn(() =>
    vi.stubGlobal('location', new URL(`https://${host}/courses`)),
  );
  document
    .querySelector(`[data-identifier="${email}"]`)!
    .addEventListener('click', selected);
  await continuation().resume(page as never, signal());
  expect(selected).toHaveBeenCalledOnce();
});

it('uses a browser input click for the selected account instead of a synthetic DOM click', async () => {
  const returnToResource = () =>
    vi.stubGlobal('location', new URL(`https://${host}/courses`));
  document
    .querySelector(`[data-identifier="${email}"]`)!
    .addEventListener('click', returnToResource);
  const click = vi.fn(async () => returnToResource());
  const locator = vi.fn(() => ({ click }));
  await continuation().resume({ ...page, locator } as never, signal());
  expect(locator).toHaveBeenCalledOnce();
  expect(click).toHaveBeenCalledOnce();
});

it('selects the account when Google adds a fragment missing from the cached page URL', async () => {
  vi.stubGlobal('location', new URL(`${pickerUrl}#identifier`));
  const selected = vi.fn(() =>
    vi.stubGlobal('location', new URL(`https://${host}/courses`)),
  );
  document
    .querySelector('[data-identifier="' + email + '"]')!
    .addEventListener('click', selected);
  await continuation().resume(
    {
      ...page,
      url: async () => location.href.split('#')[0],
      evaluate: async (read: (...args: never[]) => unknown, input: never) => {
        const result = read(input);
        if (result === 'stale')
          throw new Error(
            'A hash-only URL change rejected the account picker.',
          );
        return result;
      },
    } as never,
    signal(),
  );
  expect(selected).toHaveBeenCalledOnce();
});

it('keeps a matching account row when it contains a child options button', async () => {
  document.body.innerHTML = `<div role="link" data-identifier="${email}">Student ${email}<div role="button" aria-label="Account options"></div></div>`;
  const selected = vi.fn(() =>
    vi.stubGlobal('location', new URL(`https://${host}/courses`)),
  );
  document
    .querySelector('[data-identifier]')!
    .addEventListener('click', selected);
  await continuation().resume(page as never, signal());
  expect(selected).toHaveBeenCalledOnce();
});

it.each([
  `Do not enter passwords; choose ${email}.`,
  `Do not choose personal@example.com; choose ${email} instead.`,
])(
  'uses the positive account instruction without confusing separate cautions: %s',
  async (specific) => {
    const selected = vi.fn(() =>
      vi.stubGlobal('location', new URL(`https://${host}/courses`)),
    );
    document
      .querySelector(`[data-identifier="${email}"]`)!
      .addEventListener('click', selected);
    await continuation(specific).resume(page as never, signal());
    expect(selected).toHaveBeenCalledOnce();
  },
);

it('treats nested account identifiers as one clickable account row', async () => {
  document.body.innerHTML = `<div role="link"><div data-identifier="${email}">Student ${email}</div></div>`;
  const selected = vi.fn(() =>
    vi.stubGlobal('location', new URL(`https://${host}/courses`)),
  );
  document.querySelector('[role="link"]')!.addEventListener('click', selected);
  await continuation().resume(page as never, signal());
  expect(selected).toHaveBeenCalledOnce();
});

it('does not override an ambiguous resource-specific account mention with general notes', async () => {
  document
    .querySelector(`[data-identifier="${email}"]`)!
    .addEventListener('click', () =>
      vi.stubGlobal('location', new URL(`https://${host}/courses`)),
    );
  await expect(
    continuation('My account is teacher@school.example.edu.', notes).resume(
      page as never,
      signal(),
    ),
  ).rejects.toThrow(/notes/i);
});

it('rechecks the page before clicking if credential inputs appear after inspection', async () => {
  const evaluate = vi.fn(
    async (read: (...args: never[]) => unknown, input: never) => {
      if (evaluate.mock.calls.length === 2)
        document.body.insertAdjacentHTML(
          'beforeend',
          '<input type="password">',
        );
      return read(input);
    },
  );
  const click = vi.spyOn(HTMLElement.prototype, 'click');
  await expect(
    continuation().resume({ ...page, evaluate } as never, signal()),
  ).rejects.toThrow(/sign in manually/i);
  expect(click).not.toHaveBeenCalled();
});

it('uses a general account instruction when resource notes contain no account instruction', async () => {
  const selected = vi.fn(() =>
    vi.stubGlobal('location', new URL(`https://${host}/courses`)),
  );
  document
    .querySelector(`[data-identifier="${email}"]`)!
    .addEventListener('click', selected);
  await continuation('Look for current courses.', notes).resume(
    page as never,
    signal(),
  );
  expect(selected).toHaveBeenCalledOnce();
});

it.each([
  null,
  'My email is student@school.example.edu.',
  'Never choose student@school.example.edu.',
  'Choose other@school.example.edu.',
  `Choose ${email} or personal@example.com.`,
])(
  'asks for manual sign-in or an account instruction when notes do not identify one offered account: %s',
  async (specific) => {
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    await expect(
      continuation(specific).resume(page as never, signal()),
    ).rejects.toThrow(/sign in manually.*notes/i);
    expect(click).not.toHaveBeenCalled();
  },
);

it.each([
  '<input type="password">',
  '<input type="email">',
  '<input autocomplete="one-time-code">',
  '<textarea></textarea>',
])(
  'never selects an account when the page requires input: %s',
  async (input) => {
    document.body.insertAdjacentHTML('beforeend', input);
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    await expect(
      continuation().resume(page as never, signal()),
    ).rejects.toThrow(/sign in manually/i);
    expect(click).not.toHaveBeenCalled();
  },
);

it('does not let a general note override an unmatched resource-specific account', async () => {
  await expect(
    continuation('Choose teacher@school.example.edu.', notes).resume(
      page as never,
      signal(),
    ),
  ).rejects.toThrow(/notes/i);
});

it('refuses duplicate visible matches instead of guessing', async () => {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<button data-identifier="${email}">${email}</button>`,
  );
  await expect(continuation().resume(page as never, signal())).rejects.toThrow(
    /notes/i,
  );
});

it('refuses a signed-out account even if notes name it', async () => {
  document.querySelector(`[data-identifier="${email}"]`)!.append(' Signed out');
  await expect(continuation().resume(page as never, signal())).rejects.toThrow(
    /sign in manually/i,
  );
});

it('does not inspect account lists on an unrelated host', async () => {
  vi.stubGlobal(
    'location',
    new URL('https://accounts.google.com.evil.example/signin'),
  );
  const evaluate = vi.fn();
  await expect(
    continuation().resume({ ...page, evaluate } as never, signal()),
  ).rejects.toThrow(/sign in manually/i);
  expect(evaluate).not.toHaveBeenCalled();
});

it('checks cancellation before selecting an account', async () => {
  const controller = new AbortController();
  controller.abort();
  const click = vi.spyOn(HTMLElement.prototype, 'click');
  await expect(
    continuation().resume(page as never, controller.signal),
  ).rejects.toThrow();
  expect(click).not.toHaveBeenCalled();
});

it('allows only the authentication redirect and keeps academic writes blocked', () => {
  const session = continuation();
  const request = (
    url: string,
    method = 'GET',
    resourceType = 'Document',
    mainFrame = true,
  ) =>
    session.allowRequest({ request: { url, method }, resourceType }, mainFrame);
  expect(
    request(`https://${host}/login/external_accounts/send/google_apps`),
  ).toBe(true);
  expect(request(pickerUrl)).toBe(true);
  expect(request('https://accounts.google.com/InteractiveLogin')).toBe(true);
  expect(request('https://accounts.google.com/InteractiveLogin/delete')).toBe(
    false,
  );
  expect(request('https://accounts.google.com/InteractiveLoginUntrusted')).toBe(
    false,
  );
  expect(request(pickerUrl, 'GET', 'Document', false)).toBe(false);
  expect(request(`https://${host}/assignments/submit`, 'POST')).toBe(false);
  expect(request('https://accounts.google.com/Logout')).toBe(false);
  expect(request('https://accounts.google.com/signin/logout')).toBe(false);
  expect(request(`https://${host}/login/remove`)).toBe(false);
  expect(request(`https://${host}/login?do=delete`)).toBe(false);
  expect(request('https://accounts.google.com/signin/%256Cogout')).toBe(false);
  expect(
    request(
      'https://accounts.google.com/v3/signin/_/AccountsSignInUi/data/batchexecute',
      'POST',
      'XHR',
    ),
  ).toBe(false);
  expect(request('https://unconnected.example/signin')).toBe(false);
});

it('loads read-only picker bootstrap scripts before an account has been chosen', () => {
  const session = continuation();
  expect(
    session.allowRequest(
      {
        request: {
          url: 'https://accounts.google.com/v3/signin/picker.js',
          method: 'GET',
        },
        resourceType: 'Script',
      },
      true,
    ),
  ).toBe(true);
  expect(
    session.allowRequest(
      {
        request: {
          url: 'https://accounts.google.com/v3/signin/picker.js',
          method: 'POST',
        },
        resourceType: 'Script',
      },
      true,
    ),
  ).toBe(false);
});

it('bounds a multi-step authentication flow without rejecting the eleventh document', () => {
  const session = continuation();
  const request = {
    request: { url: pickerUrl, method: 'GET' },
    resourceType: 'Document',
  };
  for (let index = 0; index < 20; index += 1)
    expect(session.allowRequest(request, true)).toBe(true);
  expect(session.allowRequest(request, true)).toBe(false);
});

it('allows the shared Schoology callback only for a Schoology source', () => {
  const callback =
    'https://app.schoology.com/login/external_accounts/receive/google_apps';
  const session = createAccountContinuation(
    'district.schoology.com',
    notes,
    '',
  );
  expect(session.domains).toContain('app.schoology.com');
  expect(
    session.allowRequest(
      { request: { url: callback, method: 'GET' }, resourceType: 'Document' },
      true,
    ),
  ).toBe(true);
  expect(session.isAuthenticationUrl('https://app.schoology.com/courses')).toBe(
    false,
  );
  expect(session.isAuthenticationUrl('https://other.schoology.com/login')).toBe(
    false,
  );
  expect(continuation().isAuthenticationUrl(callback)).toBe(false);
  expect(
    createAccountContinuation(
      'district.schoology.com.evil.example',
      notes,
      '',
    ).isAuthenticationUrl(callback),
  ).toBe(false);
});
