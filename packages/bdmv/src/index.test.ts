import { expect, it } from 'vitest';
import { ByteReader } from '@seikou/bdmv/byte-reader';
import * as bdmv from '@seikou/bdmv';
it('resolves the package by name and through the barrel', () => {
  expect(new ByteReader(new Uint8Array([1, 2])).u8()).toBe(1);
  expect(typeof bdmv.ByteReader).toBe('function');
});
