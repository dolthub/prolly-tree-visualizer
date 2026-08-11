interface VersionNodes {
  nodes: Map<string, unknown>;
}

export interface VersionStorageMetrics {
  versions: number;
  withoutSharing: number;
  withSharing: number;
  savedChunks: number;
  savedFraction: number;
}

interface PhysicalSnapshot extends VersionNodes {
  engineMetadataChunks: number;
  chunksInStore: number;
}

export interface PhysicalChunkMakeup {
  liveTableChunks: number;
  historicalChunks: number;
  metadataChunks: number;
}

export function calculateVersionStorage(versions: VersionNodes[]): VersionStorageMetrics {
  const withoutSharing = versions.reduce((total, version) => total + version.nodes.size, 0);
  const addresses = new Set(versions.flatMap((version) => [...version.nodes.keys()]));
  const savedChunks = withoutSharing - addresses.size;
  return {
    versions: versions.length,
    withoutSharing,
    withSharing: addresses.size,
    savedChunks,
    savedFraction: withoutSharing === 0 ? 0 : savedChunks / withoutSharing,
  };
}

export function countHistoricalTreeChunks(versions: VersionNodes[]) {
  const head = versions.at(-1);
  if (!head) return 0;
  const historical = new Set(versions.slice(0, -1).flatMap((version) => [...version.nodes.keys()]));
  for (const hash of head.nodes.keys()) historical.delete(hash);
  return historical.size;
}

export function calculatePhysicalChunkMakeup(snapshot: PhysicalSnapshot): PhysicalChunkMakeup {
  const liveTableChunks = Math.min(snapshot.nodes.size, snapshot.chunksInStore);
  const metadataChunks = Math.min(
    Math.max(0, snapshot.engineMetadataChunks),
    snapshot.chunksInStore - liveTableChunks,
  );
  return {
    liveTableChunks,
    historicalChunks: snapshot.chunksInStore - liveTableChunks - metadataChunks,
    metadataChunks,
  };
}
