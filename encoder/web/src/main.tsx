// SPDX-License-Identifier: LGPL-3.0-or-later
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApi, helperSessionId } from './api';
import { App } from './App';
// Instrument Sans with its width axis (OFL), bundled so the page needs no network for its type.
import '@fontsource-variable/instrument-sans/wdth.css';
import './styles.css';

// The run's token comes in the address `seikou-encode serve` opened. It stays in the address bar, so a reload still
// works, and otherwise only in the client's memory: nothing stores it. The helper session comes from the path,
// `/helper/<id>`.
const token = new URLSearchParams(location.search).get('t') ?? '';
const sessionId = helperSessionId(location.pathname);

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(
  <StrictMode>
    {sessionId === null ? (
      <div className="page">
        <main className="content">
          <p className="error" role="alert">
            Open the helper at the address seikou-encode serve printed.
          </p>
        </main>
      </div>
    ) : (
      <App api={createApi('', token, sessionId)} />
    )}
  </StrictMode>,
);
