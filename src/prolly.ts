import { toHex } from './chunkStore';
import type { ProllyEntry, ProllyNode, RowDiff, RowValue } from './types';

const PROLLY_NODE_MAGIC = 0x504e4f44;
const FLAG_INT_KEY = 0x01;
const FLAG_BLOB_KEY = 0x02;
const FLAG_SUBTREE_COUNTS = 0x04;
const HASH_SIZE = 20;
const CHUNK_MIN = 512;
const CHUNK_MAX = 16_384;
const WEIBULL_SCALE = 4096;

function assertRange(bytes: Uint8Array, offset: number, length: number, label: string) {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`${label} is outside a ${bytes.length}-byte prolly node`);
  }
}

function decodeIntKey(bytes: Uint8Array) {
  let encoded = 0n;
  for (const byte of bytes) encoded = (encoded << 8n) | BigInt(byte);
  const decoded = BigInt.asIntN(64, encoded ^ (1n << 63n));
  const number = Number(decoded);
  return Number.isSafeInteger(number) ? number : decoded.toString();
}

function readOffsets(view: DataView, start: number, count: number) {
  return Array.from({ length: count + 1 }, (_, index) => view.getUint32(start + index * 4, true));
}

function readU64(view: DataView, offset: number) {
  const value = view.getBigUint64(offset, true);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER;
}

export function parseProllyNode(hash: string, bytes: Uint8Array): ProllyNode {
  if (bytes.length < 8) throw new Error(`chunk ${hash} is too small to be a prolly node`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== PROLLY_NODE_MAGIC) throw new Error(`chunk ${hash} is not a prolly node`);

  const level = bytes[4];
  const count = view.getUint16(5, true);
  const flags = bytes[7];
  if ((flags & (FLAG_INT_KEY | FLAG_BLOB_KEY)) === 0) throw new Error(`node ${hash} has no key encoding`);

  const keyOffsetStart = 8;
  const valueOffsetStart = keyOffsetStart + (count + 1) * 4;
  const dataStart = valueOffsetStart + (count + 1) * 4;
  assertRange(bytes, 0, dataStart, `node ${hash} header`);

  const keyOffsets = readOffsets(view, keyOffsetStart, count);
  const valueOffsets = readOffsets(view, valueOffsetStart, count);
  const keyBytes = keyOffsets[count] ?? 0;
  const valueBytes = valueOffsets[count] ?? 0;
  const keyDataStart = dataStart;
  const valueDataStart = keyDataStart + keyBytes;
  const countDataStart = valueDataStart + valueBytes;
  const countBytes = flags & FLAG_SUBTREE_COUNTS ? count * 8 : 0;
  assertRange(bytes, keyDataStart, keyBytes + valueBytes + countBytes, `node ${hash} payload`);

  const entries: ProllyEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const keyStart = keyDataStart + keyOffsets[index];
    const keyEnd = keyDataStart + keyOffsets[index + 1];
    const valueStart = valueDataStart + valueOffsets[index];
    const valueEnd = valueDataStart + valueOffsets[index + 1];
    const key = bytes.subarray(keyStart, keyEnd);
    const value = bytes.subarray(valueStart, valueEnd);
    const entry: ProllyEntry = {
      key: flags & FLAG_INT_KEY ? decodeIntKey(key) : toHex(key),
      keyHex: toHex(key),
      valueHex: toHex(value),
    };
    if (level > 0) {
      if (value.length !== HASH_SIZE) throw new Error(`internal node ${hash} has a non-hash value`);
      entry.childHash = toHex(value);
      if (flags & FLAG_SUBTREE_COUNTS) entry.subtreeCount = readU64(view, countDataStart + index * 8);
    }
    entries.push(entry);
  }

  return {
    hash,
    level,
    size: bytes.length,
    flags,
    entries,
    children: [],
    minKey: entries[0]?.key ?? null,
    maxKey: entries.at(-1)?.key ?? null,
  };
}

