'use client';

import type { ComponentProps } from 'react';
import { Streamdown, defaultRehypePlugins } from 'streamdown';

export type AiMarkdownProps = {
  text: string;
  streaming?: boolean;
};

const safeLink = (href: string | undefined) => {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
};

// Omit the raw HTML parser; activities use the separate bounded host runtime.
const rehypePlugins = [
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
];
const components = {
  strong: ({ children }: ComponentProps<'strong'>) => (
    <strong className="font-semibold">{children}</strong>
  ),
  a: ({ href, children }: ComponentProps<'a'>) => {
    const safeHref = safeLink(href);
    return safeHref ? (
      <a
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-primary underline underline-offset-4"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  // Model-provided images must never make automatic external requests.
  img: ({ alt }: ComponentProps<'img'>) => (
    <span className="text-muted-foreground">{alt || 'Image omitted'}</span>
  ),
};

export const AiMarkdown = ({ text, streaming = false }: AiMarkdownProps) => (
  <Streamdown
    className="w-full min-w-0 break-words text-base leading-relaxed"
    mode={streaming ? 'streaming' : 'static'}
    isAnimating={streaming}
    parseIncompleteMarkdown={streaming}
    skipHtml
    rehypePlugins={rehypePlugins}
    components={components}
    controls={false}
  >
    {text}
  </Streamdown>
);
