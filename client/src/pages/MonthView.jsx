import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import * as api from '../api';
import EquityCurveChart from '../components/EquityCurveChart';

export default function MonthView() {
  const { month } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [equity, setEquity] = useState(null);
  const [error, setError] = useState('');
  const [cachedResult, setCachedResult] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!month) return;
    setError('');
    setData(null);
    setEquity(null);
    setCachedResult(null);
    setLoading(true);
    api
      .getBacktestMonth(month)
      .then((cached) => {
        if (cached) {
          setCachedResult(cached);
        }
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [month]);

  async function handleViewCached() {
    if (!cachedResult || !month) return;
    setData(cachedResult);
    try {
      const eq = await api.getEquityCurve(month);
      setEquity(eq);
    } catch {
      setEquity(null);
    }
  }

  if (error) return <div className="page"><div className="error">{error}</div></div>;

  if (loading && !data && !cachedResult) {
    return (
      <div className="page">
        <p>Checking for existing backtest…</p>
      </div>
    );
  }

  if (!data && cachedResult) {
    return (
      <div className="page">
        <nav className="muted"><Link to="/">Dashboard</Link> / {month}</nav>
        <h1>Month: {month}</h1>
        <p>Backtest results for this month are available (from last baseline run).</p>
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
          <button onClick={handleViewCached}>View results</button>
        </div>
      </div>
    );
  }

  if (!loading && !cachedResult && !data) {
    return (
      <div className="page">
        <nav className="muted"><Link to="/">Dashboard</Link> / {month}</nav>
        <h1>Month: {month}</h1>
        <p className="muted">No backtest data for this month. Run &quot;Run all &amp; save baseline&quot; on the dashboard to generate results.</p>
        <p><Link to="/">Back to dashboard</Link></p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <nav className="muted"><Link to="/">Dashboard</Link> / {month}</nav>
      <h1>Month: {month}</h1>
      <p><strong>Total PnL:</strong> ₹{data.totalPnl?.toFixed(2)}</p>

      {equity && (
        <section className="card">
          <h2>Equity curve</h2>
          <p className="muted">
            Sharpe: {equity.sharpe != null ? equity.sharpe.toFixed(3) : 'n/a'} · Max drawdown: ₹{equity.maxDrawdown?.toFixed(2)}
            {typeof equity.returnPct === 'number' && ` · Return: ${equity.returnPct.toFixed(2)}%`}
          </p>
          <EquityCurveChart points={equity.points || []} />
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
            {(data.byDate || []).map((row) => (
              <tr key={row.date}>
                <td>{row.date}</td>
                <td>{row.trades}</td>
                <td>{row.wins}</td>
                <td>{row.losses}</td>
                <td className={row.pnl >= 0 ? 'positive' : 'negative'}>
                  ₹{row.pnl?.toFixed(2)}
                </td>
                <td>
                  <button onClick={() => navigate(`/day/${row.date}`)}>View day</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
