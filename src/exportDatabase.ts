interface WasmExports {
  sqlite3__wasm_db_export_chunked(dbPointer: number, callbackPointer: number): number;
}

interface WasmApi {
  exports: WasmExports;
  heap8u(): Uint8Array;
  installFunction(callback: (pointer: number, size: number) => number, signature: string): number;
  uninstallFunction(pointer: number): void;
}

export function exportDatabase(wasm: WasmApi, dbPointer: number) {
  const chunks: Uint8Array[] = [];
  const callback = wasm.installFunction((pointer, size) => {
    chunks.push(wasm.heap8u().slice(pointer, pointer + size));
    return 0;
  }, 'i(pi)');

  try {
    const rc = wasm.exports.sqlite3__wasm_db_export_chunked(dbPointer, callback);
    if (rc) throw new Error(`database export failed with SQLite result code ${rc}`);
  } finally {
    wasm.uninstallFunction(callback);
  }

  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
