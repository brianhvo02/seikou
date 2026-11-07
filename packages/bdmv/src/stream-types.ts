/** Stream coding types used in MPLS STN tables and CLPI program info (libbluray bdnav/mpls_data.h). */
export const CodingType = {
  MPEG1_VIDEO: 0x01,
  MPEG2_VIDEO: 0x02,
  MPEG1_AUDIO: 0x03,
  MPEG2_AUDIO: 0x04,
  AVC: 0x1b,
  MVC: 0x20,
  HEVC: 0x24,
  VC1: 0xea,
  LPCM: 0x80,
  AC3: 0x81,
  DTS: 0x82,
  TRUEHD: 0x83,
  EAC3: 0x84,
  DTSHD: 0x85,
  DTSHD_MASTER: 0x86,
  EAC3_SECONDARY: 0xa1,
  DTSHD_SECONDARY: 0xa2,
  PG: 0x90,
  IG: 0x91,
  TEXT_SUBTITLE: 0x92,
} as const;

const VIDEO_TYPES = new Set<number>([0x01, 0x02, 0x1b, 0x20, 0x24, 0xea]);
const AUDIO_TYPES = new Set<number>([0x03, 0x04, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0xa1, 0xa2]);

const NAMES: Readonly<Record<number, string>> = {
  0x01: 'MPEG-1 video',
  0x02: 'MPEG-2 video',
  0x03: 'MPEG-1 audio',
  0x04: 'MPEG-2 audio',
  0x1b: 'H.264/AVC',
  0x20: 'H.264/MVC',
  0x24: 'H.265/HEVC',
  0xea: 'VC-1',
  0x80: 'LPCM',
  0x81: 'Dolby Digital (AC-3)',
  0x82: 'DTS',
  0x83: 'Dolby TrueHD',
  0x84: 'Dolby Digital Plus (E-AC-3)',
  0x85: 'DTS-HD High Resolution',
  0x86: 'DTS-HD Master Audio',
  0xa1: 'Dolby Digital Plus (secondary)',
  0xa2: 'DTS-HD (secondary)',
  0x90: 'PG subtitles',
  0x91: 'Interactive graphics',
  0x92: 'Text subtitles',
};

export function isVideoCoding(codingType: number): boolean {
  return VIDEO_TYPES.has(codingType);
}

export function isAudioCoding(codingType: number): boolean {
  return AUDIO_TYPES.has(codingType);
}

export function codingName(codingType: number): string {
  return NAMES[codingType] ?? `unknown codec 0x${codingType.toString(16)}`;
}
