// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { StudyMarkdown } from '../components/study-markdown';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});
const render = async (text: string, streaming = false) => {
  await act(async () =>
    root.render(createElement(StudyMarkdown, { text, streaming })),
  );
};
it('renders semantic headings, emphasis, lists, GFM tables and fenced code without executing it', async () => {
  await render(
    '# Loops\n\n**Repeat** a step with `for`.\n\n1. Start\n2. Repeat\n\n| Term | Meaning |\n| --- | --- |\n| loop | repeat |\n\n```python\nprint("hello")\n```',
  );
  expect(container.querySelector('h1')?.textContent).toBe('Loops');
  expect(container.querySelector('strong')?.textContent).toBe('Repeat');
  expect(container.querySelectorAll('ol li')).toHaveLength(2);
  expect(container.querySelector('table')?.textContent).toContain('Meaning');
  expect(container.querySelector('pre code')?.textContent).toContain(
    'print("hello")',
  );
});
it('does not load images or render raw HTML, executable links, or application bridge URLs', async () => {
  await render(
    '![tracking](https://tracker.example/pixel)\n\n![data](data:image/svg+xml,test)\n\n<img src="https://tracker.example/raw" onerror="alert(1)">\n\n<iframe src="https://tracker.example"></iframe>\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) [bridge](scholaros://study) [local](file:///etc/passwd) [relative](/api/private) [safe](https://example.com/guide)',
  );
  expect(
    container.querySelector('img, iframe, script, object, embed'),
  ).toBeNull();
  const links = [...container.querySelectorAll('a')];
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute('href')).toBe('https://example.com/guide');
  expect(links[0]?.getAttribute('rel')).toContain('noreferrer');
  expect(links[0]?.getAttribute('target')).toBe('_blank');
  expect(container.textContent).toContain('tracking');
});
it('handles incomplete Markdown updates without a synthetic animation and keeps code inert', async () => {
  await render('**A partial', true);
  expect(container.querySelector('strong')?.textContent).toBe('A partial');
  await render('**A partial response**\n\n```mermaid\ngraph TD; A-->B;\n```');
  expect(container.querySelector('strong')?.textContent).toBe(
    'A partial response',
  );
  expect(container.querySelector('svg, iframe')).toBeNull();
  expect(container.textContent).toContain('graph TD; A-->B;');
});
