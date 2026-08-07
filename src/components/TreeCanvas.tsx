import { useMemo } from 'react';
import { groupRowDiffsByLeaf } from '../prolly';
import type { ProllyNode, RowDiff, TreeSnapshot } from '../types';

interface Point {
  x: number;
  y: number;
  node: ProllyNode;
}

const NODE_WIDTH = 238;
const NODE_HEIGHT = 126;
const X_GAP = 34;
const Y_GAP = 184;

function layout(root: ProllyNode, minimumWidth: number) {
  const positions = new Map<string, Point>();
  let leafIndex = 0;

  const place = (node: ProllyNode): number => {
    let center: number;
    if (node.children.length === 0) {
      center = leafIndex * (NODE_WIDTH + X_GAP) + NODE_WIDTH / 2 + 38;
      leafIndex += 1;
    } else {
      const childCenters = node.children.map(place);
      center = (childCenters[0] + childCenters.at(-1)!) / 2;
    }
    positions.set(node.hash, {
      x: center - NODE_WIDTH / 2,
      y: (root.level - node.level) * Y_GAP + 38,
      node,
    });
    return center;
  };

  const rootCenter = place(root);
  const contentWidth = Math.max(leafIndex * (NODE_WIDTH + X_GAP) + 42, NODE_WIDTH + 76);
  if (leafIndex === 1) {
    const offset = Math.max(0, minimumWidth / 2 - rootCenter);
    for (const point of positions.values()) point.x += offset;
  }
  return {
    positions,
    width: Math.max(minimumWidth, contentWidth),
    height: (root.level + 1) * Y_GAP + 30,
  };
}

function shownKeys(node: ProllyNode) {
  const keys = node.entries.map((entry) => String(entry.key));
  if (keys.length <= 6) return keys.join('  ·  ');
  return `${keys.slice(0, 3).join('  ·  ')}  …  ${keys.slice(-2).join('  ·  ')}`;
}

function shownChanges(changes: RowDiff[]) {
  if (changes.length === 1) {
    const change = changes[0];
    return `key ${change.key} ${change.kind === 'modified' ? 'updated' : change.kind}`;
  }
  const keys = changes.slice(0, 3).map((change) => change.key).join(', ');
  return `${changes.length} changed rows · ${keys}${changes.length > 3 ? ', …' : ''}`;
}

interface TreeCanvasProps {
  snapshot: TreeSnapshot;
  baseline?: TreeSnapshot;
  trace: Set<string>;
  diffHighlight: Set<string>;
  rowDiffs: RowDiff[];
  compact?: boolean;
  selectedHash?: string;
  onSelect(hash: string): void;
}

export function TreeCanvas({ snapshot, baseline, trace, diffHighlight, rowDiffs, compact = false, selectedHash, onSelect }: TreeCanvasProps) {
  const treeLayout = useMemo(() => layout(snapshot.root, compact ? 586 : 900), [compact, snapshot]);
  const rowDiffsByLeaf = useMemo(() => groupRowDiffsByLeaf(snapshot.root, rowDiffs), [snapshot, rowDiffs]);
  const baselineHashes = baseline?.nodes;

  return (
    <div className="tree-scroll" aria-label="Prolly tree visualization">
      <svg className="tree-svg" width={treeLayout.width} height={treeLayout.height} role="img">
        <title>Prolly tree rooted at {snapshot.rootHash}</title>
        <g className="tree-edges">
          {[...treeLayout.positions.values()].flatMap((point) =>
            point.node.children.map((child) => {
              const childPoint = treeLayout.positions.get(child.hash)!;
              const changed = baselineHashes ? !baselineHashes.has(child.hash) : false;
              const highlighted = diffHighlight.has(child.hash);
              return (
                <path
                  key={`${point.node.hash}-${child.hash}`}
                  className={highlighted ? 'edge edge-diff' : changed ? 'edge edge-new' : 'edge'}
                  d={`M ${point.x + NODE_WIDTH / 2} ${point.y + NODE_HEIGHT} C ${point.x + NODE_WIDTH / 2} ${point.y + NODE_HEIGHT + 42}, ${childPoint.x + NODE_WIDTH / 2} ${childPoint.y - 42}, ${childPoint.x + NODE_WIDTH / 2} ${childPoint.y}`}
                />
              );
            }),
          )}
        </g>
        {[...treeLayout.positions.values()].map(({ node, x, y }) => {
          const nodeRowDiffs = rowDiffsByLeaf.get(node.hash) ?? [];
          const isTrace = trace.has(node.hash);
          const isDiff = diffHighlight.has(node.hash);
          const isNew = Boolean(baselineHashes && !baselineHashes.has(node.hash));
          const isShared = Boolean(baselineHashes?.has(node.hash));
          const className = [
            'tree-node',
            node.level === 0 ? 'leaf-node' : 'internal-node',
            isNew ? 'node-new' : '',
            isShared ? 'node-shared' : '',
            isTrace ? 'node-trace' : '',
            isDiff ? 'node-diff' : '',
            selectedHash === node.hash ? 'node-selected' : '',
          ].filter(Boolean).join(' ');
          return (
            <g
              key={node.hash}
              className={className}
              transform={`translate(${x} ${y})`}
              tabIndex={0}
              role="button"
              aria-label={`${node.level === 0 ? 'Leaf' : `Level ${node.level}`} node ${node.hash}`}
              onClick={() => onSelect(node.hash)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelect(node.hash);
              }}
            >
              <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="14" />
              <text className="node-kind" x="15" y="24">
                {node.level === 0 ? 'LEAF CHUNK' : `INTERNAL · LEVEL ${node.level}`}
              </text>
              <text className="node-count" x={NODE_WIDTH - 15} y="24" textAnchor="end">
                {node.entries.length} {node.entries.length === 1 ? 'entry' : 'entries'}
              </text>
              <line x1="14" x2={NODE_WIDTH - 14} y1="36" y2="36" />
              <text className={nodeRowDiffs.length ? 'node-keys node-row-change' : 'node-keys'} x="15" y="61">
                {nodeRowDiffs.length ? shownChanges(nodeRowDiffs) : shownKeys(node)}
              </text>
              <text className="node-range" x="15" y="84">
                {node.size.toLocaleString()} bytes
              </text>
              <text className="node-hash" x="15" y="108">{node.hash.slice(0, 16)}…</text>
              <circle className="hash-dot" cx={NODE_WIDTH - 20} cy="103" r="6" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