export function buildTree(rootHash: string, chunks: Map<string, Uint8Array>) {
  const nodes = new Map<string, ProllyNode>();
  const visiting = new Set<string>();

  const visit = (hash: string): ProllyNode => {
    const existing = nodes.get(hash);
    if (existing) return existing;
    if (visiting.has(hash)) throw new Error(`cycle detected at prolly node ${hash}`);
    const bytes = chunks.get(hash);
    if (!bytes) throw new Error(`root references missing chunk ${hash}`);
    visiting.add(hash);
    const node = parseProllyNode(hash, bytes);
    nodes.set(hash, node);
    node.children = node.entries.flatMap((entry) => (entry.childHash ? [visit(entry.childHash)] : []));
    if (node.children.length > 0) {
      node.minKey = node.children[0].minKey;
      node.maxKey = node.children.at(-1)?.maxKey ?? null;
    }
    visiting.delete(hash);
    return node;
  };

  return { root: visit(rootHash), nodes };
}

function tableRootFromCatalog(chunks: Map<string, Uint8Array>, catalogHash: string, tableName: string) {
  const bytes = chunks.get(catalogHash);
  if (!bytes) throw new Error(`catalog chunk ${catalogHash} is missing from the export`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = bytes[0];
  if (format !== 0x44 && format !== 0x45 && format !== 0x46) {
    throw new Error(`chunk ${catalogHash} is not a DoltLite catalog`);
  }
  assertRange(bytes, 1, 4, `catalog ${catalogHash} header`);
  const count = view.getUint32(1, true);
  let cursor = format === 0x46 ? 13 : 5;
  const decoder = new TextDecoder();

  for (let index = 0; index < count; index += 1) {
    assertRange(bytes, cursor, 45, `catalog ${catalogHash} entry ${index}`);
    cursor += 5;
    const rootHash = toHex(bytes.subarray(cursor, cursor + HASH_SIZE));
    cursor += HASH_SIZE * 2;

    if (format === 0x44) {
      assertRange(bytes, cursor, 2, `catalog ${catalogHash} name length`);
      const nameLength = view.getUint16(cursor, true);
      cursor += 2;
      assertRange(bytes, cursor, nameLength, `catalog ${catalogHash} name`);
      const name = decoder.decode(bytes.subarray(cursor, cursor + nameLength));
      cursor += nameLength;
      if (name === tableName) return rootHash;
      continue;
    }

    assertRange(bytes, cursor, 6, `catalog ${catalogHash} name lengths`);
    const typeLength = view.getUint16(cursor, true);
    const nameLength = view.getUint16(cursor + 2, true);
    const tableLength = view.getUint16(cursor + 4, true);
    cursor += 6;
    assertRange(bytes, cursor, typeLength + nameLength + tableLength, `catalog ${catalogHash} names`);
    const type = decoder.decode(bytes.subarray(cursor, cursor + typeLength));
    cursor += typeLength;
    const name = decoder.decode(bytes.subarray(cursor, cursor + nameLength));
    cursor += nameLength + tableLength;
    if (type === 'table' && name === tableName) return rootHash;
  }
  throw new Error(`table ${tableName} is missing from catalog ${catalogHash}`);
}

export function findTableRoot(chunks: Map<string, Uint8Array>, rowKeys: number[], catalogHash?: string, tableName = 'prolly_rows') {
  if (catalogHash) {
    const tree = buildTree(tableRootFromCatalog(chunks, catalogHash, tableName), chunks);
    const actual = leafNodes(tree.root).flatMap((leaf) => leaf.entries.map((entry) => entry.key));
    const wanted = [...rowKeys].sort((left, right) => left - right);
    if (actual.length !== wanted.length || !actual.every((key, index) => key === wanted[index])) {
      throw new Error(`catalog root for ${tableName} does not contain the ${rowKeys.length} SQL rows`);
    }
    return tree;
  }

  const prollyNodes = new Map<string, ProllyNode>();
  const referenced = new Set<string>();
  for (const [hash, bytes] of chunks) {
    try {
      const node = parseProllyNode(hash, bytes);
      prollyNodes.set(hash, node);
      for (const entry of node.entries) if (entry.childHash) referenced.add(entry.childHash);
    } catch {
      // The content-addressed store also contains catalogs, commits, and refs.
    }
  }

  const wanted = [...rowKeys].sort((left, right) => left - right);
  const candidates = [...prollyNodes.values()]
    .filter((node) => !referenced.has(node.hash))
    .sort((left, right) => right.level - left.level);

  for (const candidate of candidates) {
    try {
      const tree = buildTree(candidate.hash, chunks);
      const actual = leafNodes(tree.root).flatMap((leaf) => leaf.entries.map((entry) => entry.key));
      if (actual.length === wanted.length && actual.every((key, index) => key === wanted[index])) {
        return tree;
      }
    } catch {
      // A root from an older snapshot can reference chunks absent from an export.
    }
  }
  throw new Error(`could not identify the prolly root for ${rowKeys.length} SQL rows`);
}

export function traceSearch(root: ProllyNode, key: number) {
  const trace: string[] = [];
  let node: ProllyNode | undefined = root;
  while (node) {
    trace.push(node.hash);
    if (node.level === 0) break;
    let index = node.entries.findIndex((entry) => Number(entry.key) >= key);
    if (index < 0) index = node.entries.length - 1;
    node = node.children[index];
  }
  return trace;
}

export function traceRange(root: ProllyNode, start: number, end: number) {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  const trace: string[] = [];
  const visit = (node: ProllyNode) => {
    const min = Number(node.minKey);
    const max = Number(node.maxKey);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < low || min > high) return;
    trace.push(node.hash);
    node.children.forEach(visit);
  };
  visit(root);
  return trace;
}

