const moduleName = process.env.DOLTLITE_WASM_MODULE ?? '@dolthub/doltlite-wasm/sqlite3-node.mjs';
const { default: sqlite3InitModule } = await import(moduleName);

const sqlite3 = await sqlite3InitModule();
const db = new sqlite3.oo1.DB('/prolly-tree-smoke.db', 'c');
const rowCount = Number(process.env.SMOKE_ROWS ?? 96);

function exportDirect(dbPointer) {
  const chunks = [];
  const callback = sqlite3.wasm.installFunction((pointer, size) => {
    chunks.push(sqlite3.wasm.heap8u().slice(pointer, pointer + size));
    return 0;
  }, 'i(pi)');
  try {
    const rc = sqlite3.wasm.exports.sqlite3__wasm_db_export_chunked(dbPointer, callback);
    if (rc) throw new Error(`direct database export failed with code ${rc}`);
  } finally {
    sqlite3.wasm.uninstallFunction(callback);
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

try {
  db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  const bulkRows = process.env.SMOKE_INCREMENTAL ? Math.min(96, rowCount) : rowCount;
  db.exec(`WITH RECURSIVE seq(key) AS (
    VALUES(1) UNION ALL SELECT key + 1 FROM seq WHERE key < ${bulkRows}
  ) INSERT INTO rows SELECT key, printf('value-%d', key) FROM seq`);
  for (let key = bulkRows + 1; key <= rowCount; key += 1) {
    db.exec({ sql: 'INSERT INTO rows VALUES (?, ?)', bind: [key, `value-${key}`] });
  }
  const engine = db.selectValue('SELECT doltlite_engine()');
  const root = db.selectValue("SELECT dolt_hashof_table('rows')");
  const bytes = exportDirect(db.pointer);

  if (engine !== 'prolly') throw new Error(`expected prolly engine, got ${engine}`);
  if (!/^[0-9a-f]{40}$/.test(root)) throw new Error(`invalid table root: ${root}`);
  if (bytes.length < 168) throw new Error(`database export is too small: ${bytes.length}`);

  console.log(`engine=${engine}`);
  console.log(`root=${root}`);
  console.log(`export_bytes=${bytes.length}`);
} finally {
  db.close();
}
