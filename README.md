# Prolly Tree

An interactive browser visualizer for the real prolly trees produced by
[DoltLite](https://github.com/dolthub/doltlite). The interaction model is
inspired by [btree.app](https://btree.app/), but every tree mutation is SQL
executed by `@dolthub/doltlite-wasm` rather than a JavaScript data-structure
simulation.

The app exposes the ideas from the
[Prolly Tree opus](https://www.dolthub.com/docs/architecture/storage-engine/prolly-tree/):

- content-defined leaf boundaries and node splits
- content addresses for every leaf and internal node
- copy-on-write updates and structural sharing between versions
- key lookup paths through delimiter keys
- hash-pruned fast diffs
- history-independent builds from different insertion orders
- inserts, updates, deletes, random writes, and sequential growth
- chunk sizes, ranges, row counts, and full 20-byte addresses

## Run it in a browser

Prerequisites: Node.js 18 or newer and npm.

```bash
git clone https://github.com/timsehn/prolly-tree-visualizer.git
cd prolly-tree-visualizer
npm install
npm run dev
```

Open the URL Vite prints, normally <http://localhost:5173>.

The first load downloads and starts the approximately 3.3 MB DoltLite WASM
module. Everything after that runs locally in the browser; the app does not
need a DoltLite server or send database rows anywhere.

To test the production build locally:

```bash
npm run build
npm run preview
```

Open <http://localhost:4173> unless Vite prints a different port.

The Vite configuration sends `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers in both development and preview mode.
Keep equivalent headers in a production deployment if the app is extended to
use DoltLite's persistent OPFS database support:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The current visualizer intentionally starts with a fresh browser-session
database on each page load so experiments are repeatable.

## Using the lab

1. **Insert or update** writes an integer key and value; **Delete** removes a
   key in its own compact control.
2. **Key lookup** highlights one root-to-leaf path, **Range lookup** highlights
   every overlapping branch, and **Diff lookup** highlights the node paths
   changed since the immediately previous version.
3. **Random** chooses between inserting a sparse key and updating an existing
   row; **+ 25 rows** grows the right edge sequentially.
4. **Force next split** keeps inserting until DoltLite produces another leaf
   chunk.
5. **Force next tree level** grows a real three-level tree using wide rows.
6. **Fast diff** shows which subtrees can be skipped because their addresses
   match.
7. **Chunk boundaries** lays out every live leaf range, encoded size, and
   interior-insert split probability.
8. Choose any earlier item in the **Version timeline** to render that historical
   tree. New and shared content addresses update immediately.
9. **History independence** renders two real three-node trees. One is built
   with sorted inserts; the other uses shuffled inserts and 30 value updates.
   Their root and live chunk addresses are compared directly.

Click any node to inspect its full address, encoded size, keys, SQL values, or
child hashes.

## How it stays tied to the real engine

The data path for each operation is:

```text
browser control
  → SQL against @dolthub/doltlite-wasm
  → DoltLite C prolly-tree mutation
  → direct VFS stream of the database image
  → DoltLite v12 chunk-store records
  → actual prolly-node bytes and child hashes
  → SVG visualization
```

`src/exportDatabase.ts` streams the open database through DoltLite WASM's
chunked VFS export without creating a second snapshot database.
`src/chunkStore.ts` reads the 168-byte manifest, compacted chunk index, and WAL
chunk records from the exported database image. `src/prolly.ts` decodes the
same node header, offset arrays, integer key encoding, child hashes, and subtree
counts used by DoltLite's C implementation. SQL is used to display leaf values;
node boundaries, levels, sizes, and addresses all come from the stored bytes.

DoltLite's `dolt_hashof_catalog()` supplies the current working catalog
address. The visualizer reads that catalog chunk from the export and follows
the `prolly_rows` entry directly to its physical data root, including after
value-only updates whose old and new roots contain the same keys.

## Validation

```bash
npm test          # chunk-store and prolly-node decoder tests
npm run build     # TypeScript and production bundle
npm run smoke:wasm
```

The WASM smoke test asserts that the package reports the `prolly` engine,
writes rows through SQL, returns a content hash, and exports a DoltLite
database image.

## Project layout

```text
src/engine.ts                    DoltLite WASM and SQL adapter
src/exportDatabase.ts            direct WASM VFS database export
src/chunkStore.ts                DoltLite v12 database-image decoder
src/prolly.ts                    prolly-node graph, search, and diff helpers
src/components/TreeCanvas.tsx    SVG tree layout and version highlighting
src/components/NodeInspector.tsx selected chunk details
src/App.tsx                      controls, views, timeline, guided demos
```
