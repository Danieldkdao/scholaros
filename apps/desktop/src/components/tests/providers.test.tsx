// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { Providers } = await import('../providers');
const {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} = await import('@scholaros/ui/components/sidebar');

const navButton = (label: string, href: string) =>
  createElement(
    SidebarMenuItem,
    { key: href },
    createElement(SidebarMenuButton, {
      tooltip: label,
      render: createElement('a', { href }),
      children: label,
    }),
  );

const mount = async (withProviders: boolean) => {
  const tree = createElement(
    SidebarProvider,
    { defaultOpen: false },
    createElement(
      Sidebar,
      { collapsible: 'icon' },
      createElement(
        SidebarContent,
        null,
        createElement(
          SidebarMenu,
          null,
          navButton('Courses', '/dashboard/courses'),
        ),
      ),
    ),
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(withProviders ? createElement(Providers, null, tree) : tree);
  });
  return root;
};

const hover = async (href: string) => {
  const trigger = document.querySelector<HTMLAnchorElement>(
    `a[href="${href}"]`,
  );
  expect(trigger, `missing a link to ${href}`).toBeTruthy();
  await act(async () => {
    trigger!.dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
    );
  });
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
  });
  await act(async () => undefined);
  return document
    .querySelector('[data-slot="tooltip-content"]')
    ?.textContent?.trim();
};

let root: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  // jsdom ships neither the media query API the sidebar and theme provider use.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  document.body.replaceChildren();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe('app providers', () => {
  it('opens collapsed sidebar tooltips on hover', async () => {
    root = await mount(true);
    expect(await hover('/dashboard/courses')).toBe('Courses');
  });

  it('needs the provider before a plain hover opens a tooltip', async () => {
    root = await mount(false);
    expect(await hover('/dashboard/courses')).toBeUndefined();
  });
});
