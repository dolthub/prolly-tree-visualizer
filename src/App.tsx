import { useEffect, useMemo, useRef, useState } from 'react';
import { ProllyEngine, type GrowthResult, type InsertionOrderResult } from './engine';
import { countSharedNodes, diffRows, estimateMutationSplitProbability, leafNodes, traceRange, traceSearch } from './prolly';
import type { LookupResult, ProllyNode, TreeSnapshot } from './types';
import { InfoTip } from './components/InfoTip';
import { NodeInspector } from './components/NodeInspector';
import { TreeCanvas } from './components/TreeCanvas';

type Tab = 'tree' | 'diff' | 'chunks' | 'order';
type ControlMode = 'modify' | 'lookup';
const NO_HIGHLIGHTS = new Set<string>();
const NO_ROW_DIFFS: [] = [];

function formatProbability(probability: number) {
  const percent = probability * 100;
  if (percent === 0) return '0%';
  if (percent < 0.1) return '<0.1%';
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

function formatOrder(order: number[]) {
  const shown = order.slice(0, 14).map((key) => key.toLocaleString()).join(' → ');
  return order.length > 14 ? `${shown} → …` : shown;
}

function nextEditValue(key: number, currentValue: string) {
  const prefix = `value-${key}-edit-`;
  const revision = currentValue.startsWith(prefix)
    ? Number.parseInt(currentValue.slice(prefix.length), 10) + 1
    : 1;
  return `${prefix}${Number.isSafeInteger(revision) ? revision : 1}`;
}

function App() {
  const engineRef = useRef<ProllyEngine | undefined>(undefined);
  const operationPendingRef = useRef(false);
  const animationTimersRef = useRef<number[]>([]);
  const [snapshots, setSnapshots] = useState<TreeSnapshot[]>([]);
  const [viewId, setViewId] = useState<number>();
  const [compareFromId, setCompareFromId] = useState<number>();
  const [selectedHash, setSelectedHash] = useState<string>();
  const [tab, setTab] = useState<Tab>('tree');
  const [controlMode, setControlMode] = useState<ControlMode>('modify');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [keyInput, setKeyInput] = useState('49');
  const [valueInput, setValueInput] = useState('value-49');
  const [deleteInput, setDeleteInput] = useState('1');
  const [searchInput, setSearchInput] = useState('24');
  const [rangeStart, setRangeStart] = useState('1');
  const [rangeEnd, setRangeEnd] = useState('48');
  const [trace, setTrace] = useState<Set<string>>(new Set());
  const [activeTraceHash, setActiveTraceHash] = useState<string>();
  const [lookupResult, setLookupResult] = useState<LookupResult>();
  const [diffHighlight, setDiffHighlight] = useState<Set<string>>(new Set());
  const [activeDiffHashes, setActiveDiffHashes] = useState<Set<string>>(new Set());
  const [lastChangeActive, setLastChangeActive] = useState(false);
  const [insertionOrderResult, setInsertionOrderResult] = useState<InsertionOrderResult>();
  const [orderSelectedHash, setOrderSelectedHash] = useState<string>();

  const latest = snapshots.at(-1);
  const viewedIndex = viewId === undefined
    ? snapshots.length - 1
    : snapshots.findIndex((snapshot) => snapshot.id === viewId);
  const current = snapshots[viewedIndex] ?? latest;
  const requestedBaselineIndex = snapshots.findIndex((snapshot) => snapshot.id === compareFromId);
  const baselineIndex = requestedBaselineIndex >= 0 && requestedBaselineIndex < viewedIndex
    ? requestedBaselineIndex
    : viewedIndex > 0 ? 0 : -1;
  const diffBaseline = baselineIndex >= 0 ? snapshots[baselineIndex] : undefined;
  const previous = viewedIndex > 0 ? snapshots[viewedIndex - 1] : undefined;
  const viewingHistorical = Boolean(current && latest && current.id !== latest.id);

  const cancelAnimation = (resetActive = true) => {
    animationTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    animationTimersRef.current = [];
    if (resetActive) {
      setActiveTraceHash(undefined);
      setActiveDiffHashes(new Set());
    }
  };

  const animateTrace = (path: string[]) => {
    cancelAnimation();
    if (path.length === 0) {
      setTrace(new Set());
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setTrace(new Set(path));
      return;
    }
    setTrace(new Set([path[0]]));
    setActiveTraceHash(path[0]);
    animationTimersRef.current = path.slice(1).map((hash, index) => window.setTimeout(() => {
      setTrace((visible) => new Set([...visible, hash]));
      setActiveTraceHash(hash);
    }, (index + 1) * 1000));
    animationTimersRef.current.push(window.setTimeout(() => setActiveTraceHash(undefined), path.length * 1000));
  };

  const animateDiff = (hashes: Set<string>) => {
    cancelAnimation();
    if (!current || hashes.size === 0) {
      setDiffHighlight(new Set());
      return;
    }
    const levels = [...new Set([...hashes].map((hash) => current.nodes.get(hash)?.level).filter((level): level is number => level !== undefined))]
      .sort((left, right) => right - left);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDiffHighlight(hashes);
      return;
    }
    const hashesAtLevel = (level: number) => [...hashes].filter((hash) => current.nodes.get(hash)?.level === level);
    const firstLevel = new Set(hashesAtLevel(levels[0]));
    setDiffHighlight(firstLevel);
    setActiveDiffHashes(firstLevel);
    animationTimersRef.current = levels.slice(1).map((level, index) => window.setTimeout(() => {
      const nextLevel = new Set(hashesAtLevel(level));
      setDiffHighlight((visible) => new Set([...visible, ...nextLevel]));
      setActiveDiffHashes(nextLevel);
    }, (index + 1) * 1000));
    animationTimersRef.current.push(window.setTimeout(() => setActiveDiffHashes(new Set()), levels.length * 1000));
  };

  const selectExistingInputs = (snapshot: TreeSnapshot) => {
    const first = snapshot.rows[0];
    const middle = snapshot.rows[Math.floor(snapshot.rows.length / 2)];
    const quarter = snapshot.rows[Math.floor(snapshot.rows.length / 4)];
    if (!first || !middle || !quarter) {
      setKeyInput('');
      setValueInput('');
      setDeleteInput('');
      setSearchInput('');
      setRangeStart('');
      setRangeEnd('');
      return;
    }
    setKeyInput(String(middle.key));
    setValueInput(nextEditValue(middle.key, middle.value));
    setDeleteInput(String(first.key));
    setSearchInput(String(middle.key));
    setRangeStart(String(first.key));
    setRangeEnd(String(quarter.key));
  };

  useEffect(() => {
    let cancelled = false;
    void ProllyEngine.create().then((engine) => {
      if (cancelled) {
        engine.close();
        return;
      }
      engineRef.current = engine;
      const first = engine.seed();
      setSnapshots([first]);
      setCompareFromId(first.id);
      selectExistingInputs(first);
      setError(undefined);
      setBusy(false);
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    });
    return () => {
      cancelled = true;
      cancelAnimation(false);
      engineRef.current?.close();
    };
  }, []);

  const appendSnapshot = (snapshot: TreeSnapshot) => {
    cancelAnimation();
    setSnapshots((existing) => [...existing, snapshot]);
    setViewId(undefined);
    setTrace(new Set());
    setLookupResult(undefined);
    setDiffHighlight(new Set());
    setLastChangeActive(false);
    setSelectedHash(undefined);
    setInsertionOrderResult(undefined);
    setOrderSelectedHash(undefined);
    selectExistingInputs(snapshot);
  };

  const run = (operation: (engine: ProllyEngine) => TreeSnapshot, onComplete?: (snapshot: TreeSnapshot) => void) => {
    const engine = engineRef.current;
    if (!engine || operationPendingRef.current) return;
    operationPendingRef.current = true;
    setBusy(true);
    setError(undefined);
    window.setTimeout(() => {
      try {
        const snapshot = operation(engine);
        appendSnapshot(snapshot);
        onComplete?.(snapshot);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        operationPendingRef.current = false;
        setBusy(false);
      }
    }, 20);
  };

  const runGrowth = (operation: (engine: ProllyEngine) => GrowthResult) => {
    const engine = engineRef.current;
    if (!engine || operationPendingRef.current) return;
    operationPendingRef.current = true;
    setBusy(true);
    setError(undefined);
    window.setTimeout(() => {
      try {
        const result = operation(engine);
        appendSnapshot(result.after);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        operationPendingRef.current = false;
        setBusy(false);
      }
    }, 20);
  };

  const metrics = useMemo(() => {
    if (!current) return undefined;
    const leaves = leafNodes(current.root);
    const compare = (before?: TreeSnapshot) => {
      const shared = before ? countSharedNodes(before.nodes, current.nodes) : 0;
      const beforeLeaves = before ? leafNodes(before.root).length : leaves.length;
      return {
        shared,
        fresh: before ? current.nodes.size - shared : 0,
        replaced: before ? before.nodes.size - shared : 0,
        splitDelta: leaves.length - beforeLeaves,
        rowDiffs: before ? diffRows(before.rows, current.rows) : [],
      };
    };
    return {
      leaves,
      tree: compare(previous),
      diff: compare(diffBaseline),
    };
  }, [current, diffBaseline, previous]);

  const selectedNode: ProllyNode | undefined = selectedHash ? current?.nodes.get(selectedHash) : undefined;

  if (busy && !current) {
    return (
      <main className="loading-screen">
        <div className="loader-mark"><span /><span /><span /></div>
        <p>Booting DoltLite’s prolly engine in WebAssembly…</p>
      </main>
    );
  }

  if (!current || !metrics) {
    return <main className="loading-screen error-screen"><h1>Could not start the lab</h1><p>{error}</p></main>;
  }

  const highlightedRowDiffs = lastChangeActive && previous
    ? diffRows(previous.rows, current.rows)
    : [];
  const diffBeforeRoot = diffBaseline?.rootHash ?? current.rootHash;

  const doSearch = () => {
    const key = Number(searchInput);
    if (!Number.isSafeInteger(key)) return;
    animateTrace(traceSearch(current.root, key));
    setLookupResult({ kind: 'key', key, found: current.rows.some((row) => row.key === key) });
    setDiffHighlight(new Set());
    setLastChangeActive(false);
    setTab('tree');
  };

  const doRangeSearch = () => {
    const start = Number(rangeStart);
    const end = Number(rangeEnd);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return;
    animateTrace(traceRange(current.root, start, end));
    setLookupResult({ kind: 'range', start, end });
    setDiffHighlight(new Set());
    setLastChangeActive(false);
    setTab('tree');
  };

  const doDiffLookup = () => {
    cancelAnimation();
    if (lastChangeActive) {
      setDiffHighlight(new Set());
      setLastChangeActive(false);
      setSelectedHash(undefined);
      return;
    }
    if (viewedIndex <= 0) return;
    const previous = snapshots[viewedIndex - 1];
    setTrace(new Set());
    setLookupResult(undefined);
    animateDiff(new Set([...current.nodes.keys()].filter((hash) => !previous.nodes.has(hash))));
    setLastChangeActive(true);
    setSelectedHash(undefined);
    setTab('tree');
  };

  const runInsertionOrderDemo = () => {
    const engine = engineRef.current;
    if (!engine || operationPendingRef.current) return;
    operationPendingRef.current = true;
    setBusy(true);
    setError(undefined);
    window.setTimeout(() => {
      try {
        setInsertionOrderResult(engine.compareInsertionOrders());
        setOrderSelectedHash(undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        operationPendingRef.current = false;
        setBusy(false);
      }
    }, 20);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
            <path className="brand-tree-link" d="M20 13v5M10 23v-2c0-2 1-3 3-3h14c2 0 3 1 3 3v2" />
            <rect className="brand-root-node" x="14" y="5" width="12" height="9" rx="2.5" />
            <rect className="brand-leaf-node" x="4" y="23" width="13" height="11" rx="2.5" />
            <rect className="brand-leaf-node" x="23" y="23" width="13" height="11" rx="2.5" />
            <path className="brand-hash-line" d="M8 27h5M8 30h3M27 27h5M27 30h3M18 9h4" />
          </svg>
          <div><strong>Prolly Tree</strong></div>
        </div>
        <a className="runtime-pill" href="https://github.com/dolthub/doltlite" target="_blank" rel="noreferrer">
          <span>Powered by</span>
          <img src="https://raw.githubusercontent.com/dolthub/doltlite/master/doltlite-logo.png" alt="DoltLite" />
          <b>{engineRef.current?.version}</b>
        </a>
      </header>

      <section className="database-summary">
        <div className="root-card">
          <span>Tree root <InfoTip dark>The content address of the root chunk. A rewritten tree gets a new root address; a no-op keeps it.</InfoTip></span>
          <code>{current.rootHash}</code>
          <div><b>{current.rows.length}</b> rows <i /> <b>{current.nodes.size}</b> live nodes <i /> <b>{current.root.level + 1}</b> levels</div>
        </div>
      </section>

      <section className="control-deck">
        <div className="control-tabs" role="tablist" aria-label="Tree controls">
          <button className={controlMode === 'modify' ? 'control-tab active' : 'control-tab'} role="tab" aria-selected={controlMode === 'modify'} aria-controls="modify-controls" onClick={() => setControlMode('modify')}>Modify</button>
          <button className={controlMode === 'lookup' ? 'control-tab active' : 'control-tab'} role="tab" aria-selected={controlMode === 'lookup'} aria-controls="lookup-controls" onClick={() => setControlMode('lookup')}>Lookup</button>
        </div>
        {controlMode === 'modify' && <div className="control-row modify-row" id="modify-controls" role="tabpanel">
          <div className="control-section put-section">
            <label>Insert or update</label>
            <div className="control-fields">
              <input aria-label="Insert key" type="number" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} />
              <input className="value-input" aria-label="Value" value={valueInput} onChange={(event) => setValueInput(event.target.value)} />
              <button className="primary-button" disabled={busy || viewingHistorical} onClick={() => {
                const key = Number(keyInput);
                if (Number.isSafeInteger(key)) run(
                  (engine) => engine.put(key, valueInput || `value-${key}`),
                  (snapshot) => {
                    const row = snapshot.rows.find((candidate) => candidate.key === key);
                    if (!row) return;
                    setKeyInput(String(key));
                    setValueInput(nextEditValue(key, row.value));
                  },
                );
              }}>Put row</button>
              <button title="Randomly insert a new key or update an existing row" disabled={busy || viewingHistorical} onClick={() => run((engine) => engine.addRandom())}>Random</button>
            </div>
          </div>
          <div className="control-section delete-section">
            <label>Delete</label>
            <div className="control-fields">
              <input aria-label="Delete key" type="number" value={deleteInput} onChange={(event) => setDeleteInput(event.target.value)} />
              <button className="danger-quiet" disabled={busy || viewingHistorical} onClick={() => {
                const key = Number(deleteInput);
                if (Number.isSafeInteger(key)) run((engine) => engine.remove(key));
              }}>Delete</button>
            </div>
          </div>
          <div className="control-section bulk-section">
            <label>Bulk actions</label>
            <div className="control-fields bulk-actions">
              <button disabled={busy || viewingHistorical} onClick={() => run((engine) => engine.addSequential(25))}>+ 25 rows</button>
              <button disabled={busy || viewingHistorical} onClick={() => { runGrowth((engine) => engine.growUntilSplit()); setTab('tree'); }}>Next split</button>
              <button title={current.root.level >= 2 ? 'Three levels is the browser demo limit' : undefined} disabled={busy || viewingHistorical || current.root.level >= 2} onClick={() => { runGrowth((engine) => engine.growUntilNextLevel()); setTab('tree'); }}>{current.root.level >= 2 ? 'Three levels reached' : 'Next tree level'}</button>
              <button className="reset-button" disabled={busy || viewingHistorical} onClick={() => {
                const engine = engineRef.current;
                if (!engine) return;
                setBusy(true);
                window.setTimeout(() => {
                  try {
                    const snapshot = engine.reset();
                    setSnapshots([snapshot]);
                    setViewId(undefined);
                    setCompareFromId(snapshot.id);
                    setTrace(new Set());
                    cancelAnimation();
                    setLookupResult(undefined);
                    setDiffHighlight(new Set());
                    setLastChangeActive(false);
                    setInsertionOrderResult(undefined);
                    setOrderSelectedHash(undefined);
                    selectExistingInputs(snapshot);
                  } finally {
                    setBusy(false);
                  }
                }, 20);
              }}>Reset</button>
            </div>
          </div>
        </div>}
        {controlMode === 'lookup' && <div className="control-row lookup-row" id="lookup-controls" role="tabpanel">
          <div className="control-section key-lookup-section">
            <label>Key lookup</label>
            <div className="control-fields">
              <input aria-label="Search key" type="number" value={searchInput} onChange={(event) => { cancelAnimation(); setTrace(new Set()); setSearchInput(event.target.value); setLookupResult(undefined); }} onKeyDown={(event) => event.key === 'Enter' && doSearch()} />
              <button disabled={busy} onClick={doSearch}>Find key</button>
            </div>
          </div>
          <div className="control-section range-lookup-section">
            <label>Range lookup</label>
            <div className="control-fields">
              <input aria-label="Range start" type="number" value={rangeStart} onChange={(event) => { cancelAnimation(); setTrace(new Set()); setRangeStart(event.target.value); }} />
              <span className="range-arrow">to</span>
              <input aria-label="Range end" type="number" value={rangeEnd} onChange={(event) => { cancelAnimation(); setTrace(new Set()); setRangeEnd(event.target.value); }} onKeyDown={(event) => event.key === 'Enter' && doRangeSearch()} />
              <button disabled={busy} onClick={doRangeSearch}>Find range</button>
            </div>
          </div>
          <div className="control-section diff-lookup-section">
            <label>Diff lookup</label>
            <div className="control-fields">
              <button className={lastChangeActive ? 'diff-lookup-button active' : 'diff-lookup-button'} aria-pressed={lastChangeActive} disabled={busy || viewedIndex <= 0} onClick={doDiffLookup}>{lastChangeActive ? 'Clear last change' : 'Highlight last change'}</button>
            </div>
          </div>
        </div>}
      </section>

      {viewingHistorical && (
        <div className="history-view-banner">
          <span>Viewing version {String(viewedIndex + 1).padStart(2, '0')} of {String(snapshots.length).padStart(2, '0')}. Editing is paused for historical states.</span>
          <button onClick={() => { cancelAnimation(); setViewId(undefined); setTrace(new Set()); setLookupResult(undefined); setDiffHighlight(new Set()); setLastChangeActive(false); setSelectedHash(undefined); }}>Return to latest</button>
        </div>
      )}

      {error && <div className="error-banner"><strong>Engine error</strong><span>{error}</span><button onClick={() => setError(undefined)}>×</button></div>}
      {busy && <div className="busy-bar"><span /> DoltLite is rebuilding and hashing the tree…</div>}

      <div className="workbench-layout">
        <div className="workbench-main">
          <nav className="tabs" aria-label="Visualizer views">
            {([
              ['tree', 'Tree'],
              ['diff', `Fast diff${metrics.diff.rowDiffs.length ? ` · ${metrics.diff.rowDiffs.length}` : ''}`],
              ['chunks', `Chunk boundaries · ${metrics.leaves.length}`],
              ['order', 'History independence'],
            ] as [Tab, string][]).map(([id, label]) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
            ))}
          </nav>

          <main className="workspace">
        {tab === 'tree' && (
          <>
            <div className="view-toolbar">
              <div className="legend">
                <span><i className="legend-new" /> new address <InfoTip>A chunk address that did not exist in the immediately previous version.</InfoTip></span>
                <span><i className="legend-trace" /> lookup path <InfoTip>Chunks visited while resolving the current key or range lookup.</InfoTip></span>
                <span><i className="legend-diff" /> changed since previous <InfoTip>Chunks rewritten by the single change between this version and the version immediately before it.</InfoTip></span>
              </div>
              {previous && (
                <div className="change-summary">
                  {metrics.tree.rowDiffs.length === 0 && current.rootHash === previous.rootHash && <strong className="no-content-change">No content change · addresses unchanged</strong>}
                  {metrics.tree.splitDelta > 0 && <strong>Split! +{metrics.tree.splitDelta} leaf {metrics.tree.splitDelta === 1 ? 'chunk' : 'chunks'}</strong>}
                  {metrics.tree.splitDelta < 0 && <strong className="chunk-combine">Combined! {Math.abs(metrics.tree.splitDelta)} fewer leaf {metrics.tree.splitDelta === -1 ? 'chunk' : 'chunks'}</strong>}
                  <span>{metrics.tree.fresh} new</span><span>{metrics.tree.shared} shared</span><span>{metrics.tree.replaced} replaced</span>
                </div>
              )}
            </div>
            <div className={selectedNode ? 'tree-with-inspector open' : 'tree-with-inspector'}>
              <TreeCanvas snapshot={current} baseline={previous} trace={trace} activeTraceHash={activeTraceHash} diffHighlight={diffHighlight} activeDiffHashes={activeDiffHashes} rowDiffs={highlightedRowDiffs} lookup={lookupResult} selectedHash={selectedHash} onSelect={setSelectedHash} />
              <NodeInspector node={selectedNode} rows={current.rows} onClose={() => setSelectedHash(undefined)} />
            </div>
            <div className="tree-storage-note">
              Leaf chunks store encoded keys and SQL values. Internal chunks store delimiter keys and child addresses. Select a chunk to inspect it.
            </div>
          </>
        )}

        {tab === 'diff' && (
          <section className="panel-view diff-view">
            <div className="data-view-head">
              <h2>Fast diff <InfoTip>Content addresses let the diff skip shared subtrees and visit only changed nodes.</InfoTip></h2>
              <div className="diff-version-picker">
                <label htmlFor="compare-from">From</label>
                <select id="compare-from" value={diffBaseline?.id ?? ''} disabled={!diffBaseline} onChange={(event) => setCompareFromId(Number(event.target.value))}>
                  {snapshots.slice(0, Math.max(0, viewedIndex)).map((snapshot, index) => (
                    <option key={snapshot.id} value={snapshot.id}>Version {String(index + 1).padStart(2, '0')} · {snapshot.label}</option>
                  ))}
                </select>
                <span>→ Version {String(viewedIndex + 1).padStart(2, '0')}</span>
              </div>
            </div>
            <div className="diff-metrics">
              <div><b>{metrics.diff.shared}</b><span>subtrees skipped</span></div>
              <div><b>{metrics.diff.fresh}</b><span>new nodes visited</span></div>
              <div><b>{metrics.diff.rowDiffs.length}</b><span>row differences</span></div>
            </div>
            <div className="hash-compare">
              <div><small>BEFORE</small><code>{diffBeforeRoot}</code></div>
              <span className={diffBeforeRoot === current.rootHash ? 'same-root' : 'changed-root'}>{diffBeforeRoot === current.rootHash ? '=' : '≠'}</span>
              <div><small>AFTER</small><code>{current.rootHash}</code></div>
            </div>
            <div className="row-diff-table">
              {metrics.diff.rowDiffs.length === 0 ? <div className="empty-state">These snapshots contain the same rows.</div> : metrics.diff.rowDiffs.map((diff) => (
                <div className={`row-diff ${diff.kind}`} key={diff.key}>
                  <span className="diff-sign">{diff.kind === 'added' ? '+' : diff.kind === 'deleted' ? '−' : '±'}</span>
                  <code>{diff.key}</code><span>{diff.before ?? '∅'}</span><span>→</span><span>{diff.after ?? '∅'}</span><em>{diff.kind}</em>
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === 'chunks' && (
          <section className="panel-view chunks-view">
            <div className="data-view-head">
              <h2>Chunk boundaries <InfoTip>Content-defined boundaries decide where leaf chunks end, independent of insertion order.</InfoTip></h2>
              <div className="chunk-summary">
                <span><b>{metrics.leaves.length}</b> leaves</span>
                <span><b>{metrics.leaves.reduce((total, leaf) => total + leaf.size, 0).toLocaleString()}</b> live bytes</span>
                <span><b>{metrics.leaves.reduce((total, leaf) => total + leaf.entries.length, 0).toLocaleString()}</b> keys</span>
              </div>
            </div>
            <div className="chunk-strip">
              {metrics.leaves.map((leaf, index) => (
                <button key={leaf.hash} style={{ flexGrow: Math.max(1, leaf.entries.length) }} onClick={() => { setSelectedHash(leaf.hash); setTab('tree'); }}>
                  <span>chunk {index + 1}</span><b>{leaf.minKey}–{leaf.maxKey}</b><small>{leaf.size} B · {leaf.entries.length} keys</small><code>{leaf.hash}</code>
                  <em>{formatProbability(estimateMutationSplitProbability(leaf))} split chance</em>
                </button>
              ))}
            </div>
            <div className="chunk-table">
              <div className="chunk-row chunk-head"><span>#</span><span>Key range</span><span>Entries</span><span>Bytes</span><span>Split chance <InfoTip>Estimated chance that inserting an unused integer key in this range creates a new chunk boundary.</InfoTip></span><span>Content address</span></div>
              {metrics.leaves.map((leaf, index) => (
                <button className="chunk-row" key={leaf.hash} onClick={() => { setSelectedHash(leaf.hash); setTab('tree'); }}>
                  <span>{index + 1}</span><span>{leaf.minKey} → {leaf.maxKey}</span><span>{leaf.entries.length}</span><span>{leaf.size.toLocaleString()}</span><strong>{formatProbability(estimateMutationSplitProbability(leaf))}</strong><code>{leaf.hash}</code>
                </button>
              ))}
            </div>
          </section>
        )}

        {tab === 'order' && (
          <section className="panel-view history-order-view">
            <div className="history-order-head">
              <div>
                <h2>History independence <InfoTip>The same final rows produce the same chunks and root address even when edits arrive in a different order.</InfoTip></h2>
                <p>Build A inserts 180 rows in key order. Build B shuffles the inserts and rewrites 30 draft values.</p>
              </div>
              <button className="run-order-button" disabled={busy} onClick={runInsertionOrderDemo}>{insertionOrderResult ? 'Build both again' : 'Build both trees'}</button>
            </div>

            {insertionOrderResult ? (
              <>
                <div className={insertionOrderResult.identicalRoot && insertionOrderResult.identicalChunks ? 'history-match pass' : 'history-match fail'}>
                  <code>{insertionOrderResult.sorted.rootHash}</code>
                  <span>{insertionOrderResult.identicalRoot ? 'same root' : 'different roots'}</span>
                  <span>{insertionOrderResult.identicalChunks ? '3 / 3 live chunk addresses match' : 'live chunk addresses differ'}</span>
                </div>
                <div className="history-trees">
                  <article className="history-tree">
                    <header>
                      <div><span>BUILD A</span><h3>Sorted inserts</h3></div>
                      <code>{formatOrder(insertionOrderResult.sorted.order)}</code>
                    </header>
                    <div className="history-tree-canvas">
                      <TreeCanvas snapshot={insertionOrderResult.sorted.snapshot} trace={NO_HIGHLIGHTS} diffHighlight={NO_HIGHLIGHTS} rowDiffs={NO_ROW_DIFFS} compact selectedHash={orderSelectedHash} onSelect={setOrderSelectedHash} />
                    </div>
                  </article>
                  <article className="history-tree">
                    <header>
                      <div><span>BUILD B</span><h3>Shuffled inserts + {insertionOrderResult.shuffled.updates.length} updates</h3></div>
                      <code>{formatOrder(insertionOrderResult.shuffled.order)}</code>
                    </header>
                    <div className="history-tree-canvas">
                      <TreeCanvas snapshot={insertionOrderResult.shuffled.snapshot} trace={NO_HIGHLIGHTS} diffHighlight={NO_HIGHLIGHTS} rowDiffs={NO_ROW_DIFFS} compact selectedHash={orderSelectedHash} onSelect={setOrderSelectedHash} />
                    </div>
                  </article>
                </div>
                <p className="history-node-hint">Select a node in either tree to match its address in both.</p>
              </>
            ) : (
              <div className="history-empty">The two three-node trees will render here.</div>
            )}
          </section>
        )}

          </main>
        </div>

        <aside className="timeline-section" aria-label="Version history">
          <div className="timeline-head">
            <div><span className="eyebrow">Version graph</span><h2>History <InfoTip dark>Select a version to render its tree. Highlights compare it only with the version immediately before it.</InfoTip></h2></div>
          </div>
          <div className="timeline">
            {[...snapshots].reverse().map((snapshot, reverseIndex) => {
              const index = snapshots.length - reverseIndex - 1;
              return (
                <button key={snapshot.id} className={snapshot.id === current.id ? 'selected' : ''} onClick={() => { cancelAnimation(); setViewId(snapshot.id); setTrace(new Set()); setLookupResult(undefined); setDiffHighlight(new Set()); setLastChangeActive(false); setSelectedHash(undefined); }} disabled={snapshot.id === current.id}>
                  <span>Version {String(index + 1).padStart(2, '0')}{index === snapshots.length - 1 && <em>latest</em>}</span>
                  <b>{snapshot.label}</b>
                  <code>{snapshot.rootHash}</code>
                  <small>{snapshot.rows.length} rows · {snapshot.nodes.size} nodes</small>
                </button>
              );
            })}
          </div>
        </aside>
      </div>

      <footer>
        <span>Runs entirely in your browser. No database server, no simulated tree.</span>
        <a href="https://www.dolthub.com/docs/architecture/storage-engine/prolly-tree/" target="_blank" rel="noreferrer">Read more about Prolly Trees</a>
        <span>DoltLite format v12 · {current.databaseBytes.toLocaleString()} B exported · {current.chunksInStore} stored chunks</span>
      </footer>
    </div>
  );
}

export default App;
