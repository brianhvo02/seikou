/** 4-byte TP_extra_header + 188-byte transport packet. */
export const SOURCE_PACKET_SIZE = 192;
export const TS_PACKET_SIZE = 188;
export const PACKETS_PER_ALIGNED_UNIT = 32;
export const ALIGNED_UNIT_SIZE = SOURCE_PACKET_SIZE * PACKETS_PER_ALIGNED_UNIT;
export const NULL_PID = 0x1fff;
