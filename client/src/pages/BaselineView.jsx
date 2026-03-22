import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../api';
import EquityCurveChart from '../components/EquityCurveChart';
import { sumChargesForTrades } from '../lib/zerodhaCharges';

/** Defaults when baseline JSON has no config (older saves) */
const DEFAULT_CAPITAL_PER_TRADE = 50000;
/** Must match v2/scripts/runBacktest.js MAX_CONCURRENT_TRADES */
const MAX_CONCURRENT_TRADES = 6;
const TRADING_DAYS_PER_YEAR = 252;
const FALLBACK_CHARGES_PER_TRADE = 55;  // used when trade-level data missing

function getSizingFromBaseline(baseline) {
  const raw = baseline?.config?.capitalPerTrade;
  const capitalPerTrade = Number.isFinite(Number(raw)) && Number(raw) > 0
    ? Number(raw)
    : DEFAULT_CAPITAL_PER_TRADE;
  const totalCapital = capitalPerTrade * MAX_CONCURRENT_TRADES;
  return { capitalPerTrade, totalCapital };
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

export default function BaselineView() {
  const { name } = useParams();
  const navigate = useNavigate();
  const [baseline, setBaseline] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!name) return;
    setLoading(true);
    setError('');
    api
      .getBaseline(name)
      .then(setBaseline)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [name]);

  const {
    equityPoints,
    sharpe,
    maxDrawdown,
    returnPctNet,
    totalCharges,
    grossPnl,
    netPnl,
    totalCapital,
    capitalPerTrade,
  } = useMemo(() => {
    if (!baseline?.trades?.length) {
      return {
        equityPoints: [],
        sharpe: null,
        maxDrawdown: 0,
        returnPctNet: null,
        totalCharges: 0,
        grossPnl: 0,
        netPnl: 0,
        totalCapital: DEFAULT_CAPITAL_PER_TRADE * MAX_CONCURRENT_TRADES,
        capitalPerTrade: DEFAULT_CAPITAL_PER_TRADE,
      };
    }
    const { capitalPerTrade, totalCapital } = getSizingFromBaseline(baseline);
    const trades = baseline.trades;
    const byDateMap = {};
    for (const t of trades) {
      const d = t.date;
      if (!d) continue;
      if (!byDateMap[d]) byDateMap[d] = { date: d, trades: 0, wins: 0, losses: 0, pnl: 0, tradeList: [] };
      byDateMap[d].trades += 1;
      byDateMap[d].tradeList.push(t);
      const pnl = t.pnl ?? 0;
      if (pnl > 0) byDateMap[d].wins += 1;
      else byDateMap[d].losses += 1;
      byDateMap[d].pnl += pnl;
    }
    const byDate = Object.values(byDateMap).sort((a, b) => a.date.localeCompare(b.date));
    let cum = 0;
    const points = byDate.map((row) => {
      const charges = row.tradeList?.length
        ? sumChargesForTrades(row.tradeList)
        : (row.trades || 0) * FALLBACK_CHARGES_PER_TRADE;
      const netPnl = row.pnl - charges;
      cum += netPnl;
      return { date: row.date, pnl: netPnl, cumulativePnl: cum };
    });
    const dailyReturns = points.map((p) => p.pnl / capitalPerTrade);
    const n = dailyReturns.length;
    const meanReturn = n ? dailyReturns.reduce((a, b) => a + b, 0) / n : 0;
    const variance = n > 1 ? dailyReturns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (n - 1) : 0;
    const stdReturn = Math.sqrt(variance);
    const sharpe = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(TRADING_DAYS_PER_YEAR) : null;
    let peak = 0;
    let maxDrawdown = 0;
    for (const p of points) {
      if (p.cumulativePnl > peak) peak = p.cumulativePnl;
      const dd = peak - p.cumulativePnl;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    const grossPnl = baseline.totalPnl ?? trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalCharges = sumChargesForTrades(trades);
    const finalCumulativeNet = points.length ? points[points.length - 1].cumulativePnl : 0;
    // Net matches equity curve endpoint (daily gross − charges); may differ slightly from grossPnl − charges if totals drift
    const netPnl = round2(finalCumulativeNet);
    // Net return vs deployed capital (6 × per-trade); equity curve is already net of charges per day
    const returnPctNet = totalCapital > 0
      ? (finalCumulativeNet / totalCapital) * 100
      : null;
    return {
      equityPoints: points,
      sharpe,
      maxDrawdown,
      returnPctNet,
      totalCharges,
      grossPnl,
      netPnl,
      totalCapital,
      capitalPerTrade,
    };
  }, [baseline]);

  if (loading) return <div className="page"><p>Loading baseline…</p></div>;
  if (error) return <div className="page"><div className="error">{error}</div></div>;
  if (!baseline) return null;

  const byMonth = baseline.byMonth || [];

  return (
    <div className="page">
      <nav className="muted"><Link to="/">Dashboard</Link> / Baseline: {baseline.name || name}</nav>
      <h1>Baseline: {baseline.name || name}</h1>
      {baseline.savedAt && (
        <p className="muted">Saved at {new Date(baseline.savedAt).toLocaleString()}</p>
      )}
      <p>
        <strong>Trades:</strong> {baseline.totalTrades}
        {' · '}
        <strong>Gross PnL:</strong> ₹{grossPnl?.toFixed(2)}
        {' · '}
        <strong>Charges (est.):</strong> ₹{totalCharges?.toFixed(2)}
        {' · '}
        <strong>Net PnL:</strong> ₹{netPnl?.toFixed(2)}
      </p>
      <p className="muted">
        Sizing: ₹{capitalPerTrade?.toLocaleString('en-IN')} per trade × {MAX_CONCURRENT_TRADES} slots = ₹{totalCapital?.toLocaleString('en-IN')} notional capital (from saved baseline config; default ₹50k×6 if missing).
        {typeof returnPctNet === 'number' && (
          <>
            {' '}
            <strong>Return (net / charges):</strong> {returnPctNet.toFixed(2)}% on ₹{totalCapital?.toLocaleString('en-IN')}
          </>
        )}
      </p>
      <p>
        <button
          type="button"
          className="danger"
          disabled={deleting}
          onClick={() => {
            if (!window.confirm(`Delete baseline "${baseline.name || name}"? This cannot be undone.`)) return;
            setDeleting(true);
            api.deleteBaseline(name).then(() => {
              navigate('/');
            }).catch((e) => {
              setError(e.message);
              setDeleting(false);
            });
          }}
        >
          {deleting ? 'Deleting…' : 'Delete baseline'}
        </button>
      </p>

      {equityPoints.length > 0 && (
        <section className="card">
          <h2>Equity curve</h2>
          <p className="muted">
            Sharpe: {sharpe != null ? sharpe.toFixed(3) : 'n/a'} · Max drawdown: ₹{maxDrawdown?.toFixed(2)}
            {typeof returnPctNet === 'number' && ` · Net return: ${returnPctNet.toFixed(2)}% (on ₹${totalCapital?.toLocaleString('en-IN')})`}
          </p>
          <EquityCurveChart points={equityPoints} />
        </section>
      )}

      <section className="card">
        <h2>Trades by month</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Month</th>
              <th>Dates</th>
              <th>Trades</th>
              <th>Wins</th>
              <th>Losses</th>
              <th>PnL</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {byMonth.map((row) => (
              <tr key={row.month}>
                <td>{row.month}</td>
                <td>{row.dates}</td>
                <td>{row.trades}</td>
                <td>{row.wins}</td>
                <td>{row.losses}</td>
                <td className={(row.pnl || 0) >= 0 ? 'positive' : 'negative'}>
                  ₹{(row.pnl || 0).toFixed(2)}
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => navigate(`/baseline/${encodeURIComponent(name)}/month/${row.month}`)}
                  >
                    View month
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
