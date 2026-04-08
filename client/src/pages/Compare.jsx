import { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import * as api from '../api';
import ChartModal from '../components/ChartModal';
import EquityCurveChart from '../components/EquityCurveChart';
import { sumChargesForTrades } from '../lib/zerodhaCharges';

const DEFAULT_CAPITAL_PER_TRADE = 50000;
const MAX_CONCURRENT_TRADES = 6;
const TRADING_DAYS_PER_YEAR = 252;
const FALLBACK_CHARGES_PER_TRADE = 55;

function computeStats(baseline) {
  if (!baseline?.trades?.length) return null;
  const raw = baseline?.config?.capitalPerTrade;
  const capitalPerTrade = Number.isFinite(Number(raw)) && Number(raw) > 0
    ? Number(raw) : DEFAULT_CAPITAL_PER_TRADE;
  const totalCapital = capitalPerTrade * MAX_CONCURRENT_TRADES;
  const trades = baseline.trades;
  const byDateMap = {};
  for (const t of trades) {
    const d = t.date; if (!d) continue;
    if (!byDateMap[d]) byDateMap[d] = { date: d, trades: 0, wins: 0, losses: 0, pnl: 0, tradeList: [] };
    byDateMap[d].trades += 1;
    byDateMap[d].tradeList.push(t);
    if ((t.pnl ?? 0) > 0) byDateMap[d].wins += 1; else byDateMap[d].losses += 1;
    byDateMap[d].pnl += t.pnl ?? 0;
  }
  const byDate = Object.values(byDateMap).sort((a, b) => a.date.localeCompare(b.date));
  let cum = 0;
  const equityPoints = byDate.map((row) => {
    const charges = row.tradeList?.length
      ? sumChargesForTrades(row.tradeList)
      : (row.trades || 0) * FALLBACK_CHARGES_PER_TRADE;
    const netPnl = row.pnl - charges;
    cum += netPnl;
    return { date: row.date, pnl: netPnl, cumulativePnl: cum };
  });
  const dailyReturns = equityPoints.map((p) => p.pnl / capitalPerTrade);
  const n = dailyReturns.length;
  const mean = n ? dailyReturns.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1) : 0;
  const sharpe = Math.sqrt(variance) > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(TRADING_DAYS_PER_YEAR) : null;
  let peak = 0, maxDrawdown = 0;
  for (const p of equityPoints) {
    if (p.cumulativePnl > peak) peak = p.cumulativePnl;
    const dd = peak - p.cumulativePnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const grossPnl = baseline.totalPnl ?? trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalCharges = sumChargesForTrades(trades);
  const netPnl = equityPoints.length ? equityPoints[equityPoints.length - 1].cumulativePnl : 0;
  const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = trades.filter((t) => (t.pnl ?? 0) <= 0).length;
  return {
    equityPoints, sharpe, maxDrawdown, grossPnl, totalCharges,
    netPnl, totalCapital, capitalPerTrade,
    totalTrades: trades.length, wins, losses,
    returnPctNet: totalCapital > 0 ? (netPnl / totalCapital) * 100 : null,
  };
}

function StatRow({ label, a, b, fmt = (v) => v, diffFmt, positive }) {
  const av = a != null ? fmt(a) : '—';
  const bv = b != null ? fmt(b) : '—';
  let diff = null, diffCls = '';
  if (a != null && b != null) {
    const raw = b - a;
    diff = diffFmt ? diffFmt(raw) : fmt(raw);
    diffCls = raw > 0 ? (positive === false ? 'negative' : 'positive')
            : raw < 0 ? (positive === false ? 'positive' : 'negative') : '';
  }
  return (
    <tr>
      <td className="muted">{label}</td>
      <td>{av}</td>
      <td>{bv}</td>
      <td className={diffCls}>{diff != null ? (b - a > 0 ? '+' : '') + diff : '—'}</td>
    </tr>
  );
}

const STRAT_BADGE = {
  explosion:   { bg: '#fff3cd', color: '#856404', label: 'explosion' },
  v2_breakout: { bg: '#e8f4fd', color: '#0d6efd', label: 'v2' },
};

function StratBadge({ strategy }) {
  const s = strategy || 'v2_breakout';
  const b = STRAT_BADGE[s] || { bg: '#f0f0f0', color: '#555', label: s };
  return (
    <span style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: 10,
      fontSize: '0.78rem', fontWeight: 600,
      background: b.bg, color: b.color,
    }}>{b.label}</span>
  );
}

