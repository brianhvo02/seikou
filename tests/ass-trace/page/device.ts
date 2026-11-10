// SPDX-License-Identifier: LGPL-3.0-or-later
/** The device-font check page: whether local() loads on this page, and what the renderer's fonts do in a worker. */
import type { DeviceCheckPage, DeviceWorkerResult } from './types';

const page: DeviceCheckPage = {
  async localOnPage(family) {
    try {
      await new FontFace('device-check', `local('${family}')`).load();
      return true;
    } catch {
      return false;
    }
  },
  inWorker(family) {
    const worker = new Worker(new URL('./device-worker.ts', import.meta.url), { type: 'module' });
    return new Promise<DeviceWorkerResult>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<DeviceWorkerResult>) => { worker.terminate(); resolve(e.data); };
      worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
      worker.postMessage(family);
    });
  },
};

(window as unknown as { deviceCheck: DeviceCheckPage }).deviceCheck = page;
