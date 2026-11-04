// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ActivityHost } from '../components/activity-host';
import { ActivityPanel } from '../components/activity-panel';
import type {
  ActivityHostBridge,
  ActivityRuntimeChange,
} from '../hooks/use-activity-host';
import {
  getActivityBounds,
  getActivityLayout,
  isActivityOccluded,
} from '../lib/activity-geometry';

const isoTime = '2026-11-03T00:00:00.000Z';
const roots: { root: ReturnType<typeof createRoot>; node: HTMLDivElement }[] =
  [];
const resizeObserverCallback = vi.fn();

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    resizeObserverCallback();
    this.callback(
      [
        {
          target,
          contentRect: target.getBoundingClientRect(),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }

  disconnect() {}
  unobserve() {}
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver =
  TestResizeObserver as unknown as typeof ResizeObserver;
Object.defineProperty(window, 'scrollTo', {
  configurable: true,
  value: vi.fn(),
});
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => rect(0, 0, 1000, 800),
});

const renderActivityWithRerender = async (
  bridge: ActivityHostBridge,
  props: Partial<React.ComponentProps<typeof ActivityHost>> = {},
) => {
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  roots.push({ root, node });
  const render = async (
    nextProps: Partial<React.ComponentProps<typeof ActivityHost>> = props,
  ) =>
    act(async () =>
      root.render(
        createElement(
          ActivityPanel,
          null,
          createElement(ActivityHost, {
            accountId: 'account-1',
            sessionId: 'session-1',
            artifactId: 'artifact-1',
            versionId: 'version-1',
            attemptId: 'attempt-1',
            bridge,
            ...nextProps,
          }),
        ),
      ),
    );
  await render();
  return { node, render };
};

const renderActivity = async (
  bridge: ActivityHostBridge,
  props: Partial<React.ComponentProps<typeof ActivityHost>> = {},
) => (await renderActivityWithRerender(bridge, props)).node;

const createBridge = (): {
  bridge: ActivityHostBridge;
  emit: (change: ActivityRuntimeChange) => void;
} => {
  let listener: ((change: ActivityRuntimeChange) => void) | undefined;
  let nextRun = 0;
  const bridge: ActivityHostBridge = {
    getArtifactVersion: vi.fn().mockResolvedValue({
      artifactId: 'artifact-1',
      versionId: 'version-1',
      title: 'Linear graph',
      objective: 'Explore how slope changes a line.',
      runtimeVersion: 1,
      contentDigest: 'digest-1',
      createdAt: isoTime,
      sourceReferences: [],
      available: true,
    }),
    getArtifactState: vi.fn().mockResolvedValue({
      artifactId: 'artifact-1',
      versionId: 'version-1',
      attemptId: 'attempt-1',
      stateRevision: 2,
      state: { inputs: { slope: 2 }, rngSeed: 17, canvas: {} },
      updatedAt: isoTime,
    }),
    mountActivity: vi.fn(async () => ({ runId: `run-${++nextRun}` })),
    updateActivityBounds: vi.fn().mockResolvedValue(undefined),
    closeActivity: vi.fn().mockResolvedValue(undefined),
    onActivityChange: vi.fn((_runId, nextListener) => {
      listener = nextListener;
      return () => {
        listener = undefined;
      };
    }),
    retryActivityCheckpoint: vi.fn().mockResolvedValue(undefined),
    resetArtifactAttempt: vi.fn().mockResolvedValue({
      artifactId: 'artifact-1',
      versionId: 'version-1',
      attemptId: 'attempt-2',
      stateRevision: 0,
      state: { inputs: { slope: 1 }, rngSeed: 17, canvas: {} },
      updatedAt: isoTime,
    }),
    saveArtifactToContext: vi.fn().mockResolvedValue({ id: 'context-1' }),
  };
  return {
    bridge,
    emit: (change) => listener?.(change),
  };
};

const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
): DOMRectReadOnly =>
  ({
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({}),
  }) as DOMRectReadOnly;

const setRect = (element: Element, bounds: DOMRectReadOnly) => {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => bounds,
  });
};

afterEach(async () => {
  for (const { root, node } of roots.splice(0)) {
    await act(async () => root.unmount());
    node.remove();
  }
  document.body.replaceChildren();
});

it('keeps one native run and one accepted attempt across repeated expand and collapse', async () => {
  const { bridge } = createBridge();
  const node = await renderActivity(bridge);
  const slot = node.querySelector('[data-activity-runtime-slot]')!;
  setRect(slot, rect(160, 120, 540, 360));

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  const expand = node.querySelector<HTMLButtonElement>(
    '[aria-label="Expand activity"]',
  )!;
  expand.focus();
  await act(async () => expand.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  await act(async () =>
    node
      .querySelector<HTMLButtonElement>('[aria-label="Collapse activity"]')
      ?.click(),
  );
  await act(async () =>
    node
      .querySelector<HTMLButtonElement>('[aria-label="Expand activity"]')
      ?.click(),
  );
  await act(async () =>
    node
      .querySelector<HTMLButtonElement>('[aria-label="Collapse activity"]')
      ?.click(),
  );

  expect(bridge.mountActivity).toHaveBeenCalledTimes(1);
  expect(bridge.mountActivity).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      attemptId: 'attempt-1',
    }),
  );
  expect(bridge.closeActivity).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(bridge.updateActivityBounds)
      .mock.calls.every(([input]) => input.runId === 'run-1'),
  ).toBe(true);
  expect(document.activeElement).toBe(
    node.querySelector<HTMLButtonElement>('[aria-label="Expand activity"]'),
  );
});

