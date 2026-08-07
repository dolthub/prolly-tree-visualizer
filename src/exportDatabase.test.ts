import { describe, expect, it, vi } from 'vitest';
import { exportDatabase } from './exportDatabase';

describe('exportDatabase', () => {
  it('joins chunks streamed from the active VFS file', () => {
    const memory = new Uint8Array([0, 10, 11, 12, 13, 14]);
    let callback: (pointer: number, size: number) => number = () => 1;
    const uninstallFunction = vi.fn();
    const wasm = {
      heap8u: () => memory,
      installFunction: (next: typeof callback) => {
        callback = next;
        return 27;
      },
      uninstallFunction,
      exports: {
        sqlite3__wasm_db_export_chunked: (_dbPointer: number, callbackPointer: number) => {
          expect(callbackPointer).toBe(27);
          callback(1, 3);
          callback(4, 2);
          return 0;
        },
      },
    };

    expect(exportDatabase(wasm, 42)).toEqual(new Uint8Array([10, 11, 12, 13, 14]));
    expect(uninstallFunction).toHaveBeenCalledWith(27);
  });
});