export default function Compare() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [names, setNames] = useState([]);
  const [nameA, setNameA] = useState(searchParams.get('a') || '');
  const [nameB, setNameB] = useState(searchParams.get('b') || '');
  const [baselineA, setBaselineA] = useState(null);
  const [baselineB, setBaselineB] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [chart, setChart] = useState(null); // { date, symbol, baselineName }
  const [onlyFilter, setOnlyFilter] = useState('new'); // 'new' | 'removed' | 'all'
  const [stratFilter, setStratFilter] = useState('all'); // 'all' | 'explosion' | 'v2_breakout'

  useEffect(() => {
    api.getBaselines().then((d) => setNames(d.names || [])).catch(() => {});
  }, []);

  // Auto-load if URL params present
  useEffect(() => {
    const a = searchParams.get('a');
    const b = searchParams.get('b');
    if (a && b) {
      setNameA(a); setNameB(b);
      loadBoth(a, b);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadBoth(a, b) {
    if (!a || !b) return;
    setLoading(true); setError('');
    setBaselineA(null); setBaselineB(null);
    setSearchParams({ a, b });
    Promise.all([api.getBaseline(a), api.getBaseline(b)])
      .then(([ba, bb]) => { setBaselineA(ba); setBaselineB(bb); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  const statsA = useMemo(() => computeStats(baselineA), [baselineA]);
  const statsB = useMemo(() => computeStats(baselineB), [baselineB]);

  // Build trade diff: keyed by date+symbol
  const { newTrades, removedTrades, changedTrades } = useMemo(() => {
    if (!baselineA?.trades || !baselineB?.trades) return { newTrades: [], removedTrades: [], changedTrades: [] };
    const keyOf = (t) => `${t.date}__${t.symbol}`;
    const mapA = new Map(baselineA.trades.map((t) => [keyOf(t), t]));
    const mapB = new Map(baselineB.trades.map((t) => [keyOf(t), t]));
    const newT   = baselineB.trades.filter((t) => !mapA.has(keyOf(t)));
    const removedT = baselineA.trades.filter((t) => !mapB.has(keyOf(t)));
    const changedT = baselineB.trades.filter((t) => {
      const a = mapA.get(keyOf(t));
      return a && Math.abs((a.pnl ?? 0) - (t.pnl ?? 0)) > 0.01;
    }).map((t) => ({ ...t, prevPnl: mapA.get(keyOf(t))?.pnl ?? 0 }));
    return { newTrades: newT, removedTrades: removedT, changedTrades: changedT };
  }, [baselineA, baselineB]);

  const fmtRs = (v) => `₹${Math.round(v ?? 0).toLocaleString('en-IN')}`;
  const fmtPct = (v) => `${(v ?? 0).toFixed(2)}%`;
  const fmtN = (v) => String(Math.round(v ?? 0));

  const displayTrades = useMemo(() => {
    let list = [];
    if (onlyFilter === 'new' || onlyFilter === 'all') {
      list = [...list, ...newTrades.map((t) => ({ ...t, _diff: 'new' }))];
    }
    if (onlyFilter === 'removed' || onlyFilter === 'all') {
      list = [...list, ...removedTrades.map((t) => ({ ...t, _diff: 'removed' }))];
    }
    if (stratFilter !== 'all') {
      list = list.filter((t) => (t.strategy || 'v2_breakout') === stratFilter);
    }
    return list.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  }, [newTrades, removedTrades, onlyFilter, stratFilter]);

  const hasData = baselineA && baselineB;

  return (
    <div className="page">
      <nav className="muted"><Link to="/">Dashboard</Link> / Compare baselines</nav>
      <h1>Compare Baselines</h1>

      {/* Selector */}
      <div className="card" style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, minWidth: 160 }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>Baseline A (base)</span>
          <select value={nameA} onChange={(e) => setNameA(e.target.value)} style={{ padding: '0.4rem' }}>
            <option value="">— select —</option>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1, minWidth: 160 }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>Baseline B (new)</span>
          <select value={nameB} onChange={(e) => setNameB(e.target.value)} style={{ padding: '0.4rem' }}>
            <option value="">— select —</option>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button
          type="button"
          disabled={!nameA || !nameB || nameA === nameB || loading}
          onClick={() => loadBoth(nameA, nameB)}
          style={{ padding: '0.45rem 1.2rem' }}
        >
          {loading ? 'Loading…' : 'Compare'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {!hasData && !loading && !error && (
        <p className="muted">Select two baselines and click Compare.</p>
      )}

      {hasData && (
        <>
          {/* Stats side-by-side */}
          <section className="card">
            <h2>Stats comparison</h2>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th></th>
                    <th style={{ color: '#555' }}>{baselineA.name} (A)</th>
                    <th style={{ color: '#0d6efd' }}>{baselineB.name} (B)</th>
                    <th>B − A</th>
                  </tr>
                </thead>
                <tbody>
                  <StatRow label="Trades"    a={statsA?.totalTrades} b={statsB?.totalTrades} fmt={fmtN} />
                  <StatRow label="Wins"      a={statsA?.wins}        b={statsB?.wins}        fmt={fmtN} />
                  <StatRow label="Losses"    a={statsA?.losses}      b={statsB?.losses}      fmt={fmtN} positive={false} />
                  <StatRow label="Win %"
                    a={statsA ? statsA.wins / statsA.totalTrades * 100 : null}
                    b={statsB ? statsB.wins / statsB.totalTrades * 100 : null}
                    fmt={fmtPct} diffFmt={fmtPct}
                  />
                  <StatRow label="Gross PnL" a={statsA?.grossPnl}   b={statsB?.grossPnl}   fmt={fmtRs} diffFmt={fmtRs} />
                  <StatRow label="Charges"   a={statsA?.totalCharges} b={statsB?.totalCharges} fmt={fmtRs} diffFmt={fmtRs} positive={false} />
                  <StatRow label="Net PnL"   a={statsA?.netPnl}     b={statsB?.netPnl}     fmt={fmtRs} diffFmt={fmtRs} />
                  <StatRow label="Return %"  a={statsA?.returnPctNet} b={statsB?.returnPctNet} fmt={fmtPct} diffFmt={fmtPct} />
                  <StatRow label="Sharpe"
                    a={statsA?.sharpe} b={statsB?.sharpe}
                    fmt={(v) => v?.toFixed(3) ?? '—'} diffFmt={(v) => v?.toFixed(3) ?? '—'}
                  />
                  <StatRow label="Max DD"    a={statsA?.maxDrawdown} b={statsB?.maxDrawdown} fmt={fmtRs} diffFmt={fmtRs} positive={false} />
                </tbody>
              </table>
            </div>
          </section>

          {/* Equity curves */}
          {(statsA?.equityPoints?.length > 0 || statsB?.equityPoints?.length > 0) && (
            <section className="card">
              <h2>Equity curves</h2>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                {statsA?.equityPoints?.length > 0 && (
                  <div>
                    <p className="muted" style={{ margin: '0 0 0.4rem', fontSize: '0.85rem' }}>
                      A: {baselineA.name} · Sharpe {statsA.sharpe?.toFixed(3) ?? 'n/a'} · DD ₹{statsA.maxDrawdown?.toFixed(0)}
                    </p>
                    <EquityCurveChart points={statsA.equityPoints} />
                  </div>
                )}
                {statsB?.equityPoints?.length > 0 && (
                  <div>
                    <p className="muted" style={{ margin: '0 0 0.4rem', fontSize: '0.85rem' }}>
                      B: {baselineB.name} · Sharpe {statsB.sharpe?.toFixed(3) ?? 'n/a'} · DD ₹{statsB.maxDrawdown?.toFixed(0)}
                    </p>
                    <EquityCurveChart points={statsB.equityPoints} />
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Trade diff */}
          <section className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
              <h2 style={{ margin: 0 }}>Trade diff</h2>
              <span className="muted" style={{ fontSize: '0.85rem' }}>
                +{newTrades.length} new in B &nbsp;·&nbsp; -{removedTrades.length} removed from B &nbsp;·&nbsp; {changedTrades.length} changed PnL
              </span>
              <div style={{ display: 'flex', gap: '0.4rem', marginLeft: 'auto', flexWrap: 'wrap' }}>
                <select value={onlyFilter} onChange={(e) => setOnlyFilter(e.target.value)} style={{ padding: '0.3rem' }}>
                  <option value="new">New in B only</option>
                  <option value="removed">Removed (A only)</option>
                  <option value="all">All diff</option>
                </select>
                <select value={stratFilter} onChange={(e) => setStratFilter(e.target.value)} style={{ padding: '0.3rem' }}>
                  <option value="all">All strategies</option>
                  <option value="explosion">explosion</option>
                  <option value="v2_breakout">v2_breakout</option>
                </select>
              </div>
            </div>

            {displayTrades.length === 0 ? (
              <p className="muted">No trades match the current filter.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Date</th>
                      <th>Symbol</th>
                      <th>Strategy</th>
                      <th>Time</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>Reason</th>
                      <th>PnL</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayTrades.map((t, i) => {
                      const isNew = t._diff === 'new';
                      const rowStyle = isNew
                        ? { background: '#f0fff4' }
                        : { background: '#fff8f8' };
                      return (
                        <tr key={i} style={rowStyle}>
                          <td>
                            <span style={{
                              display: 'inline-block', padding: '1px 7px', borderRadius: 10,
                              fontSize: '0.75rem', fontWeight: 700,
                              background: isNew ? '#c3e6cb' : '#f5c6cb',
                              color: isNew ? '#155724' : '#721c24',
                            }}>
                              {isNew ? '+new' : '−removed'}
                            </span>
                          </td>
                          <td><Link to={`/day/${t.date}`} style={{ fontSize: '0.9rem' }}>{t.date}</Link></td>
                          <td style={{ fontWeight: 600 }}>{t.symbol}</td>
                          <td><StratBadge strategy={t.strategy} /></td>
                          <td className="muted">{(t.time || '').slice(0, 5)}</td>
                          <td>{t.entry?.toFixed(2)}</td>
                          <td>{t.exitPrice?.toFixed(2)}</td>
                          <td className="muted">{t.exitReason}</td>
                          <td className={(t.pnl ?? 0) >= 0 ? 'positive' : 'negative'}>
                            ₹{(t.pnl ?? 0).toFixed(2)}
                          </td>
                          <td>
                            <button
                              type="button"
                              onClick={() => setChart({ date: t.date, symbol: t.symbol })}
                              style={{ padding: '0.2rem 0.6rem', fontSize: '0.8rem' }}
                            >
                              Chart
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 600 }}>
                      <td colSpan={8} className="muted">Total PnL ({displayTrades.length} trades)</td>
                      <td className={displayTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) >= 0 ? 'positive' : 'negative'}>
                        ₹{displayTrades.reduce((s, t) => s + (t.pnl ?? 0), 0).toFixed(2)}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {chart && (
        <ChartModal
          date={chart.date}
          symbol={chart.symbol}
          baselineName={chart.baselineName}
          onClose={() => setChart(null)}
        />
      )}
    </div>
  );
}
