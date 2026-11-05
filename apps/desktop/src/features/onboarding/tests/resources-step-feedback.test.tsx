// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResourcesStep } from '../components/resources-step';

const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock('@scholaros/ui/components/toast', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@scholaros/ui/components/toast',
  );
  const existing = actual.toast as Record<string, unknown>;
  return { ...actual, toast: { ...existing, success: toastSuccess } };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const added = {
  id: 'connection-a',
  name: 'Home | Schoology',
  url: 'https://usd497.schoology.com/',
  host: 'usd497.schoology.com',
  kind: 'resource' as const,
  status: 'confirmed' as const,
  verifiedAt: null,
  notes: null,
  favicon: null,
};

const state = {
  accountId: 'student',
  connections: [],
  settings: {},
  preferences: {},
  discovery: {},
};

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

const step = (scholar: Partial<typeof window.scholar>) => {
  window.scholar = {
    openResource: vi.fn(async () => undefined),
    openStudyBrowser: vi.fn(async () => undefined),
    captureResource: vi.fn(async () => added),
    previewResource: vi.fn(async () => null),
    getState: vi.fn(async () => state),
    ...scholar,
  } as unknown as typeof window.scholar;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(ResourcesStep, {
        state: state as never,
        busy: false,
        // Stands in for useBridgeAction, which reports failures itself.
        run: async (action: () => Promise<void>) => {
          try {
            await action();
          } catch {
            // The step must not surface a rejection of its own.
          }
        },
        update: vi.fn(),
        showConnections: false,
      }),
    );
  });
  return container;
};

beforeEach(() => {
  toastSuccess.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  document.body.replaceChildren();
});

const clickButton = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label),
  )!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

it('confirms the site it just added below the button', async () => {
  step({ previewResource: vi.fn(async () => added) });
  await act(async () => {});
  await clickButton('Connect');
  expect(window.scholar.captureResource).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Home | Schoology');
  expect(container.textContent).toContain('usd497.schoology.com');
  expect(toastSuccess).toHaveBeenCalledWith(
    expect.stringContaining('Home | Schoology'),
  );
});

it('stops showing the confirmation once it has timed out', async () => {
  step({ previewResource: vi.fn(async () => added) });
  await act(async () => {});
  await clickButton('Connect');
  expect(container.textContent).toContain('Home | Schoology');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000);
  });
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it('keeps the button usable when the site cannot be added', async () => {
  step({
    previewResource: vi.fn(async () => added),
    captureResource: vi.fn(async () => {
      throw new Error('Finish signing in');
    }) as never,
  });
  await act(async () => {});
  await clickButton('Connect');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000);
  });
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(toastSuccess).not.toHaveBeenCalled();
});

it('names the site the button is about to connect', async () => {
  step({
    previewResource: vi.fn(async () => ({
      name: added.name,
      url: added.url,
      host: added.host,
      kind: added.kind,
      status: added.status,
    })),
  });
  await act(async () => {});
  expect(container.textContent).toContain(`Connect "${added.name}"`);
});

it('keeps the generic label until a connectable page is open', async () => {
  step({});
  await act(async () => {});
  expect(container.textContent).toContain('Start connecting resources');
  expect(container.textContent).not.toContain('Connect "');
});

it('refreshes the site preview after navigation without a window focus event', async () => {
  const previewResource = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValue({
      ...added,
      name: 'Learner home | Khan Academy',
    });
  step({ previewResource });
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(container.textContent).toContain(
    'Connect "Learner home | Khan Academy"',
  );
});

it('opens the study browser before trying to capture an unlisted site', async () => {
  const openStudyBrowser = vi.fn(async () => undefined);
  step({ openStudyBrowser } as never);
  await act(async () => {});
  await clickButton('Start connecting resources');
  expect(openStudyBrowser).toHaveBeenCalledOnce();
  expect(window.scholar.captureResource).not.toHaveBeenCalled();
  expect(toastSuccess).not.toHaveBeenCalled();
});

it('captures the selected academic site only after the browser has been opened and navigation is observed', async () => {
  const previewResource = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValue(added);
  const openStudyBrowser = vi.fn(async () => undefined);
  step({ previewResource, openStudyBrowser });
  await act(async () => {});
  await clickButton('Start connecting resources');
  expect(openStudyBrowser).toHaveBeenCalledOnce();
  expect(window.scholar.captureResource).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  await clickButton('Connect');
  expect(window.scholar.captureResource).toHaveBeenCalledOnce();
  expect(toastSuccess).toHaveBeenCalledOnce();
});
