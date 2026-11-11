import type { RegistryState, RegistryStorage } from './code-registry';

/**
 * Test stand-in for a Durable Object's state: the KV-style storage API and the alarm, in memory.
 * Values are cloned in and out, as the real storage serializes them.
 */
export class MemoryStorage implements RegistryStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async list<T>(options: { prefix: string; limit?: number; startAfter?: string }): Promise<Map<string, T>> {
    const { prefix, limit = Infinity, startAfter } = options;
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter))
      .sort()
      .slice(0, limit);
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }
}

/** Runs the registry's alarm as the runtime does: the pending alarm is cleared before the handler runs. */
export async function fireAlarm(storage: MemoryStorage, registry: { alarm(): Promise<void> }): Promise<void> {
  storage.alarm = null;
  await registry.alarm();
}

/** A fresh in-memory state for a `CodeRegistry` in a test. */
export function memoryState(): RegistryState & { storage: MemoryStorage } {
  return { storage: new MemoryStorage() };
}