export function diffRows(before: RowValue[], after: RowValue[]): RowDiff[] {
  const left = new Map(before.map((row) => [row.key, row.value]));
  const right = new Map(after.map((row) => [row.key, row.value]));
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a - b);
  return keys.flatMap((key): RowDiff[] => {
    const oldValue = left.get(key);
    const newValue = right.get(key);
    if (oldValue === newValue) return [];
    if (oldValue === undefined) return [{ key, after: newValue, kind: 'added' }];
    if (newValue === undefined) return [{ key, before: oldValue, kind: 'deleted' }];
    return [{ key, before: oldValue, after: newValue, kind: 'modified' }];
  });
}

export function groupRowDiffsByLeaf(root: ProllyNode, diffs: RowDiff[]) {
  const grouped = new Map<string, RowDiff[]>();
  for (const diff of diffs) {
    const leafHash = traceSearch(root, diff.key).at(-1);
    if (!leafHash) continue;
    const existing = grouped.get(leafHash);
    if (existing) existing.push(diff);
    else grouped.set(leafHash, [diff]);
  }
  return grouped;
}

export function leafNodes(root: ProllyNode) {
  const leaves: ProllyNode[] = [];
  const visit = (node: ProllyNode) => {
    if (node.level === 0) leaves.push(node);
    else node.children.forEach(visit);
  };
  visit(root);
  return leaves;
}

export function countSharedNodes(left: Map<string, ProllyNode>, right: Map<string, ProllyNode>) {
  let shared = 0;
  for (const hash of left.keys()) if (right.has(hash)) shared += 1;
  return shared;
}

function boundaryProbability(size: number, itemSize: number) {
  if (size < CHUNK_MIN) return 0;
  if (size >= CHUNK_MAX) return 1;
  const cdf = (bytes: number) => -Math.expm1(-Math.pow(bytes / WEIBULL_SCALE, 4));
  const start = cdf(size - itemSize);
  const end = cdf(size);
  return Math.max(0, Math.min(1, (end - start) / (1 - start)));
}

export function estimateMutationSplitProbability(node: ProllyNode) {
  if (node.level !== 0 || node.entries.length === 0) return 0;
  const itemSizes = node.entries.map((entry) => entry.keyHex.length / 2 + entry.valueHex.length / 2 + 8);
  const averageItemSize = itemSizes.reduce((total, size) => total + size, 0) / itemSizes.length;
  let runningSize = itemSizes[0];
  let weightedProbability = 0;
  let availableKeys = 0;
  for (let index = 1; index < itemSizes.length; index += 1) {
    const left = Number(node.entries[index - 1].key);
    const right = Number(node.entries[index].key);
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return 0;
    const gap = Math.max(0, right - left - 1);
    weightedProbability += gap * boundaryProbability(runningSize + averageItemSize, averageItemSize);
    availableKeys += gap;
    runningSize += itemSizes[index];
  }
  return availableKeys > 0 ? weightedProbability / availableKeys : 0;
}
