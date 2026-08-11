import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@dolthub/doltlite-wasm', async () => {
  // The package's Node entry point is JavaScript-only, but exposes the same API.
  // @ts-expect-error No declaration is published for the Node-specific entry point.
  const { default: initNodeModule } = await import('@dolthub/doltlite-wasm/sqlite3-node.mjs');
  return { default: () => initNodeModule() };
});

vi.mock('@dolthub/doltlite-wasm/sqlite3.wasm?url', () => ({ default: '' }));

import { ProllyEngine } from './engine';
import { leafNodes } from './prolly';

const engines: ProllyEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.close();
});

describe('ProllyEngine growth searches', () => {
  it('finds the next split in scratch storage and mutates the displayed database once', async () => {
    const engine = await ProllyEngine.create();
    engines.push(engine);
    engine.seed();

    const result = engine.growUntilSplit();
    const historicalChunks = result.after.chunksInStore
      - result.after.nodes.size
      - result.after.engineMetadataChunks;
    const historicalTableChunks = new Set([
      ...result.before.nodes.keys(),
      ...result.after.nodes.keys(),
    ]).size - result.after.nodes.size;

    expect(result.added).toBeGreaterThan(0);
    expect(leafNodes(result.after.root).length).toBeGreaterThan(leafNodes(result.before.root).length);
    expect(historicalChunks).toBe(historicalTableChunks + 3);
  });

  it('finds the next level in scratch storage and mutates the displayed database once', async () => {
    const engine = await ProllyEngine.create();
    engines.push(engine);
    engine.seed();

    const result = engine.growUntilNextLevel();
    const historicalChunks = result.after.chunksInStore
      - result.after.nodes.size
      - result.after.engineMetadataChunks;
    const historicalTableChunks = new Set([
      ...result.before.nodes.keys(),
      ...result.after.nodes.keys(),
    ]).size - result.after.nodes.size;

    expect(result.after.root.level).toBeGreaterThan(result.before.root.level);
    expect(historicalChunks).toBe(historicalTableChunks + 3);
  });
});
