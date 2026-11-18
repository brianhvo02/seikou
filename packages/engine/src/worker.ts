// SPDX-License-Identifier: LGPL-3.0-or-later
// The package's engine worker entry (createEngineWorker): the engine without BD-J and with the package's own assets.
import audioWasmUrl from '../wasm/audio/audio.wasm?url';
import videoWasmUrl from '../wasm/video/video.wasm?url';
import mpeg2BenchUrl from '../wasm/video/bench/mpeg2-1080i.m2v?url';
import vc1BenchUrl from '../wasm/video/bench/vc1-1080i.vc1?url';
import defaultFontUrl from '@seikou/ass/default-font.ttf?url';
import { startEngineWorker } from './worker-main';

startEngineWorker({ audioWasmUrl, defaultFontUrl, videoWasmUrl, videoBenchUrls: { mpeg2: mpeg2BenchUrl, vc1: vc1BenchUrl } });
