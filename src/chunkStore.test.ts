import { describe, expect, it } from 'vitest';
import { parseChunkStore } from './chunkStore';

function writeU32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

function writeI64(view: DataView, offset: number, value: number) {
  view.setBigInt64(offset, BigInt(value), true);
}

describe('DoltLite chunk-store decoder', () => {
  it('reads compacted index and WAL chunks', () => {
    const indexedData = new Uint8Array([10, 20, 30]);
    const walData = new Uint8Array([40, 50]);
    const indexedHash = Uint8Array.from({ length: 20 }, () => 0xaa);
    const walHash = Uint8Array.from({ length: 20 }, () => 0xbb);
    const indexedOffset = 168;
    const indexOffset = indexedOffset + 4 + indexedData.length;
    const walOffset = indexOffset + 32;
    const bytes = new Uint8Array(walOffset + 1 + 20 + 4 + walData.length);
    const view = new DataView(bytes.buffer);
    writeU32(view, 0, 0x444c5443);
    writeU32(view, 4, 12);
    writeI64(view, 32, indexOffset);
    writeU32(view, 40, 32);
    writeI64(view, 84, walOffset);
    writeU32(view, indexedOffset, indexedData.length);
    bytes.set(indexedData, indexedOffset + 4);
    bytes.set(indexedHash, indexOffset);
    writeI64(view, indexOffset + 20, indexedOffset);
    writeU32(view, indexOffset + 28, indexedData.length);
    bytes[walOffset] = 1;
    bytes.set(walHash, walOffset + 1);
    writeU32(view, walOffset + 21, walData.length);
    bytes.set(walData, walOffset + 25);

    const parsed = parseChunkStore(bytes);
    expect(parsed.version).toBe(12);
    expect([...parsed.chunks.values()].map((value) => [...value])).toEqual([[10, 20, 30], [40, 50]]);
  });

  it('rejects non-DoltLite images', () => {
    expect(() => parseChunkStore(new Uint8Array(168))).toThrow('not a DoltLite chunk store');
  });
});