it('allows collapsing an initially expanded activity without restarting its run', async () => {
  const { bridge } = createBridge();
  const node = await renderActivity(bridge, { presentation: 'expanded' });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));

  expect(node.querySelector('[data-activity-panel-target]')).not.toBeNull();
  const collapse = node.querySelector<HTMLButtonElement>(
    '[aria-label="Collapse activity"]',
  );
  await act(async () => collapse?.click());

  expect(node.querySelector('[data-activity-panel-target]')).toBeNull();
  expect(vi.mocked(bridge.mountActivity).mock.calls).toHaveLength(1);
  expect(bridge.closeActivity).not.toHaveBeenCalled();
});

it('uses the artifact service for Context, course and reset actions', async () => {
  const { bridge } = createBridge();
  const node = await renderActivity(bridge, { courseId: 'course-1' });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));

  const options = node.querySelector<HTMLButtonElement>(
    '[aria-label="Activity options for Linear graph"]',
  );
  await act(async () => options?.click());
  const contextItem = Array.from(
    document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((item) => item.textContent?.includes('Save to Context'));
  await act(async () => contextItem?.click());
  expect(
    vi.mocked(bridge.saveArtifactToContext).mock.calls[0]?.[0],
  ).toMatchObject({
    artifactId: 'artifact-1',
    versionId: 'version-1',
  });

  await act(async () => options?.click());
  const courseItem = Array.from(
    document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((item) => item.textContent?.includes('Save to course'));
  await act(async () => courseItem?.click());
  expect(
    vi.mocked(bridge.saveArtifactToContext).mock.calls[1]?.[0],
  ).toMatchObject({
    artifactId: 'artifact-1',
    versionId: 'version-1',
    courseId: 'course-1',
  });

  await act(async () => options?.click());
  const resetItem = Array.from(
    document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((item) => item.textContent?.includes('Reset activity'));
  await act(async () => resetItem?.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
  expect(
    vi
      .mocked(bridge.updateActivityBounds)
      .mock.calls.some(([input]) => input.visible === false),
  ).toBe(true);
  const confirmReset = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button'),
  ).find((button) => button.textContent?.includes('Reset activity'));
  await act(async () => confirmReset?.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));

  expect(
    vi.mocked(bridge.resetArtifactAttempt).mock.calls[0]?.[0],
  ).toMatchObject({
    artifactId: 'artifact-1',
    versionId: 'version-1',
    attemptId: 'attempt-1',
  });
  expect(vi.mocked(bridge.mountActivity).mock.calls.at(-1)?.[0]).toMatchObject({
    attemptId: 'attempt-2',
  });
});

it('does not acknowledge a failed checkpoint and retries through the host', async () => {
  const { bridge, emit } = createBridge();
  const node = await renderActivity(bridge);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));

  await act(async () =>
    emit({
      runId: 'run-1',
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      attemptId: 'attempt-1',
      kind: 'checkpoint-pending',
      stateRevision: 3,
    }),
  );
  expect(node.textContent).toContain('Saving activity progress');

  await act(async () =>
    emit({
      runId: 'run-1',
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      attemptId: 'attempt-1',
      kind: 'checkpoint-failed',
      stateRevision: 3,
      errorCode: 'storage-failed',
    }),
  );
  expect(node.textContent).toContain('Progress could not be saved');
  expect(node.textContent).not.toContain('Saved progress: revision 3');

  await act(async () =>
    node
      .querySelector<HTMLButtonElement>(
        '[aria-label="Retry saving activity progress"]',
      )
      ?.click(),
  );
  expect(bridge.retryActivityCheckpoint).toHaveBeenCalledWith({
    runId: 'run-1',
  });
  await act(async () =>
    emit({
      runId: 'run-1',
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      attemptId: 'attempt-1',
      kind: 'checkpoint-acknowledged',
      stateRevision: 3,
    }),
  );
  expect(node.textContent).toContain('Saved progress: revision 3');
});

