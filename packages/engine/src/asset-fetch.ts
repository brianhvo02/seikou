// SPDX-License-Identifier: LGPL-3.0-or-later
// The engine's limit on fetching its own assets, shared by the engine worker and the video decoder worker.

/** The wait for an asset a worker fetches: the audio and video wasm, the default font (and a provider's class library jars). */
export const ASSET_FETCH_TIMEOUT_MS = 20_000;
