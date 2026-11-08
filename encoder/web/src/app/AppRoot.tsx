// SPDX-License-Identifier: LGPL-3.0-or-later
import { useMemo } from 'react';
import { createApi } from '../api';
import { useController } from '../player/use-controller';
import { App } from '../App';
import { createAppApi, type AppApi } from './app-api';
import { AppShell } from './AppShell';
import { DiscPage } from './DiscPage';
import { EpisodesPage } from './EpisodesPage';
import { LibraryPage } from './LibraryPage';
import { useDocumentTitle } from './place';
import { Link, useRoute } from './router';

/** What the root needs. */
export interface AppRootProps {
  /** The run's token, read from the address `seikou-encode app` printed. */
  readonly token: string;
}

/** A page that is not built yet: its name inside the shell. */
function Placeholder({ title, children }: { readonly title: string; readonly children?: string }) {
  useDocumentTitle('Seikou encoder');
  return (
    <main className="content wide">
      <h1 className="page-title">{title}</h1>
      <p className="muted">{children ?? 'This page is not ready yet.'}</p>
    </main>
  );
}

/** The page for an address the app has no page for. */
function NotFound() {
  useDocumentTitle('Seikou encoder');
  return (
    <main className="content wide">
      <h1 className="page-title">Page not found</h1>
      <p>
        <Link to={{ kind: 'library' }}>Go to the library</Link>
      </p>
    </main>
  );
}

/** The helper of one session, its client made once per session. */
function HelperRoute({ token, sessionId }: { readonly token: string; readonly sessionId: string }) {
  const api = useMemo(() => createApi('', token, sessionId), [token, sessionId]);
  useDocumentTitle('Subtitle helper');
  return <App api={api} />;
}

/** The Episodes page with the page's engine, which is made only once this page is shown. */
function EpisodesRoute({ api, discKey, playlistId }: { readonly api: AppApi; readonly discKey: string; readonly playlistId: string }) {
  const controller = useController();
  return <EpisodesPage api={api} discKey={discKey} playlistId={playlistId} controller={controller} />;
}

/** Picks the page for the address and puts it in the shell. */
export function AppRoot({ token }: AppRootProps) {
  const { route } = useRoute();
  const appApi = useMemo(() => createAppApi('', token), [token]);
  let page;
  switch (route.kind) {
    case 'library':
      page = <LibraryPage api={appApi} />;
      break;
    case 'disc':
      page = <DiscPage api={appApi} discKey={route.discKey} />;
      break;
    case 'helper':
      page = <HelperRoute token={token} sessionId={route.sessionId} />;
      break;
    case 'episodes':
      page = <EpisodesRoute api={appApi} discKey={route.discKey} playlistId={route.playlistId} />;
      break;
    case 'settings':
      page = <Placeholder title="Settings" />;
      break;
    case 'queue':
      page = <Placeholder title="Queue" />;
      break;
    case 'queueNew':
      page = <Placeholder title="Queue an encode" />;
      break;
    case 'job':
      page = <Placeholder title="Job" />;
      break;
    case 'test':
      page = <Placeholder title="Test results" />;
      break;
    case 'notFound':
      page = <NotFound />;
      break;
  }
  return <AppShell route={route}>{page}</AppShell>;
}
