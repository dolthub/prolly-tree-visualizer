import { describe, expect, it } from 'vitest';
import { calculatePhysicalChunkMakeup, calculateVersionStorage, countHistoricalTreeChunks } from './storage';

describe('calculateVersionStorage', () => {
  it('counts shared addresses once across versions', () => {
    const metrics = calculateVersionStorage([
      { nodes: new Map([['root-a', null], ['leaf-a', null], ['leaf-shared', null]]) },
      { nodes: new Map([['root-b', null], ['leaf-b', null], ['leaf-shared', null]]) },
      { nodes: new Map([['root-c', null], ['leaf-b', null], ['leaf-shared', null]]) },
    ]);

    expect(metrics).toEqual({
      versions: 3,
      withoutSharing: 9,
      withSharing: 6,
      savedChunks: 3,
      savedFraction: 1 / 3,
    });
  });

  it('handles an empty history', () => {
    expect(calculateVersionStorage([])).toEqual({
      versions: 0,
      withoutSharing: 0,
      withSharing: 0,
      savedChunks: 0,
      savedFraction: 0,
    });
  });

  it('counts every older root, internal, and leaf address not shared with HEAD', () => {
    const versions = [
      { nodes: new Map([['root-a', null], ['internal-a', null], ['leaf-shared', null]]) },
      { nodes: new Map([['root-b', null], ['internal-a', null], ['leaf-old', null], ['leaf-shared', null]]) },
      { nodes: new Map([['root-c', null], ['internal-c', null], ['leaf-shared', null]]) },
    ];

    expect(countHistoricalTreeChunks(versions)).toBe(4);
  });
});

describe('calculatePhysicalChunkMakeup', () => {
  it('classifies hidden intermediate table states as historical tree chunks', () => {
    expect(calculatePhysicalChunkMakeup({
      nodes: new Map([['head-root', null], ['head-leaf', null]]),
      engineMetadataChunks: 4,
      chunksInStore: 23,
    })).toEqual({
      liveTableChunks: 2,
      historicalChunks: 17,
      metadataChunks: 4,
    });
  });

  it('bounds inconsistent physical counts without producing negative categories', () => {
    expect(calculatePhysicalChunkMakeup({
      nodes: new Map([['head-root', null], ['head-leaf', null]]),
      engineMetadataChunks: 99,
      chunksInStore: 1,
    })).toEqual({
      liveTableChunks: 1,
      historicalChunks: 0,
      metadataChunks: 0,
    });
  });
});
