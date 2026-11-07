// SPDX-License-Identifier: LGPL-2.1-or-later
// The package's engine worker entry (createEngineWorker): the engine without BD-J and with the package's own assets.
import audioWasmUrl from '../wasm/audio/audio.wasm?url';
import defaultFontUrl from '@seikou/ass/default-font.ttf?url';
import { startEngineWorker } from './worker-main';

startEngineWorker({ audioWasmUrl, defaultFontUrl });
