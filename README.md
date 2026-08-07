# Prolly Tree Lab

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
- inserts, updates, deletes, random writes, and sequential growth
- history independence, demonstrated with two real builds in opposite orders
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

1. **Put row** inserts a new integer key or updates an existing value.
2. **Find path** highlights the actual internal and leaf chunks visited for a
   key lookup.
3. **+ Random** and **+ 25 rows** make middle and right-edge growth easy to
   compare.
4. **Force next split** keeps inserting until DoltLite produces another leaf
   chunk, then selects the before-split version as the comparison baseline.
5. **Fast diff** shows which subtrees can be skipped because their addresses
   match.
6. **Chunk boundaries** lays out every live leaf range and its encoded size.
7. **Opus concepts** includes guided experiments for copy-on-write, diff,
   structural sharing, and history independence.
8. Choose any earlier item in the **Version timeline** to change the comparison
   baseline. New and shared content addresses update immediately.

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

DoltLite's `dolt_hashof_table()` includes both the data root and canonical
schema hash. The visualizer therefore identifies the physical data root among
the exported prolly chunks by matching its in-order integer keys to the rows in
the controlled demo table.

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
