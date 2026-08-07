declare module '@dolthub/doltlite-wasm' {
  interface DoltLiteDb {
    pointer: number;
    close(): void;
    exec(options: string | { sql: string; bind?: unknown[] }): void;
    selectValue(sql: string): unknown;
    selectObjects(sql: string): Array<Record<string, unknown>>;
  }

  interface DoltLiteNamespace {
    wasm: {
      exports: {
        sqlite3__wasm_db_export_chunked(dbPointer: number, callbackPointer: number): number;
      };
      heap8u(): Uint8Array;
      installFunction(callback: (pointer: number, size: number) => number, signature: string): number;
      uninstallFunction(pointer: number): void;
    };
    oo1: {
      DB: new (filename?: string, flags?: string) => DoltLiteDb;
    };
  }

  export function sqlite3InitModule(options?: Record<string, unknown>): Promise<DoltLiteNamespace>;
  export default sqlite3InitModule;
}
