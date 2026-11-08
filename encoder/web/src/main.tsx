// SPDX-License-Identifier: LGPL-3.0-or-later
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRoot } from './app/AppRoot';
// Instrument Sans with its width axis (OFL), bundled so the page needs no network for its type.
import '@fontsource-variable/instrument-sans/wdth.css';
import './styles.css';

// The run's token comes in the address `seikou-encode serve` opened. It stays in the address bar, so a reload still
// works, and otherwise only in the client's memory: nothing stores it. Which page shows comes from the path (`app/router.ts`).
const token = new URLSearchParams(location.search).get('t') ?? '';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(
  <StrictMode>
    <AppRoot token={token} />
  </StrictMode>,
);
