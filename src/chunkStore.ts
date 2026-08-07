const MANIFEST_SIZE = 168;
const INDEX_ENTRY_SIZE = 32;
const HASH_SIZE = 20;
const CHUNK_STORE_MAGIC = 0x444c5443;
const WAL_TAG_CHUNK = 0x01;
const WAL_TAG_ROOT = 0x02;

export interface ChunkStoreImage {
  version: number;
  chunks: Map<string, Uint8Array>;
}

function assertRange(bytes: Uint8Array, offset: number, length: number, label: string) {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`${label} is outside the ${bytes.length}-byte database image`);
  }
}

function u32(view: DataView, offset: number) {
  return view.getUint32(offset, true);
}

function safeI64(view: DataView, offset: number, label: string) {
  const value = view.getBigInt64(offset, true);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} is not a safe file offset`);
  }
  return number;
}

export function toHex(bytes: Uint8Array) {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

function readIndex(bytes: Uint8Array, view: DataView, chunks: Map<string, Uint8Array>) {
  const indexOffset = safeI64(view, 32, 'index offset');
  const indexSize = u32(view, 40);
  if (indexSize === 0) return;
  if (indexSize % INDEX_ENTRY_SIZE !== 0) throw new Error('invalid DoltLite chunk index size');
  assertRange(bytes, indexOffset, indexSize, 'chunk index');

  for (let cursor = indexOffset; cursor < indexOffset + indexSize; cursor += INDEX_ENTRY_SIZE) {
    const hash = toHex(bytes.subarray(cursor, cursor + HASH_SIZE));
    const dataOffset = safeI64(view, cursor + HASH_SIZE, 'chunk offset');
    const size = u32(view, cursor + HASH_SIZE + 8);
    assertRange(bytes, dataOffset, 4 + size, `chunk ${hash}`);
    if (u32(view, dataOffset) !== size) throw new Error(`stored length mismatch for chunk ${hash}`);
    chunks.set(hash, bytes.slice(dataOffset + 4, dataOffset + 4 + size));
  }
}

function readWal(bytes: Uint8Array, view: DataView, chunks: Map<string, Uint8Array>) {
  let cursor = safeI64(view, 84, 'WAL offset');
  if (cursor === 0) return;

  while (cursor < bytes.length) {
    const tag = bytes[cursor];
    if (tag === WAL_TAG_CHUNK) {
      assertRange(bytes, cursor, 1 + HASH_SIZE + 4, 'WAL chunk header');
      const hash = toHex(bytes.subarray(cursor + 1, cursor + 1 + HASH_SIZE));
      const size = u32(view, cursor + 1 + HASH_SIZE);
      const dataOffset = cursor + 1 + HASH_SIZE + 4;
      assertRange(bytes, dataOffset, size, `WAL chunk ${hash}`);
      chunks.set(hash, bytes.slice(dataOffset, dataOffset + size));
      cursor = dataOffset + size;
      continue;
    }

    if (tag === WAL_TAG_ROOT) {
      assertRange(bytes, cursor + 1, MANIFEST_SIZE, 'WAL root record');
      const nextOffset = safeI64(view, cursor + 1 + 52, 'next WAL batch offset');
      const afterRecord = cursor + 1 + MANIFEST_SIZE;
      cursor = nextOffset > afterRecord && nextOffset <= bytes.length ? nextOffset : afterRecord;
      continue;
    }

    let next = cursor + 1;
    while (next < bytes.length && bytes[next] === 0) next += 1;
    if (next === bytes.length) break;
    if (bytes[next] !== WAL_TAG_CHUNK && bytes[next] !== WAL_TAG_ROOT) break;
    cursor = next;
  }
}

export function parseChunkStore(bytes: Uint8Array): ChunkStoreImage {
  assertRange(bytes, 0, MANIFEST_SIZE, 'DoltLite manifest');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (u32(view, 0) !== CHUNK_STORE_MAGIC) throw new Error('export is not a DoltLite chunk store');

  const chunks = new Map<string, Uint8Array>();
  readIndex(bytes, view, chunks);
  readWal(bytes, view, chunks);
  return { version: u32(view, 4), chunks };
}
