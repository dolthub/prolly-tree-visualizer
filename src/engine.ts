import sqlite3InitModule from '@dolthub/doltlite-wasm';
import doltliteWasmUrl from '@dolthub/doltlite-wasm/sqlite3.wasm?url';
import { bootstrapKeys, deterministicShuffle } from './bootstrap';
import { parseChunkStore } from './chunkStore';
import { exportDatabase } from './exportDatabase';
import { findTableRoot, leafNodes } from './prolly';
import type { RowValue, TreeSnapshot } from './types';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Db = Sqlite3['oo1']['DB'] extends new (...args: never[]) => infer T ? T : never;
type ModuleCache = typeof globalThis & { prollyTreeSqlite3?: Promise<Sqlite3> };

function loadSqlite3() {
  const cache = globalThis as ModuleCache;
  if (!cache.prollyTreeSqlite3) {
    cache.prollyTreeSqlite3 = sqlite3InitModule({
      locateFile: (filename: string) => filename === 'sqlite3.wasm' ? doltliteWasmUrl : filename,
    }).catch((cause) => {
      delete cache.prollyTreeSqlite3;
      throw cause;
    });
  }
  return cache.prollyTreeSqlite3;
}

export interface GrowthResult {
  before: TreeSnapshot;
  after: TreeSnapshot;
  added: number;
}

export interface GarbageCollectionResult {
  head: TreeSnapshot;
  message: string;
  beforeChunks: number;
  afterChunks: number;
  beforeBytes: number;
  afterBytes: number;
}

export interface InsertionOrderBuild {
  order: number[];
  updates: number[];
  rootHash: string;
  nodeHashes: string[];
  snapshot: TreeSnapshot;
}

export interface InsertionOrderSource {
  rootHash: string;
  nodeHashes: string[];
  snapshot: TreeSnapshot;
}

export interface InsertionOrderResult {
  current: InsertionOrderSource;
  rebuilt: InsertionOrderBuild;
  identicalRoot: boolean;
  identicalChunks: boolean;
  rowCount: number;
}

export class ProllyEngine {
  private readonly sqlite3: Sqlite3;
  private db: Db;
  private snapshotId = 0;
  readonly version: string;

  private constructor(sqlite3: Sqlite3) {
    this.sqlite3 = sqlite3;
    this.db = this.openDb();
    this.version = String(this.db.selectValue('SELECT dolt_version()'));
  }

  static async create() {
    const sqlite3 = await loadSqlite3();
    const engine = new ProllyEngine(sqlite3);
    engine.createSchema();
    return engine;
  }

  private openDb() {
    return new this.sqlite3.oo1.DB(`/prolly-tree-lab-${Date.now()}-${Math.random()}.db`, 'c') as Db;
  }

