import './data/env/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import { ThemeProvider } from '@scholaros/ui/components/theme-provider';
import '@scholaros/ui/styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('React root element was not found.');
}

createRoot(root).render(
  <StrictMode>
    <ThemeProvider clientOnly>
      <RouterProvider router={router} />
    </ThemeProvider>
  </StrictMode>,
);
