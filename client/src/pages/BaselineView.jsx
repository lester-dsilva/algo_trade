import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../api';
import EquityCurveChart from '../components/EquityCurveChart';
import { sumChargesForTrades } from '../lib/zerodhaCharges';

const TOTAL_CAPITAL = 300000;       // ₹3 lakh
const CAPITAL_PER_TRADE = 50000;   // ₹50k per trade
const TRADING_DAYS_PER_YEAR = 252;
const FALLBACK_CHARGES_PER_TRADE = 55;  // used when trade-level data missing

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

  const { equityPoints, sharpe, maxDrawdown, returnPct } = useMemo(() => {
    if (!baseline?.trades?.length) {
      return { equityPoints: [], sharpe: null, maxDrawdown: 0, returnPct: null };
    }
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
    const dailyReturns = points.map((p) => p.pnl / CAPITAL_PER_TRADE);
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
    const returnPct = points.length && TOTAL_CAPITAL > 0
      ? (points[points.length - 1].cumulativePnl / TOTAL_CAPITAL) * 100
      : null;
    return { equityPoints: points, sharpe, maxDrawdown, returnPct };
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
        <strong>Total PnL:</strong> ₹{baseline.totalPnl?.toFixed(2)} · <strong>Trades:</strong> {baseline.totalTrades}
        {typeof returnPct === 'number' && (
          <> · <strong>Return:</strong> {returnPct.toFixed(2)}%</>
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
            {typeof returnPct === 'number' && ` · Return: ${returnPct.toFixed(2)}%`}
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