  private createSchema(db = this.db) {
    db.exec('CREATE TABLE prolly_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  }

  private rows(db = this.db): RowValue[] {
    return db.selectObjects('SELECT id, value FROM prolly_rows ORDER BY id').map((row) => ({
      key: Number(row.id),
      value: String(row.value),
    }));
  }

  seed(count = 240) {
    const keys = bootstrapKeys(count);
    const values = keys.map((key) => `(${key}, 'value-${key}')`).join(',');
    this.db.exec(`INSERT INTO prolly_rows(id, value) VALUES ${values}`);
    return this.capture(`Built ${keys.length} sparse rows`);
  }

  capture(label: string): TreeSnapshot {
    return this.captureDb(this.db, label);
  }

  private captureDb(db: Db, label: string): TreeSnapshot {
    const rows = this.rows(db);
    const catalogHash = String(db.selectValue('SELECT dolt_hashof_catalog()'));
    const bytes = exportDatabase(this.sqlite3.wasm, db.pointer);
    const image = parseChunkStore(bytes);
    const { root, nodes } = findTableRoot(image.chunks, rows.map((row) => row.key), catalogHash);
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

  removeRandom() {
    const rows = this.rows();
    const row = rows[Math.floor(Math.random() * rows.length)];
    return row ? this.remove(row.key) : this.capture('No rows to delete');
  }

  addSequential(count: number) {
    const first = Number(this.db.selectValue('SELECT COALESCE(MAX(id), 0) + 1 FROM prolly_rows'));
    this.insertSequential(first, count, 'value');
    return this.capture(`Appended ${count} sequential rows`);
  }

  private insertSequential(first: number, count: number, prefix: string) {
    const amount = Math.max(1, Math.trunc(count));
    const last = first + amount - 1;
    this.db.exec(`WITH RECURSIVE seq(key) AS (
      VALUES(${first}) UNION ALL SELECT key + 1 FROM seq WHERE key < ${last}
    ) INSERT INTO prolly_rows SELECT key, printf('${prefix}-%d', key) FROM seq`);
  }

  private insertLevelRows(first: number, count: number) {
    const amount = Math.max(1, Math.trunc(count));
    const last = first + amount - 1;
    this.db.exec(`WITH RECURSIVE seq(key) AS (
      VALUES(${first}) UNION ALL SELECT key + 1 FROM seq WHERE key < ${last}
    ) INSERT INTO prolly_rows SELECT key, printf('level-%d-%.*c', key, 2048, 'x') FROM seq`);
  }

  addRandom() {
    const rows = this.rows();
    if (rows.length > 0 && Math.random() < 0.5) {
      const row = rows[Math.floor(Math.random() * rows.length)];
      return this.put(row.key, `random-update-${row.key}-${this.snapshotId}`);
    }
    const maxKey = rows.at(-1)?.key ?? 0;
    const key = maxKey + Math.floor(Math.random() * Math.max(160, maxKey)) + 1;
    return this.put(key, `random-${key}`);
  }

  growUntilSplit(limit = 512, batchSize = 16): GrowthResult {
    const before = this.capture('Before split search');
    const leafCount = leafNodes(before.root).length;
    let next = Number(this.db.selectValue('SELECT COALESCE(MAX(id), 0) + 1 FROM prolly_rows'));
    let candidate = before;
    for (let added = 0; added < limit;) {
      const amount = Math.min(batchSize, limit - added);
      this.insertSequential(next, amount, 'split');
      added += amount;
      next += amount;
      candidate = this.capture(`Split after appending ${added} rows`);
      if (leafNodes(candidate.root).length > leafCount) return { before, after: candidate, added };
    }
    candidate.label = `No split after ${limit} inserts`;
    return { before, after: candidate, added: limit };
  }

  growUntilNextLevel(): GrowthResult {
    const before = this.capture('Before level growth');
    const rootLevel = before.root.level;
    if (rootLevel >= 2) throw new Error('Four-level trees exceed the full-node browser rendering limit');
    const limit = rootLevel === 0 ? 512 : 2_000;
    const batchSize = rootLevel === 0 ? 16 : 500;
    let next = Number(this.db.selectValue('SELECT COALESCE(MAX(id), 0) + 1 FROM prolly_rows'));
    let candidate = before;
    for (let added = 0; added < limit;) {
      const amount = Math.min(batchSize, limit - added);
      this.insertLevelRows(next, amount);
      added += amount;
      next += amount;
      candidate = this.capture(`Reached level ${rootLevel + 1} after appending ${added} rows`);
      if (candidate.root.level > rootLevel) return { before, after: candidate, added };
    }
    candidate.label = `No new level after ${limit} inserts`;
    return { before, after: candidate, added: limit };
  }

  garbageCollect(): GarbageCollectionResult {
    const beforeBytes = exportDatabase(this.sqlite3.wasm, this.db.pointer);
    const beforeImage = parseChunkStore(beforeBytes);
    const beforeCatalogHash = String(this.db.selectValue('SELECT dolt_hashof_catalog()'));
    const rows = this.rows();
    const beforeRoot = findTableRoot(beforeImage.chunks, rows.map((row) => row.key), beforeCatalogHash).root.hash;
    const replacement = this.openDb();
    try {
      this.createSchema(replacement);
      replacement.exec('BEGIN');
      try {
        for (const row of rows) {
          replacement.exec({ sql: 'INSERT INTO prolly_rows(id, value) VALUES (?, ?)', bind: [row.key, row.value] });
        }
        replacement.exec('COMMIT');
      } catch (cause) {
        replacement.exec('ROLLBACK');
        throw cause;
      }
      const head = this.captureDb(replacement, 'Garbage collected');
      if (head.rootHash !== beforeRoot) throw new Error('HEAD root changed during garbage collection');
      const previous = this.db;
      this.db = replacement;
      previous.close();
      return {
        head,
        message: `${Math.max(0, beforeImage.chunks.size - head.chunksInStore)} chunks removed, ${head.chunksInStore} chunks kept`,
        beforeChunks: beforeImage.chunks.size,
        afterChunks: head.chunksInStore,
        beforeBytes: beforeBytes.length,
        afterBytes: head.databaseBytes,
      };
    } catch (cause) {
      replacement.close();
      throw cause;
    }
  }

  reset(count = 240) {
    this.db.close();
    this.db = this.openDb();
    this.snapshotId = 0;
    this.createSchema();
    return this.seed(count);
  }

  compareInsertionOrder(snapshot: TreeSnapshot): InsertionOrderResult {
    const rows = snapshot.rows;
    const build = (ordered: RowValue[], draftKeys = new Set<number>()): InsertionOrderBuild => {
      const db = this.openDb();
      try {
        db.exec('CREATE TABLE prolly_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
        const pending: RowValue[] = [];
        const updates: number[] = [];
        for (let index = 0; index < ordered.length; index += 1) {
          const row = ordered[index];
          const draft = draftKeys.has(row.key);
          db.exec({ sql: 'INSERT INTO prolly_rows VALUES (?, ?)', bind: [row.key, draft ? `draft-${row.key}` : row.value] });
          if (draft) pending.push(row);
          if (index % 5 === 4 && pending.length > 0) {
            const update = pending.shift()!;
            db.exec({ sql: 'UPDATE prolly_rows SET value = ? WHERE id = ?', bind: [update.value, update.key] });
            updates.push(update.key);
          }
        }
        for (const update of pending) {
          db.exec({ sql: 'UPDATE prolly_rows SET value = ? WHERE id = ?', bind: [update.value, update.key] });
          updates.push(update.key);
        }
        const catalogHash = String(db.selectValue('SELECT dolt_hashof_catalog()'));
        const bytes = exportDatabase(this.sqlite3.wasm, db.pointer);
        const image = parseChunkStore(bytes);
        const { root, nodes } = findTableRoot(image.chunks, rows.map((row) => row.key), catalogHash);
        const snapshot: TreeSnapshot = {
          id: -1,
          label: 'History independence build',
          rootHash: root.hash,
          root,
          rows,
          nodes,
          chunksInStore: image.chunks.size,
          databaseBytes: bytes.length,
          timestamp: Date.now(),
        };
        return {
          order: ordered.map((row) => row.key),
          updates,
          rootHash: root.hash,
          nodeHashes: [...nodes.keys()].sort(),
          snapshot,
        };
      } finally {
        db.close();
      }
    };
    const current: InsertionOrderSource = {
      rootHash: snapshot.rootHash,
      nodeHashes: [...snapshot.nodes.keys()].sort(),
      snapshot,
    };
    const shuffledRows = deterministicShuffle(rows);
    const draftKeys = new Set(shuffledRows.filter((_, index) => index % 6 === 0).map((row) => row.key));
    const rebuilt = build(shuffledRows, draftKeys);
    return {
      current,
      rebuilt,
      identicalRoot: current.rootHash === rebuilt.rootHash,
      identicalChunks: current.nodeHashes.length === rebuilt.nodeHashes.length
        && current.nodeHashes.every((hash, index) => hash === rebuilt.nodeHashes[index]),
      rowCount: rows.length,
    };
  }

  close() {
    this.db.close();
  }
}
