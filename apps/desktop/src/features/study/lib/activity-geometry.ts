export type ActivityLayout = 'side-by-side' | 'stacked';

export type ActivityBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ActivityClipRect = {
  bounds: Pick<DOMRectReadOnly, 'x' | 'y' | 'width' | 'height'>;
  clipX: boolean;
  clipY: boolean;
};

export type ActivityViewport = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const minimumVisibleWidth = 120;
const minimumVisibleHeight = 80;
const stackedBreakpoint = 760;

const activityOcclusionSelectors = [
  '[data-slot="dialog-overlay"][data-open]',
  '[data-slot="dialog-overlay"][data-state="open"]',
  '[data-slot="dialog-content"][data-open]',
  '[data-slot="dialog-content"][data-state="open"]',
  '[data-slot="alert-dialog-overlay"][data-open]',
  '[data-slot="alert-dialog-content"][data-open]',
  '[data-slot="dropdown-menu-content"][data-open]',
  '[data-slot="dropdown-menu-content"][data-state="open"]',
  '[data-slot="select-content"][data-open]',
  '[data-slot="select-content"][data-state="open"]',
  '[data-slot="popover-content"][data-open]',
  '[data-slot="popover-content"][data-state="open"]',
].join(',');

export const getActivityLayout = (containerWidth: number): ActivityLayout =>
  Number.isFinite(containerWidth) && containerWidth < stackedBreakpoint
    ? 'stacked'
    : 'side-by-side';

export const getActivityBounds = (
  element: Pick<DOMRectReadOnly, 'x' | 'y' | 'width' | 'height'>,
  viewport: ActivityViewport,
  clippingAncestors: readonly ActivityClipRect[] = [],
): ActivityBounds | null => {
  const values = [
    element.x,
    element.y,
    element.width,
    element.height,
    viewport.x,
    viewport.y,
    viewport.width,
    viewport.height,
    ...clippingAncestors.flatMap(({ bounds }) => [
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
    ]),
  ];
  if (
    !values.every(Number.isFinite) ||
    element.width <= 0 ||
    element.height <= 0
  )
    return null;

  let left = Math.max(element.x, viewport.x);
  let top = Math.max(element.y, viewport.y);
  let right = Math.min(element.x + element.width, viewport.x + viewport.width);
  let bottom = Math.min(
    element.y + element.height,
    viewport.y + viewport.height,
  );
  for (const clip of clippingAncestors) {
    if (clip.clipX) {
      left = Math.max(left, clip.bounds.x);
      right = Math.min(right, clip.bounds.x + clip.bounds.width);
    }
    if (clip.clipY) {
      top = Math.max(top, clip.bounds.y);
      bottom = Math.min(bottom, clip.bounds.y + clip.bounds.height);
    }
  }
  const width = Math.floor(right) - Math.floor(left);
  const height = Math.floor(bottom) - Math.floor(top);
  if (width < minimumVisibleWidth || height < minimumVisibleHeight) return null;

  return {
    x: Math.floor(left),
    y: Math.floor(top),
    width,
    height,
  };
};

export const getActivityClippingAncestors = (
  element: HTMLElement,
): { element: HTMLElement; clip: ActivityClipRect }[] => {
  const clippingAncestors: { element: HTMLElement; clip: ActivityClipRect }[] =
    [];
  let ancestor = element.parentElement;
  while (ancestor && ancestor !== element.ownerDocument.documentElement) {
    const style =
      ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor);
    if (!style) break;
    const clipX = /(auto|scroll|overlay|hidden|clip)/.test(style.overflowX);
    const clipY = /(auto|scroll|overlay|hidden|clip)/.test(style.overflowY);
    if (clipX || clipY) {
      const bounds = ancestor.getBoundingClientRect();
      clippingAncestors.push({
        element: ancestor,
        clip: { bounds, clipX, clipY },
      });
    }
    ancestor = ancestor.parentElement;
  }
  return clippingAncestors;
};

export const getActivityViewport = (window: Window): ActivityViewport => {
  const visualViewport = window.visualViewport;
  return {
    x: visualViewport?.offsetLeft ?? 0,
    y: visualViewport?.offsetTop ?? 0,
    width: visualViewport?.width ?? window.innerWidth,
    height: visualViewport?.height ?? window.innerHeight,
  };
};

export const isActivityOccluded = (document: Document): boolean =>
  document.querySelector(activityOcclusionSelectors) !== null;

export const getActivityScrollAnchor = (
  element: HTMLElement | null,
): { element: HTMLElement; scrollTop: number; scrollLeft: number } | null => {
  if (!element) return null;
  let current: HTMLElement | null = element.parentElement;
  while (current && current !== element.ownerDocument.documentElement) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (
      style &&
      /(auto|scroll|overlay|hidden)/.test(style.overflowY + style.overflowX)
    ) {
      return {
        element: current,
        scrollTop: current.scrollTop,
        scrollLeft: current.scrollLeft,
      };
    }
    current = current.parentElement;
  }
  const window = element.ownerDocument.defaultView;
  return window
    ? {
        element: element.ownerDocument.documentElement,
        scrollTop: window.scrollY,
        scrollLeft: window.scrollX,
      }
    : null;
};

export const restoreActivityScrollAnchor = (
  anchor: ReturnType<typeof getActivityScrollAnchor>,
): void => {
  if (!anchor || !anchor.element.isConnected) return;
  const window = anchor.element.ownerDocument.defaultView;
  if (
    anchor.element === anchor.element.ownerDocument.documentElement &&
    window
  ) {
    window.scrollTo({
      top: anchor.scrollTop,
      left: anchor.scrollLeft,
      behavior: 'auto',
    });
    return;
  }
  anchor.element.scrollTop = anchor.scrollTop;
  anchor.element.scrollLeft = anchor.scrollLeft;
};
