import { useEffect, useMemo, useRef, useState } from 'react';
import { ProllyEngine, type HistoryIndependenceResult } from './engine';
import { countSharedNodes, diffRows, leafNodes, traceSearch } from './prolly';
import type { ProllyNode, TreeSnapshot } from './types';
import { NodeInspector } from './components/NodeInspector';
import { TreeCanvas } from './components/TreeCanvas';

type Tab = 'tree' | 'diff' | 'chunks' | 'concepts';

function shortHash(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function App() {
  const engineRef = useRef<ProllyEngine | undefined>(undefined);
  const [snapshots, setSnapshots] = useState<TreeSnapshot[]>([]);
  const [compareId, setCompareId] = useState<number>();
  const [selectedHash, setSelectedHash] = useState<string>();
  const [tab, setTab] = useState<Tab>('tree');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [keyInput, setKeyInput] = useState('49');
  const [valueInput, setValueInput] = useState('value-49');
  const [searchInput, setSearchInput] = useState('24');
  const [trace, setTrace] = useState<Set<string>>(new Set());
  const [historyResult, setHistoryResult] = useState<HistoryIndependenceResult>();

  const current = snapshots.at(-1);
  const baseline = snapshots.find((snapshot) => snapshot.id === compareId)
    ?? (snapshots.length > 1 ? snapshots.at(-2) : undefined);

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
      setKeyInput(String(first.rows.at(-1)!.key + 1));
      setValueInput(`value-${first.rows.at(-1)!.key + 1}`);
      setSearchInput(String(first.rows[Math.floor(first.rows.length / 2)].key));
      setError(undefined);
      setBusy(false);
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    });
    return () => {
      cancelled = true;
      engineRef.current?.close();
    };
  }, []);

  const appendSnapshot = (snapshot: TreeSnapshot) => {
    setSnapshots((existing) => {
      const previous = existing.at(-1);
      if (previous) setCompareId(previous.id);
      return [...existing, snapshot];
    });
    setTrace(new Set());
    setSelectedHash(undefined);
    setKeyInput(String((snapshot.rows.at(-1)?.key ?? 0) + 1));
  };

  const run = (operation: (engine: ProllyEngine) => TreeSnapshot) => {
    const engine = engineRef.current;
    if (!engine) return;
    setBusy(true);
    setError(undefined);
    window.setTimeout(() => {
      try {
        appendSnapshot(operation(engine));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    }, 20);
  };

  const metrics = useMemo(() => {
    if (!current) return undefined;
    const leaves = leafNodes(current.root);
    const shared = baseline ? countSharedNodes(baseline.nodes, current.nodes) : 0;
    const beforeLeaves = baseline ? leafNodes(baseline.root).length : leaves.length;
    return {
      leaves,
      shared,
      fresh: baseline ? current.nodes.size - shared : 0,
      replaced: baseline ? baseline.nodes.size - shared : 0,
      splitDelta: leaves.length - beforeLeaves,
      rowDiffs: baseline ? diffRows(baseline.rows, current.rows) : [],
    };
  }, [baseline, current]);

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

  const doSearch = () => {
    const key = Number(searchInput);
    if (!Number.isSafeInteger(key)) return;
    setTrace(new Set(traceSearch(current.root, key)));
    setTab('tree');
  };

  const runHistoryDemo = () => {
    const engine = engineRef.current;
    if (!engine) return;
    setBusy(true);
    window.setTimeout(() => {
      try {
        setHistoryResult(engine.historyIndependence(current.rows));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    }, 20);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><span /><span /><span /><i /></div>
          <div><strong>Prolly Tree Lab</strong><small>powered by DoltLite WASM</small></div>
        </div>
        <div className="runtime-pill"><span className="status-dot" /> real engine · {engineRef.current?.version}</div>
        <a className="source-link" href="https://github.com/dolthub/doltlite" target="_blank" rel="noreferrer">DoltLite ↗</a>
      </header>

      <section className="database-summary">
        <div className="root-card">
          <span>Current table root</span>
          <code>{current.rootHash}</code>
          <div><b>{current.rows.length}</b> rows <i /> <b>{current.nodes.size}</b> live nodes <i /> <b>{current.root.level + 1}</b> levels</div>
        </div>
      </section>

      <section className="control-deck">
        <div className="control-group mutation-control">
          <label>Insert or update</label>
          <input aria-label="Key" type="number" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} />
          <input aria-label="Value" value={valueInput} onChange={(event) => setValueInput(event.target.value)} />
          <button className="primary-button" disabled={busy} onClick={() => {
            const key = Number(keyInput);
            if (Number.isSafeInteger(key)) run((engine) => engine.put(key, valueInput || `value-${key}`));
          }}>Put row</button>
        </div>
        <div className="control-group search-control">
          <label>Trace a lookup</label>
          <input aria-label="Search key" type="number" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && doSearch()} />
          <button disabled={busy} onClick={doSearch}>Find path</button>
        </div>
        <div className="quick-actions">
          <button disabled={busy} onClick={() => run((engine) => engine.addRandom())}>+ Random</button>
          <button disabled={busy} onClick={() => run((engine) => engine.addSequential(25))}>+ 25 rows</button>
          <button disabled={busy} onClick={() => {
            setBusy(true);
            window.setTimeout(() => {
              try {
                const result = engineRef.current!.growUntilSplit();
                setSnapshots((existing) => [...existing, result.before, result.after]);
                setCompareId(result.before.id);
                setTab('tree');
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusy(false);
              }
            }, 20);
          }}>Force next split</button>
          <button className="danger-quiet" disabled={busy} onClick={() => {
            const key = Number(keyInput);
            if (Number.isSafeInteger(key)) run((engine) => engine.remove(key));
          }}>Delete key</button>
          <button className="reset-button" disabled={busy} onClick={() => {
            const engine = engineRef.current;
            if (!engine) return;
            setBusy(true);
            window.setTimeout(() => {
              try {
                const snapshot = engine.reset();
                setSnapshots([snapshot]);
                setCompareId(undefined);
                setTrace(new Set());
              } finally {
                setBusy(false);
              }
            }, 20);
          }}>Reset</button>
        </div>
      </section>

      {error && <div className="error-banner"><strong>Engine error</strong><span>{error}</span><button onClick={() => setError(undefined)}>×</button></div>}
      {busy && <div className="busy-bar"><span /> DoltLite is rebuilding and hashing the tree…</div>}

      <nav className="tabs" aria-label="Visualizer views">
        {([
          ['tree', 'Tree'],
          ['diff', `Fast diff${metrics.rowDiffs.length ? ` · ${metrics.rowDiffs.length}` : ''}`],
          ['chunks', `Chunk boundaries · ${metrics.leaves.length}`],
          ['concepts', 'Opus concepts'],
        ] as [Tab, string][]).map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>

      <main className="workspace">
        {tab === 'tree' && (
          <>
            <div className="view-toolbar">
              <div className="legend">
                <span><i className="legend-new" /> new address</span>
                <span><i className="legend-shared" /> structurally shared</span>
                <span><i className="legend-trace" /> lookup path</span>
              </div>
              {baseline && (
                <div className="change-summary">
                  {metrics.splitDelta > 0 && <strong>Split! +{metrics.splitDelta} leaf {metrics.splitDelta === 1 ? 'chunk' : 'chunks'}</strong>}
                  <span>{metrics.fresh} new</span><span>{metrics.shared} shared</span><span>{metrics.replaced} replaced</span>
                </div>
              )}
            </div>
            <div className={selectedNode ? 'tree-with-inspector open' : 'tree-with-inspector'}>
              <TreeCanvas snapshot={current} baseline={baseline} trace={trace} selectedHash={selectedHash} onSelect={setSelectedHash} />
              <NodeInspector node={selectedNode} rows={current.rows} onClose={() => setSelectedHash(undefined)} />
            </div>
          </>
        )}

        {tab === 'diff' && (
          <section className="panel-view diff-view">
            <div className="panel-intro">
              <span className="eyebrow">Hash-pruned comparison</span>
              <h2>Diff work scales with what changed.</h2>
              <p>Matching addresses represent identical subtrees. A diff skips all {metrics.shared} shared nodes and descends only through changed hashes.</p>
            </div>
            <div className="diff-metrics">
              <div><b>{metrics.shared}</b><span>subtrees skipped</span></div>
              <div><b>{metrics.fresh}</b><span>new nodes visited</span></div>
              <div><b>{metrics.rowDiffs.length}</b><span>row differences</span></div>
            </div>
            <div className="hash-compare">
              <div><small>BEFORE</small><code>{baseline?.rootHash ?? current.rootHash}</code></div>
              <span className={baseline?.rootHash === current.rootHash ? 'same-root' : 'changed-root'}>{baseline?.rootHash === current.rootHash ? '=' : '≠'}</span>
              <div><small>AFTER</small><code>{current.rootHash}</code></div>
            </div>
            <div className="row-diff-table">
              {metrics.rowDiffs.length === 0 ? <div className="empty-state">These snapshots contain the same rows.</div> : metrics.rowDiffs.map((diff) => (
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
            <div className="panel-intro">
              <span className="eyebrow">Content-defined chunking</span>
              <h2>Keys choose the boundaries.</h2>
              <p>DoltLite considers each encoded key, the current chunk size, and a deterministic hash. Nodes are clamped between 512 B and 16 KiB; values do not choose boundaries.</p>
            </div>
            <div className="chunk-strip">
              {metrics.leaves.map((leaf, index) => (
                <button key={leaf.hash} style={{ flexGrow: Math.max(1, leaf.entries.length) }} onClick={() => { setSelectedHash(leaf.hash); setTab('tree'); }}>
                  <span>chunk {index + 1}</span><b>{leaf.minKey}–{leaf.maxKey}</b><small>{leaf.size} B · {leaf.entries.length} keys</small><code>{shortHash(leaf.hash)}</code>
                </button>
              ))}
            </div>
            <div className="chunk-table">
              <div className="chunk-row chunk-head"><span>#</span><span>Key range</span><span>Entries</span><span>Bytes</span><span>Content address</span></div>
              {metrics.leaves.map((leaf, index) => (
                <button className="chunk-row" key={leaf.hash} onClick={() => { setSelectedHash(leaf.hash); setTab('tree'); }}>
                  <span>{index + 1}</span><span>{leaf.minKey} → {leaf.maxKey}</span><span>{leaf.entries.length}</span><span>{leaf.size.toLocaleString()}</span><code>{leaf.hash}</code>
                </button>
              ))}
            </div>
          </section>
        )}

        {tab === 'concepts' && (
          <section className="panel-view concepts-view">
            <div className="panel-intro">
              <span className="eyebrow">The prolly tree opus, made tangible</span>
              <h2>Try the properties, don’t just read about them.</h2>
            </div>
            <div className="concept-grid">
              <article><span>01</span><h3>Build bottom-up</h3><p>Sorted key/value rows form leaf chunks. Each parent maps a child’s highest key to its content address until one root remains.</p><button onClick={() => setTab('tree')}>Explore levels</button></article>
              <article><span>02</span><h3>Copy on write</h3><p>Update a value and only the leaf-to-root path receives new addresses. Neighboring chunks stay physically shared.</p><button disabled={busy} onClick={() => {
                const row = current.rows[Math.floor(current.rows.length / 2)];
                if (row) run((engine) => engine.put(row.key, `${row.value} · edited`));
                setTab('tree');
              }}>Update middle row</button></article>
              <article><span>03</span><h3>Insert and split</h3><p>An insert can move a deterministic boundary. The old chunk remains addressable while new leaf chunks replace it in this version.</p><button disabled={busy} onClick={() => run((engine) => engine.addSequential(25))}>Grow the tree</button></article>
              <article><span>04</span><h3>Fast diff</h3><p>Equal hashes prove equal subtrees. The comparison prunes shared nodes without reading every row.</p><button onClick={() => setTab('diff')}>See current diff</button></article>
              <article className="history-card"><span>05</span><h3>History independence</h3><p>Build the same map in ascending and descending insertion order. DoltLite should produce exactly the same root address.</p><button disabled={busy} onClick={runHistoryDemo}>Run two real builds</button>
                {historyResult && <div className={historyResult.identical ? 'history-result pass' : 'history-result fail'}><strong>{historyResult.identical ? 'Identical roots' : 'Roots differ'}</strong><code>{historyResult.forwardHash}</code><code>{historyResult.reverseHash}</code><small>{historyResult.rowCount} rows inserted in opposite orders</small></div>}
              </article>
              <article><span>06</span><h3>Structural sharing</h3><p>The content-addressed store writes a chunk once. This comparison currently reuses {metrics.shared} of {current.nodes.size} live nodes.</p><button onClick={() => setTab('chunks')}>Inspect addresses</button></article>
            </div>
            <a className="opus-link" href="https://www.dolthub.com/docs/architecture/storage-engine/prolly-tree/" target="_blank" rel="noreferrer">Read the complete Prolly Tree opus ↗</a>
          </section>
        )}
      </main>

      <section className="timeline-section">
        <div className="timeline-head"><div><span className="eyebrow">Version timeline</span><h2>Choose a baseline</h2></div><p>Each operation keeps the previous content addresses available for comparison.</p></div>
        <div className="timeline">
          {snapshots.map((snapshot, index) => (
            <button key={snapshot.id} className={baseline?.id === snapshot.id ? 'selected' : ''} onClick={() => setCompareId(snapshot.id)} disabled={snapshot.id === current.id}>
              <span>{String(index + 1).padStart(2, '0')}</span><b>{snapshot.label}</b><code>{shortHash(snapshot.rootHash)}</code><small>{snapshot.rows.length} rows · {snapshot.nodes.size} nodes</small>
            </button>
          ))}
        </div>
      </section>

      <footer><span>Runs entirely in your browser. No database server, no simulated tree.</span><span>DoltLite format v12 · {current.databaseBytes.toLocaleString()} B exported · {current.chunksInStore} stored chunks</span></footer>
    </div>
  );
}

export default App;
