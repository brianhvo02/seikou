import { walkEntries, type EntryLike } from './entry-walk';

/** Subtitle and font files from a pick or a drop (folders walked one level of subfolders deep). */

export const SUBTITLE_EXTENSIONS: readonly string[] = ['.srt', '.ass', '.ssa'];
export const FONT_EXTENSIONS: readonly string[] = ['.ttf', '.otf', '.ttc', '.woff'];

const hasExtension = (file: File, list: readonly string[]): boolean => list.some((ext) => file.name.toLowerCase().endsWith(ext));

/** Whether a file name is a font's (by its extension). */
export const isFontName = (name: string): boolean => FONT_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

/** The subtitle files and the fonts of a pick, in pick order; anything else is ignored. */
export function splitPick(files: readonly File[]): { readonly subtitles: readonly File[]; readonly fonts: readonly File[] } {
  return { subtitles: files.filter((f) => hasExtension(f, SUBTITLE_EXTENSIONS)), fonts: files.filter((f) => hasExtension(f, FONT_EXTENSIONS)) };
}

/**
 * The subtitle files of a pick as `loadSubtitleFiles` takes them: those named as subtitles, or every file when nothing
 * is named as a subtitle or a font (the engine detects SRT or ASS by content). Empty for fonts alone, which don't
 * replace the text set.
 */
export function pickedSubtitles(files: readonly File[]): readonly File[] {
  const { subtitles, fonts } = splitPick(files);
  return subtitles.length || fonts.length ? subtitles : files;
}

/** The files of a drop: plain files, and the files of dropped folders and of their subfolders (one level). */
export async function collectDroppedFiles(items: DataTransferItemList): Promise<File[]> {
  const entries: EntryLike[] = [];
  const plain: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.() as EntryLike | null;
    // a plain file comes from getAsFile: WebKit's file entry can't read a file that has no disk path
    const file = entry?.isDirectory ? null : item.getAsFile();
    if (file) plain.push(file);
    else if (entry) entries.push(entry);
  }
  return [...plain, ...(await walkEntries(entries, 1)).map(([, f]) => f)];
}
