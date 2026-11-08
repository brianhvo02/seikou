// SPDX-License-Identifier: LGPL-3.0-or-later
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { JobsSnapshot, JobsStore } from './job-events';

// Hands the app's one queue store to every page, so the progress line and the Queue page share a stream.

const JobsContext = createContext<JobsStore | null>(null);

/** Props of `JobsProvider`. */
export interface JobsProviderProps {
  /** The app's queue store. */
  readonly store: JobsStore;
  /** The app. */
  readonly children: ReactNode;
}

/** Makes `store` the queue every `useJobs` below reads. */
export function JobsProvider({ store, children }: JobsProviderProps) {
  return <JobsContext.Provider value={store}>{children}</JobsContext.Provider>;
}

/** The store of the nearest `JobsProvider`. */
export function useJobsStore(): JobsStore {
  const store = useContext(JobsContext);
  if (store === null) throw new Error('useJobs needs a JobsProvider above it.');
  return store;
}

/** The queue as the app last heard it, kept current while the calling component is on screen. */
export function useJobs(): JobsSnapshot {
  const store = useJobsStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
