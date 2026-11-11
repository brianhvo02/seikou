// SPDX-License-Identifier: LGPL-3.0-or-later
// Refuse a WebM input that carries an attachment before any file is opened for it.
import { checkMatroskaInput } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const attachments = [{ name: 'font.ttf', mediaType: 'font/ttf', data: new Uint8Array(4) }];

  checkMatroskaInput({ docType: 'matroska', subtitles: [], attachments }); // fine: Matroska takes attachments
  try {
    checkMatroskaInput({ docType: 'webm', subtitles: [], attachments });
  } catch (error) {
    console.log((error as Error).message);
    return;
  }
  throw new Error('a WebM file with an attachment was accepted');
}
