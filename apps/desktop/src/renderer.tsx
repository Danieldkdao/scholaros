import './data/env/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app';
import '@scholaros/ui/styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('React root element was not found.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