it('mounts saved activities read-only without save, reset, or retry actions', async () => {
  const { bridge, emit } = createBridge();
  const node = await renderActivity(bridge, { readOnly: true });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));

  expect(bridge.mountActivity).toHaveBeenCalledWith(
    expect.objectContaining({ readOnly: true }),
  );
  expect(
    node.querySelector('[aria-label="Activity options for Linear graph"]'),
  ).toBeNull();

  await act(async () =>
    emit({
      runId: 'run-1',
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      attemptId: 'attempt-1',
      kind: 'runtime-error',
      errorCode: 'feature-unavailable',
    }),
  );

  expect(node.querySelector('[aria-label="Retry activity"]')).toBeNull();
  expect(bridge.retryActivityCheckpoint).not.toHaveBeenCalled();
  expect(bridge.resetArtifactAttempt).not.toHaveBeenCalled();
  expect(bridge.saveArtifactToContext).not.toHaveBeenCalled();
  expect(node.textContent).toContain(
    'Reconnect online to retry this activity.',
  );
});

it('releases and reloads the saved run when the host changes read-only mode', async () => {
  const { bridge } = createBridge();
  const { render } = await renderActivityWithRerender(bridge, {
    readOnly: false,
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
  expect(bridge.mountActivity).toHaveBeenCalledTimes(1);

  await render({ readOnly: true });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 140)));
  expect(bridge.closeActivity).toHaveBeenCalledWith({ runId: 'run-1' });
  expect(bridge.mountActivity).toHaveBeenCalledTimes(2);
  expect(bridge.mountActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({ readOnly: true }),
  );

  await render({ readOnly: false });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 140)));
  expect(bridge.closeActivity).toHaveBeenCalledWith({ runId: 'run-2' });
  expect(bridge.mountActivity).toHaveBeenCalledTimes(3);
  expect(bridge.mountActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({ readOnly: false }),
  );
});

it('hides behind app overlays and closes offscreen before restoring the same attempt', async () => {
  const { bridge } = createBridge();
  const node = await renderActivity(bridge);
  const slot = node.querySelector('[data-activity-runtime-slot]')!;
  setRect(slot, rect(80, 60, 480, 320));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));

  const overlay = document.createElement('div');
  overlay.dataset.slot = 'dialog-overlay';
  overlay.dataset.open = '';
  document.body.append(overlay);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 180)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
  expect(
    vi
      .mocked(bridge.updateActivityBounds)
      .mock.calls.some(
        ([input]) => input.runId === 'run-1' && input.visible === false,
      ),
  ).toBe(true);
  overlay.remove();

  setRect(slot, rect(0, 0, 0, 0));
  await act(async () => document.dispatchEvent(new Event('scroll')));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 80)));
  expect(bridge.closeActivity).toHaveBeenCalledWith({ runId: 'run-1' });

  setRect(slot, rect(120, 80, 480, 320));
  await act(async () => document.dispatchEvent(new Event('scroll')));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  expect(vi.mocked(bridge.mountActivity).mock.calls).toHaveLength(2);
  expect(vi.mocked(bridge.mountActivity).mock.calls[1]?.[0]).toMatchObject({
    sessionId: 'session-1',
    artifactId: 'artifact-1',
    versionId: 'version-1',
    attemptId: 'attempt-1',
  });
});

it('uses a readable stacked layout for a narrow activity panel', async () => {
  expect(getActivityLayout(680)).toBe('stacked');
  expect(getActivityLayout(960)).toBe('side-by-side');
});

it('clips trusted geometry and hides it for overlays or an offscreen slot', () => {
  const bounds = getActivityBounds(rect(-40, 40, 320, 260), {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  });
  expect(bounds).toEqual({ x: 0, y: 40, width: 280, height: 260 });
  expect(
    getActivityBounds(rect(900, 700, 120, 100), {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    }),
  ).toBeNull();
  expect(
    getActivityBounds(
      rect(50, 50, 400, 300),
      { x: 0, y: 0, width: 800, height: 600 },
      [
        {
          bounds: rect(100, 100, 250, 200),
          clipX: true,
          clipY: true,
        },
      ],
    ),
  ).toEqual({ x: 100, y: 100, width: 250, height: 200 });

  const overlay = document.createElement('div');
  overlay.dataset.slot = 'dropdown-menu-content';
  overlay.dataset.open = '';
  document.body.append(overlay);
  expect(isActivityOccluded(document)).toBe(true);
});

it('shows a recoverable unavailable state when artifact lookup fails', async () => {
  const { bridge } = createBridge();
  vi.mocked(bridge.getArtifactVersion).mockRejectedValueOnce(
    new Error('offline'),
  );
  const node = await renderActivity(bridge);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));

  expect(node.textContent).toContain('This activity is unavailable');
  expect(bridge.mountActivity).not.toHaveBeenCalled();
});

it('rejects incompatible saved runtime versions without creating a native run', async () => {
  const { bridge } = createBridge();
  vi.mocked(bridge.getArtifactVersion).mockResolvedValueOnce({
    artifactId: 'artifact-1',
    versionId: 'version-1',
    title: 'Old activity',
    objective: 'Review an older saved activity.',
    runtimeVersion: 2,
    contentDigest: 'digest-2',
    createdAt: isoTime,
    sourceReferences: [],
    available: true,
  });
  const node = await renderActivity(bridge);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
  expect(node.textContent).toContain(
    'This activity version cannot run in this app version.',
  );
  expect(bridge.mountActivity).not.toHaveBeenCalled();
});
