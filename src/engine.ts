import sqlite3InitModule from '@dolthub/doltlite-wasm';
import doltliteWasmUrl from '@dolthub/doltlite-wasm/sqlite3.wasm?url';
import { parseChunkStore } from './chunkStore';
import { exportDatabase } from './exportDatabase';
import { findTableRoot, leafNodes } from './prolly';
import type { RowValue, TreeSnapshot } from './types';

type Db = Awaited<ReturnType<typeof sqlite3InitModule>>['oo1']['DB'] extends new (...args: never[]) => infer T ? T : never;

export interface HistoryIndependenceResult {
  forwardHash: string;
  reverseHash: string;
  identical: boolean;
  rowCount: number;
}

export class ProllyEngine {
  private readonly sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
  private db: Db;
  private snapshotId = 0;
  readonly version: string;

  private constructor(sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>) {
    this.sqlite3 = sqlite3;
    this.db = this.openDb();
    this.version = String(this.db.selectValue('SELECT dolt_version()'));
  }

  static async create() {
    const sqlite3 = await sqlite3InitModule({
      locateFile: (filename: string) => filename === 'sqlite3.wasm' ? doltliteWasmUrl : filename,
    });
    const engine = new ProllyEngine(sqlite3);
    engine.createSchema();
    return engine;
  }

  private openDb() {
    return new this.sqlite3.oo1.DB(`/prolly-tree-lab-${Date.now()}-${Math.random()}.db`, 'c') as Db;
  }

  private createSchema() {
    this.db.exec('CREATE TABLE prolly_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  }

  private rows(): RowValue[] {
    return this.db.selectObjects('SELECT id, value FROM prolly_rows ORDER BY id').map((row) => ({
      key: Number(row.id),
      value: String(row.value),
    }));
  }

  seed(count = 240) {
    this.db.exec(`WITH RECURSIVE seq(key) AS (
      VALUES(1) UNION ALL SELECT key + 1 FROM seq WHERE key < ${Math.max(1, Math.trunc(count))}
    ) INSERT INTO prolly_rows SELECT key, printf('value-%d', key) FROM seq`);
    return this.capture(`Built ${count} sorted rows`);
  }

  capture(label: string): TreeSnapshot {
    const rows = this.rows();
    const bytes = exportDatabase(this.sqlite3.wasm, this.db.pointer);
    const image = parseChunkStore(bytes);
    const { root, nodes } = findTableRoot(image.chunks, rows.map((row) => row.key));
    const rootHash = root.hash;
    return {
      id: this.snapshotId++,
      label,
      rootHash,
      root,
      rows,
      nodes,
      chunksInStore: image.chunks.size,
      databaseBytes: bytes.length,
      timestamp: Date.now(),
    };
  }

  put(key: number, value: string) {
    const exists = Number(this.db.selectValue(`SELECT EXISTS(SELECT 1 FROM prolly_rows WHERE id = ${Math.trunc(key)})`));
    this.db.exec({
      sql: 'INSERT INTO prolly_rows(id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      bind: [key, value],
    });
    return this.capture(`${exists ? 'Updated' : 'Inserted'} key ${key}`);
  }

  remove(key: number) {
    this.db.exec({ sql: 'DELETE FROM prolly_rows WHERE id = ?', bind: [key] });
    return this.capture(`Deleted key ${key}`);
  }

  addSequential(count: number) {
    const first = Number(this.db.selectValue('SELECT COALESCE(MAX(id), 0) + 1 FROM prolly_rows'));
    const last = first + Math.max(1, Math.trunc(count)) - 1;
    this.db.exec(`WITH RECURSIVE seq(key) AS (
      VALUES(${first}) UNION ALL SELECT key + 1 FROM seq WHERE key < ${last}
    ) INSERT INTO prolly_rows SELECT key, printf('value-%d', key) FROM seq`);
    return this.capture(`Appended ${count} sequential rows`);
  }

  addRandom() {
    const used = new Set(this.rows().map((row) => row.key));
    let key = 1;
    do key = Math.floor(Math.random() * Math.max(160, used.size * 4)) + 1;
    while (used.has(key));
    return this.put(key, `random-${key}`);
  }

  growUntilSplit(limit = 200) {
    const before = this.capture('Before split search');
    const leafCount = leafNodes(before.root).length;
    let next = Number(this.db.selectValue('SELECT COALESCE(MAX(id), 0) + 1 FROM prolly_rows'));
    for (let added = 1; added <= limit; added += 1, next += 1) {
      this.db.exec({ sql: 'INSERT INTO prolly_rows VALUES (?, ?)', bind: [next, `split-${next}`] });
      const candidate = this.capture(`Split after inserting key ${next}`);
      if (leafNodes(candidate.root).length > leafCount) return { before, after: candidate, added };
    }
    return { before, after: this.capture(`No split after ${limit} inserts`), added: limit };
  }

  reset(count = 240) {
    this.db.close();
    this.db = this.openDb();
    this.snapshotId = 0;
    this.createSchema();
    return this.seed(count);
  }

  historyIndependence(rows: RowValue[]): HistoryIndependenceResult {
    const build = (ordered: RowValue[]) => {
      const db = this.openDb();
      try {
        db.exec('CREATE TABLE prolly_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
        db.exec('BEGIN');
        for (const row of ordered) {
          db.exec({ sql: 'INSERT INTO prolly_rows VALUES (?, ?)', bind: [row.key, row.value] });
        }
        db.exec('COMMIT');
        return String(db.selectValue("SELECT dolt_hashof_table('prolly_rows')"));
      } finally {
        db.close();
      }
    };
    const forwardHash = build(rows);
    const reverseHash = build([...rows].reverse());
    return { forwardHash, reverseHash, identical: forwardHash === reverseHash, rowCount: rows.length };
  }

  close() {
    this.db.close();
  }
}
