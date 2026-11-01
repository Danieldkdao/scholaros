// @vitest-environment jsdom
import { act, type ComponentProps, type Ref } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { Button } from '@scholaros/ui/components/button';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
});

it('composes a shared button without adding a nested button or losing its click handler', async () => {
  const click = vi.fn();
  await act(async () =>
    root.render(
      <TooltipWrapper content="Refresh">
        <Button onClick={click}>Refresh</Button>
      </TooltipWrapper>,
    ),
  );
  expect(container.querySelectorAll('button')).toHaveLength(1);
  await act(async () => container.querySelector('button')!.click());
  expect(click).toHaveBeenCalledOnce();
});

it('preserves links, non-button triggers, and forwarded custom component props', async () => {
  const CustomLink = (
    props: ComponentProps<'a'> & { ref?: Ref<HTMLAnchorElement> },
  ) => <a {...props} />;
  await act(async () =>
    root.render(
      <TooltipWrapper content="Source">
        <CustomLink href="https://school.example" aria-label="Open source">
          Source
        </CustomLink>
      </TooltipWrapper>,
    ),
  );
  expect(container.querySelector('a')?.getAttribute('href')).toBe(
    'https://school.example',
  );
  expect(container.querySelector('button')).toBeNull();
  await act(async () =>
    root.render(
      <TooltipWrapper content="Status">
        <span tabIndex={0}>Ready</span>
      </TooltipWrapper>,
    ),
  );
  expect(container.querySelector('span')?.getAttribute('tabindex')).toBe('0');
});

it('forwards content props and uses content as the tooltip description', async () => {
  await act(async () =>
    root.render(
      <TooltipWrapper
        content="Source details"
        tooltipContentProps={{
          keepMounted: true,
          'aria-label': 'Details',
          side: 'bottom',
        }}
      >
        <button type="button">Source</button>
      </TooltipWrapper>,
    ),
  );
  await act(async () => {
    container.querySelector('button')!.focus();
  });
  expect(
    document.querySelector('[data-slot="tooltip-content"]')?.textContent,
  ).toContain('Source details');
  expect(
    document
      .querySelector('[data-slot="tooltip-content"]')
      ?.getAttribute('aria-label'),
  ).toBe('Details');
});

it('preserves disabled buttons', async () => {
  const click = vi.fn();
  await act(async () =>
    root.render(
      <TooltipWrapper content="Refreshing">
        <Button disabled onClick={click}>
          Refresh
        </Button>
      </TooltipWrapper>,
    ),
  );
  expect(container.querySelector('button')?.disabled).toBe(true);
  container.querySelector('button')!.click();
  expect(click).not.toHaveBeenCalled();
});
