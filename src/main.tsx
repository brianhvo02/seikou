import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
// Instrument Sans with its width axis (OFL), bundled so the app keeps its type offline.
import '@fontsource-variable/instrument-sans/wdth.css';
import './ui/styles.css';

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // Classic script: the build emits sw.js as an IIFE, which every target browser accepts.
  navigator.serviceWorker.register('/sw.js').catch((e) => console.error('service worker registration failed', e));
}
if ('storage' in navigator && matchMedia('(display-mode: standalone)').matches) {
  // An installed app asks once to keep its storage (settings, shader sets, remembered discs) from eviction.
  navigator.storage.persist().catch((e) => console.error('persistent storage request failed', e));
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
