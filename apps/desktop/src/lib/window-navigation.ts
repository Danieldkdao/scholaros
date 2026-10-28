import type { WebContents } from 'electron';

export const protectWindowNavigation = (contents: WebContents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => {
    // Vite reloads the current document after dependency optimization.
    if (event.url !== contents.getURL()) event.preventDefault();
  });
};
