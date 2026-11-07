/** Splits an Annex-B byte stream into NAL units (start codes removed, trailing zero bytes trimmed). */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) nals.push(trimTrailingZeros(data.subarray(start, i)));
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < data.length) nals.push(trimTrailingZeros(data.subarray(start)));
  return nals.filter((n) => n.length > 0);
}

function trimTrailingZeros(nal: Uint8Array): Uint8Array {
  let end = nal.length;
  while (end > 0 && nal[end - 1] === 0) end--;
  return nal.subarray(0, end);
}

/** Removes emulation-prevention bytes (0x03 following two zero bytes). */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (const b of nal) {
    if (zeros >= 2 && b === 0x03) {
      zeros = 0;
      continue;
    }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

export function joinAnnexB(nals: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(nals.reduce((sum, n) => sum + 4 + n.length, 0));
  let at = 0;
  for (const nal of nals) {
    out.set([0, 0, 0, 1], at);
    out.set(nal, at + 4);
    at += 4 + nal.length;
  }
  return out;
}
