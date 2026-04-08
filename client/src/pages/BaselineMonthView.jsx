import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../api';

export default function BaselineMonthView() {
  const { name, month } = useParams();
  const navigate = useNavigate();
  const [baseline, setBaseline] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

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

  const byDate = useMemo(() => {
    if (!baseline?.trades?.length || !month) return [];
    const byDateMap = {};
    for (const t of baseline.trades) {
      const d = t.date;
      if (!d || d.slice(0, 7) !== month) continue;
      if (!byDateMap[d]) byDateMap[d] = { date: d, trades: 0, wins: 0, losses: 0, pnl: 0 };
      byDateMap[d].trades += 1;
      const pnl = t.pnl ?? 0;
      if (pnl > 0) byDateMap[d].wins += 1;
      else byDateMap[d].losses += 1;
      byDateMap[d].pnl += pnl;
    }
    return Object.values(byDateMap).sort((a, b) => a.date.localeCompare(b.date));
  }, [baseline, month]);

  if (loading) return <div className="page"><p>Loading…</p></div>;
  if (error) return <div className="page"><div className="error">{error}</div></div>;
  if (!baseline) return null;

  return (
    <div className="page">
      <nav className="muted">
        <Link to="/">Dashboard</Link> / <Link to={`/baseline/${encodeURIComponent(name)}`}>{name}</Link> / {month}
      </nav>
      <h1>Trades by day — {month}</h1>
      <p className="muted">Baseline: {baseline.name || name}</p>

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
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/day/${row.date}?baseline=${encodeURIComponent(name)}`, {
                        state: { fromBaseline: name },
                      })
                    }
                  >
                    View day
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {byDate.length === 0 && <p className="muted">No trades for this month in this baseline.</p>}
      </section>
    </div>
  );
}
