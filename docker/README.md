# Prolly Tree Visualizer Docker Image

The official Docker image for the [Prolly Tree
Visualizer](https://github.com/dolthub/prolly-tree-visualizer) — an interactive
browser visualizer for the real prolly trees produced by
[DoltLite](https://github.com/dolthub/doltlite).

Every tree mutation in the app is SQL executed by `@dolthub/doltlite-wasm` in the
browser, not a JavaScript simulation of a data structure.

## Quick Start

```bash
docker run --rm -p 8080:80 dolthub/prolly-tree-visualizer:latest
```

Open <http://localhost:8080>.

The image is a static build of the site served by nginx. Everything runs in the
browser: no DoltLite server is contacted and no database rows leave the machine.
The first page load fetches the approximately 3.3 MB DoltLite WASM module from
the container.

## What the image serves

- `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, matching the app's development
  configuration, so DoltLite's persistent OPFS storage keeps working.
- The WASM module with `Content-Type: application/wasm`.
- Long-lived immutable caching for content-hashed assets, and `no-cache` for
  `index.html`.

## Behind a proxy

If you terminate TLS or route through another proxy, preserve the two
cross-origin headers above. Dropping them disables cross-origin isolation in the
browser.

## Tags

- `latest` — the most recent release. Only published after the image builds and
  pushes successfully.
- `<version>` — a specific release, e.g. `0.2.0`.

Images are built for `linux/amd64` and `linux/arm64`.

## Source and issues

<https://github.com/dolthub/prolly-tree-visualizer>
