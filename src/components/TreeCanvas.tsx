import { useMemo } from 'react';
import { groupRowDiffsByLeaf } from '../prolly';
import type { ProllyNode, RowDiff, TreeSnapshot } from '../types';

interface Point {
  x: number;
  y: number;
  node: ProllyNode;
}

const NODE_WIDTH = 282;
const NODE_HEIGHT = 126;
const X_GAP = 34;
const Y_GAP = 184;

interface KeyLabelPart {
  text: string;
  match: boolean;
  missing?: boolean;
}

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

export function shownKeys(node: ProllyNode, lookupKey?: number): KeyLabelPart[] {
  const keys = node.entries.map((entry) => String(entry.key));
  const matchIndex = lookupKey === undefined ? -1 : node.entries.findIndex((entry) => Number(entry.key) === lookupKey);
  const indexes = keys.length <= 6
    ? keys.map((_, index) => index)
    : matchIndex >= 0
      ? [...new Set([0, matchIndex, keys.length - 1])].sort((left, right) => left - right)
      : [0, 1, 2, keys.length - 2, keys.length - 1];
  return indexes.flatMap((index, position) => {
    const previousIndex = indexes[position - 1];
    const omitted = position > 0 && index - previousIndex > 1
      ? [{ text: '…', match: false }]
      : [];
    return [...omitted, { text: keys[index], match: index === matchIndex }];
  });
}

export function missingKeyLabel(node: ProllyNode, lookupKey: number): KeyLabelPart[] {
  const keys = node.entries.map((entry) => Number(entry.key));
  const insertionIndex = keys.findIndex((key) => key > lookupKey);
  if (insertionIndex > 0) {
    return [
      { text: String(keys[insertionIndex - 1]), match: false },
      { text: `key ${lookupKey} not found`, match: false, missing: true },
      { text: String(keys[insertionIndex]), match: false },
    ];
  }
  if (insertionIndex === 0) {
    return [
      { text: `key ${lookupKey} not found`, match: false, missing: true },
      ...keys.slice(0, 2).map((key) => ({ text: String(key), match: false })),
    ];
  }
  return [
    ...keys.slice(-2).map((key) => ({ text: String(key), match: false })),
    { text: `key ${lookupKey} not found`, match: false, missing: true },
  ];
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
  lookup?: { key: number; found: boolean };
  compact?: boolean;
  selectedHash?: string;
  onSelect(hash: string): void;
}

export function TreeCanvas({ snapshot, baseline, trace, diffHighlight, rowDiffs, lookup, compact = false, selectedHash, onSelect }: TreeCanvasProps) {
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
          const keyParts = lookup && !lookup.found && node.level === 0 && isTrace
            ? missingKeyLabel(node, lookup.key)
            : shownKeys(node, node.level === 0 && lookup?.found ? lookup.key : undefined);
          const className = [
            'tree-node',
            node.level === 0 ? 'leaf-node' : 'internal-node',
            isNew ? 'node-new' : '',
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
              onMouseDown={(event) => event.preventDefault()}
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
                {nodeRowDiffs.length ? shownChanges(nodeRowDiffs) : keyParts.map((part, index) => (
                  <tspan key={`${part.text}-${index}`} className={part.match ? 'node-key-match' : part.missing ? 'node-key-missing' : undefined}>{index > 0 ? '  ·  ' : ''}{part.text}</tspan>
                ))}
              </text>
              <text className="node-range" x="15" y="84">
                {node.size.toLocaleString()} bytes
              </text>
              <text className="node-hash" x="15" y="108">{node.hash}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
