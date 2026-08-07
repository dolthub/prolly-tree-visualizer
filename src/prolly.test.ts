import { describe, expect, it } from 'vitest';
import { buildTree, diffRows, findTableRoot, parseProllyNode, traceSearch } from './prolly';

function u16(value: number) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function intKey(value: number) {
  let encoded = BigInt.asUintN(64, BigInt(value)) ^ (1n << 63n);
  const bytes = new Uint8Array(8);
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(encoded & 0xffn);
    encoded >>= 8n;
  }
  return bytes;
}

function node(level: number, keys: number[], values: Uint8Array[]) {
  const keyData = keys.flatMap((key) => [...intKey(key)]);
  const valueData = values.flatMap((value) => [...value]);
  const keyOffsets = keys.flatMap((_, index) => u32(index * 8)).concat(u32(keys.length * 8));
  let valueOffset = 0;
  const valueOffsets: number[] = [];
  for (const value of values) {
    valueOffsets.push(...u32(valueOffset));
    valueOffset += value.length;
  }
  valueOffsets.push(...u32(valueOffset));
  return new Uint8Array([
    0x44, 0x4f, 0x4e, 0x50,
    level,
    ...u16(keys.length),
    0x01,
    ...keyOffsets,
    ...valueOffsets,
    ...keyData,
    ...valueData,
  ]);
}

describe('prolly node decoder', () => {
  it('decodes signed integer leaf keys and values', () => {
    const parsed = parseProllyNode('a'.repeat(40), node(0, [-2, 4], [new Uint8Array([1]), new Uint8Array([2, 3])]));
    expect(parsed.level).toBe(0);
    expect(parsed.entries.map((entry) => entry.key)).toEqual([-2, 4]);
    expect(parsed.entries.map((entry) => entry.valueHex)).toEqual(['01', '0203']);
  });

  it('builds child links and traces the delimiter path', () => {
    const leftHash = '1'.repeat(40);
    const rightHash = '2'.repeat(40);
    const rootHash = '3'.repeat(40);
    const chunks = new Map([
      [leftHash, node(0, [1, 3], [new Uint8Array([1]), new Uint8Array([3])])],
      [rightHash, node(0, [7, 9], [new Uint8Array([7]), new Uint8Array([9])])],
      [rootHash, node(1, [3, 9], [Uint8Array.from({ length: 20 }, () => 0x11), Uint8Array.from({ length: 20 }, () => 0x22)])],
    ]);
    const tree = buildTree(rootHash, chunks);
    expect(tree.root.children).toHaveLength(2);
    expect(traceSearch(tree.root, 8)).toEqual([rootHash, rightHash]);
    expect(findTableRoot(chunks, [1, 3, 7, 9]).root.hash).toBe(rootHash);
  });
});

describe('row diff', () => {
  it('classifies additions, edits, and deletes', () => {
    expect(diffRows(
      [{ key: 1, value: 'old' }, { key: 2, value: 'gone' }],
      [{ key: 1, value: 'new' }, { key: 3, value: 'added' }],
    )).toEqual([
      { key: 1, before: 'old', after: 'new', kind: 'modified' },
      { key: 2, before: 'gone', kind: 'deleted' },
      { key: 3, after: 'added', kind: 'added' },
    ]);
  });
});
