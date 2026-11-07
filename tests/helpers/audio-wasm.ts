/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAudioWasm, type AudioWasm } from '@seikou/engine/decode/wasm-audio';

const WASM = fileURLToPath(new URL('../../packages/engine/wasm/audio/audio.wasm', import.meta.url));

export function loadNodeAudioWasm(): Promise<AudioWasm> {
  return loadAudioWasm(readFileSync(WASM));
}
