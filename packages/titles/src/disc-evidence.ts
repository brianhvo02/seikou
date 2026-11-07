/** What a disc's files and path say about it, read once per new or changed disc for the title matcher. */
export interface DiscEvidence {
  readonly discId: string;
  readonly path: string; // root-relative, as DiscEntry.path
  readonly fingerprint: string | null; // contentHash
  readonly discTitles: readonly { readonly lang: string; readonly name: string }[]; // bdmt di:name per language
  readonly segments: readonly string[]; // folder names from below the root down to the disc folder or ISO file name
  readonly catalogueNumbers: readonly string[];
  readonly playlists: readonly { readonly id: string; readonly durationS: number; readonly chapters: number; readonly clips: readonly string[] }[];
}
