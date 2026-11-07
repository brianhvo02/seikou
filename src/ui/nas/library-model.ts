import { parseClpi } from '@seikou/bdmv/clpi-parser';
import { parseMpls, type Mpls } from '@seikou/bdmv/mpls-parser';
import { CodingType, isVideoCoding } from '@seikou/bdmv/stream-types';
import type { DiscEntry, DiscManifest, FolderEntry } from '@seikou/nas/nas-api';
import { chooseMainTitle, type MainTitleCandidate } from '@seikou/engine/disc/main-title';
import { clipInfoPath, streamPath } from '@seikou/engine/disc/open-disc';

export interface Crumb {
  readonly label: string;
  /** Root-relative folder path; '' is the top of the NAS. */
  readonly path: string;
}

/** 'media5/[250226] Starfall Wanderer' → NAS › media5 › [250226] Starfall Wanderer, each with the folder it opens. */
export function breadcrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'NAS', path: '' }];
  const parts = path.split('/').filter((p) => p !== '');
  parts.forEach((part, i) => crumbs.push({ label: part, path: parts.slice(0, i + 1).join('/') }));
  return crumbs;
}

export type LibraryRow = { readonly kind: 'folder'; readonly folder: FolderEntry } | { readonly kind: 'disc'; readonly disc: DiscEntry };

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'ja');

/** Folders first, then discs, each in Japanese collation order. */
export function sortRows(listing: { readonly folders: readonly FolderEntry[]; readonly discs: readonly DiscEntry[] }): LibraryRow[] {
  return [
    ...[...listing.folders].sort(byName).map((folder): LibraryRow => ({ kind: 'folder', folder })),
    ...[...listing.discs].sort(byName).map((disc): LibraryRow => ({ kind: 'disc', disc })),
  ];
}

/** `ISO` for disc images; `UHD` once the disc's manifest has shown an HEVC 2160p main title (undefined: not known yet). */
export function discBadges(disc: Pick<DiscEntry, 'kind'>, uhd: boolean | undefined): string[] {
  const badges: string[] = [];
  if (disc.kind === 'iso') badges.push('ISO');
  if (uhd) badges.push('UHD');
  return badges;
}

/** Decimal units, one decimal place above bytes: '46.1 GB'. */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export interface DiscFacts {
  /** The main title's peak rate (the highest TS_recording_rate of its clips) in megabits per second; null when unknown. */
  readonly peakMbps: number | null;
  /** The main title is HEVC 2160p. */
  readonly uhd: boolean;
}

/** BD video_format code of 2160p. */
const VIDEO_FORMAT_2160P = 8;

function inlined(manifest: DiscManifest, path: string): Uint8Array | null {
  const base64 = manifest.inline[path];
  if (base64 === undefined) return null;
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The main title's playlist, from the manifest's inlined playlists, by the engine's (libbluray's) choice of main title
 * among the playlists with video whose clips are all on the disc; null when there is none or it can't be read.
 */
export function mainPlaylist(manifest: DiscManifest): Mpls | null {
  return mainTitle(manifest)?.mpls ?? null;
}

/** The main title's playlist id (as `mainPlaylist` chooses it), e.g. '00001'. */
export function mainPlaylistId(manifest: DiscManifest): string | null {
  return mainTitle(manifest)?.id ?? null;
}

function mainTitle(manifest: DiscManifest): MainTitleCandidate | null {
  try {
    const files = new Set(manifest.files.map((f) => f.path));
    const candidates: MainTitleCandidate[] = [];
    for (const path of Object.keys(manifest.inline).sort()) {
      const m = /^BDMV\/PLAYLIST\/(\d{5})\.MPLS$/.exec(path);
      const bytes = m && inlined(manifest, path);
      if (!m || !bytes) continue;
      let mpls: Mpls;
      try {
        mpls = parseMpls(bytes);
      } catch {
        continue;
      }
      const hasVideo = mpls.playItems.length > 0 && mpls.playItems[0]!.stn.video.some((v) => !v.subPath);
      const complete = mpls.playItems.every((p) => files.has(clipInfoPath(p.clipId)) && files.has(streamPath(p.clipId)));
      if (hasVideo && complete) candidates.push({ id: m[1]!, mpls });
    }
    const mainId = chooseMainTitle(candidates);
    return candidates.find((c) => c.id === mainId) ?? null;
  } catch {
    return null;
  }
}

/** Playlist `id` (an episode's), from the manifest's inlined playlists; null when it isn't there or can't be read. */
export function playlistOf(manifest: DiscManifest, id: string): Mpls | null {
  const bytes = inlined(manifest, `BDMV/PLAYLIST/${id}.MPLS`);
  if (!bytes) return null;
  try {
    return parseMpls(bytes);
  } catch {
    return null;
  }
}

/** What the manifest's inlined playlists and clip info say about the main title (mainPlaylist). */
export function discFacts(manifest: DiscManifest): DiscFacts {
  const unknown: DiscFacts = { peakMbps: null, uhd: false };
  try {
    const clipIds = [...new Set(mainPlaylist(manifest)?.playItems.map((p) => p.clipId) ?? [])];
    const clips = clipIds.flatMap((id) => {
      const bytes = inlined(manifest, clipInfoPath(id));
      return bytes ? [parseClpi(bytes)] : [];
    });
    const first = clips[0];
    if (!first) return unknown;
    const video = first.programs.flatMap((p) => p.streams).find((s) => isVideoCoding(s.codingType));
    // TS_recording_rate is in bytes per second; the title's peak is its fastest clip's.
    const peak = Math.max(...clips.map((c) => c.recordingRate));
    return {
      peakMbps: peak > 0 ? (peak * 8) / 1e6 : null,
      uhd: video?.codingType === CodingType.HEVC && video.format === VIDEO_FORMAT_2160P,
    };
  } catch {
    return unknown;
  }
}

/**
 * `This connection: N Mbps`, and a warning when what plays needs more: the disc's peak rate, or the selected level's
 * rate (named by `levelLabel`); nothing without a measurement.
 */
export function preflightLines(connectionMbps: number | null, peakMbps: number | null, levelLabel?: string): string[] {
  if (connectionMbps === null) return [];
  const lines = [`This connection: ${Math.round(connectionMbps)} Mbps`];
  if (peakMbps !== null && peakMbps > connectionMbps) lines.push(`${levelLabel ?? 'This disc'} needs about ${Math.round(peakMbps)} Mbps; expect pauses.`);
  return lines;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const FOLDER_KEY = 'bluray-web:nas-folder';

/** The folder the library was last showing, kept in `storage` (localStorage) when it works; '' (the top) otherwise. */
export function folderMemory(storage: StorageLike | undefined): { get(): string; set(path: string): void } {
  return {
    get: () => {
      try {
        return storage?.getItem(FOLDER_KEY) ?? '';
      } catch {
        return '';
      }
    },
    set: (path) => {
      try {
        storage?.setItem(FOLDER_KEY, path);
      } catch {
        // Remembering the folder is a convenience.
      }
    },
  };
}

/** Whether the engine reported the disc it was opening as failed (the controller resets both when an open starts). */
export function openFailed(snapshot: { readonly engineState: string; readonly error: unknown }): boolean {
  return snapshot.error !== null || snapshot.engineState === 'error';
}
