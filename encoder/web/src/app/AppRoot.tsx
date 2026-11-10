// SPDX-License-Identifier: LGPL-3.0-or-later
import { useMemo } from 'react';
import { createApi } from '../api';
import { useController } from '../player/use-controller';
import { App } from '../App';
import { createAppApi, type AppApi } from './app-api';
import { AppShell } from './AppShell';
import { DiscPage } from './DiscPage';
import { EpisodesPage } from './EpisodesPage';
import { createJobsStore } from './job-events';
import { JobsProvider } from './jobs-context';
import { LibraryPage } from './LibraryPage';
import { ProgressLine } from './ProgressLine';
import { QueueDialog } from './QueueDialog';
import { QueuePage } from './QueuePage';
import { useDocumentTitle } from './place';
import { Link, useRoute, type SeasonRef } from './router';
import { SettingsPage } from './SettingsPage';
import { SeasonPage, SeasonQueue, ShowPage } from './ShowPage';
import { TestPage } from './TestPage';

/** What the root needs. */
export interface AppRootProps {
  /** The run's token, read from the address `seikou-encode app` printed. */
  readonly token: string;
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
  // keyed by the session, so another session starts from a fresh page state (and asks step 3's question again)
  return <App key={sessionId} api={api} />;
}

/** The Episodes page with the page's engine, which is made only once this page is shown. */
function EpisodesRoute({ api, discKey, playlistId, from }: { readonly api: AppApi; readonly discKey: string; readonly playlistId: string; readonly from?: SeasonRef | undefined }) {
  const controller = useController();
  return <EpisodesPage api={api} discKey={discKey} playlistId={playlistId} controller={controller} from={from} />;
}

/** Picks the page for the address and puts it in the shell. */
export function AppRoot({ token }: AppRootProps) {
  const { route } = useRoute();
  const appApi = useMemo(() => createAppApi('', token), [token]);
  // one stream of the queue for the whole app: the progress line and the Queue page read it together
  const jobs = useMemo(() => createJobsStore(appApi), [appApi]);
  let page;
  switch (route.kind) {
    case 'library':
      page = <LibraryPage api={appApi} view={route.view} />;
      break;
    case 'disc':
      page = <DiscPage api={appApi} discKey={route.discKey} from={route.from} />;
      break;
    case 'show':
      page = <ShowPage key={route.titleId} api={appApi} titleId={route.titleId} />;
      break;
    case 'season':
      page = <SeasonPage key={`${route.titleId}/${route.seasonId}`} api={appApi} titleId={route.titleId} seasonId={route.seasonId} />;
      break;
    case 'seasonQueue':
      page = <SeasonQueue key={`${route.titleId}/${route.seasonId}`} api={appApi} titleId={route.titleId} seasonId={route.seasonId} />;
      break;
    case 'helper':
      page = <HelperRoute token={token} sessionId={route.sessionId} />;
      break;
    case 'episodes':
      page = <EpisodesRoute api={appApi} discKey={route.discKey} playlistId={route.playlistId} from={route.from} />;
      break;
    case 'settings':
      page = <SettingsPage api={appApi} />;
      break;
    case 'queue':
      page = <QueuePage api={appApi} />;
      break;
    case 'queueNew':
      page = (
        <QueueDialog
          key={`${route.discKey}/${route.playlistId}/${route.spec}/${route.noSubtitles}/${route.profile ?? ''}`}
          api={appApi}
          discKey={route.discKey}
          playlistId={route.playlistId}
          spec={route.spec}
          noSubtitles={route.noSubtitles}
          profile={route.profile}
        />
      );
      break;
    case 'job':
      page = <QueuePage api={appApi} jobId={route.jobId} />;
      break;
    case 'test':
      page = <TestPage api={appApi} jobId={route.jobId} />;
      break;
    case 'notFound':
      page = <NotFound />;
      break;
  }
  return (
    <JobsProvider store={jobs}>
      <AppShell route={route} progress={<ProgressLine />}>
        {page}
      </AppShell>
    </JobsProvider>
  );
}
