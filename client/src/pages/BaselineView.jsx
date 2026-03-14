import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../api';
import EquityCurveChart from '../components/EquityCurveChart';

const CAPITAL_PER_DAY = 50000;
const TRADING_DAYS_PER_YEAR = 252;

export default function BaselineView() {
  const { name } = useParams();
  const navigate = useNavigate();
  const [baseline, setBaseline] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedMonth, setExpandedMonth] = useState(null);

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

  const { byDate, equityPoints, sharpe, maxDrawdown } = useMemo(() => {
    if (!baseline?.trades?.length) {
      return { byDate: [], equityPoints: [], sharpe: null, maxDrawdown: 0 };
    }
    const trades = baseline.trades;
    const byDateMap = {};
    for (const t of trades) {
      const d = t.date;
      if (!d) continue;
      if (!byDateMap[d]) byDateMap[d] = { date: d, trades: 0, wins: 0, losses: 0, pnl: 0 };
      byDateMap[d].trades += 1;
      const pnl = t.pnl ?? 0;
      if (pnl > 0) byDateMap[d].wins += 1;
      else byDateMap[d].losses += 1;
      byDateMap[d].pnl += pnl;
    }
    const byDate = Object.values(byDateMap).sort((a, b) => a.date.localeCompare(b.date));
    let cum = 0;
    const points = byDate.map((row) => {
      cum += row.pnl;
      return { date: row.date, pnl: row.pnl, cumulativePnl: cum };
    });
    const dailyReturns = points.map((p) => p.pnl / CAPITAL_PER_DAY);
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
    return { byDate, equityPoints: points, sharpe, maxDrawdown };
  }, [baseline]);

  if (loading) return <div className="page"><p>Loading baseline…</p></div>;
  if (error) return <div className="page"><div className="error">{error}</div></div>;
  if (!baseline) return null;

  const byMonth = baseline.byMonth || [];
  const trades = baseline.trades || [];

  function tradesForMonth(month) {
    return trades.filter((t) => (t.date || '').slice(0, 7) === month);
  }

  return (
    <div className="page">
      <nav className="muted"><Link to="/">Dashboard</Link> / Baseline: {baseline.name || name}</nav>
      <h1>Baseline: {baseline.name || name}</h1>
      {baseline.savedAt && (
        <p className="muted">Saved at {new Date(baseline.savedAt).toLocaleString()}</p>
      )}
      <p><strong>Total PnL:</strong> ₹{baseline.totalPnl?.toFixed(2)} · <strong>Trades:</strong> {baseline.totalTrades}</p>

      {equityPoints.length > 0 && (
        <section className="card">
          <h2>Equity curve</h2>
          <p className="muted">
            Sharpe: {sharpe != null ? sharpe.toFixed(3) : 'n/a'} · Max drawdown: ₹{maxDrawdown?.toFixed(2)}
          </p>
          <EquityCurveChart points={equityPoints} />
        </section>
      )}

      <section className="card">
        <h2>Trades per day</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Trades</th>
              <th>Wins</th>
              <th>Losses</th>
              <th>PnL</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {byDate.map((row) => (
              <tr key={row.date}>
                <td>{row.date}</td>
                <td>{row.trades}</td>
                <td>{row.wins}</td>
                <td>{row.losses}</td>
                <td className={row.pnl >= 0 ? 'positive' : 'negative'}>
                  ₹{row.pnl?.toFixed(2)}
                </td>
                <td>
                  <button type="button" onClick={() => navigate(`/day/${row.date}`)}>
                    View day
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>By month</h2>
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
            {byMonth.map((row) => {
              const month = row.month;
              const monthTrades = tradesForMonth(month);
              const isExpanded = expandedMonth === month;
              return (
                <tr key={month}>
                  <td>{month}</td>
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
                      onClick={() => setExpandedMonth(isExpanded ? null : month)}
                    >
                      {isExpanded ? 'Hide trades' : 'View trades'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {expandedMonth && (
          <div style={{ marginTop: '1rem', overflowX: 'auto' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Trades for {expandedMonth}</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Symbol</th>
                  <th>Time</th>
                  <th>Entry</th>
                  <th>Stop</th>
                  <th>Exit</th>
                  <th>Reason</th>
                  <th>PnL</th>
                </tr>
              </thead>
              <tbody>
                {tradesForMonth(expandedMonth).map((t, i) => (
                  <tr key={`${t.date}-${t.symbol}-${i}`}>
                    <td>{t.date}</td>
                    <td>{t.symbol}</td>
                    <td>{(t.time || '').slice(0, 5)}</td>
                    <td>{t.entry?.toFixed(2)}</td>
                    <td>{t.stop?.toFixed(2)}</td>
                    <td>{t.exitPrice?.toFixed(2)}</td>
                    <td>{t.exitReason || '—'}</td>
                    <td className={(t.pnl || 0) >= 0 ? 'positive' : 'negative'}>
                      ₹{(t.pnl || 0).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
