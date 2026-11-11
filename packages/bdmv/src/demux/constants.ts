/**
 * Bytes in one source packet of a Blu-ray `.m2ts` clip: a 4-byte TP_extra_header (2 bits of copy permission and a
 * 30-bit arrival time stamp) followed by a 188-byte transport packet. SPNs (source packet numbers) count these.
 */
export const SOURCE_PACKET_SIZE = 192;
/** Bytes in one MPEG-2 transport stream packet (ISO/IEC 13818-1 §2.4.3.2). */
export const TS_PACKET_SIZE = 188;
/** Source packets in one aligned unit, the 6144-byte unit Blu-ray clips are recorded (and AACS-encrypted) in. */
export const PACKETS_PER_ALIGNED_UNIT = 32;
/** Bytes in one aligned unit, 6144. */
export const ALIGNED_UNIT_SIZE = SOURCE_PACKET_SIZE * PACKETS_PER_ALIGNED_UNIT;
/** The PID of null (stuffing) packets, which carry no data (ISO/IEC 13818-1 §2.4.3.3). */
export const NULL_PID = 0x1fff;
