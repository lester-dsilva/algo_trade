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

  useEffect(() => {
    if (!month) return;
    setError('');
    api.getBacktestMonth(month).then((cached) => {
      if (cached) {
        setData(cached);
        return;
      }
      return api.backtestMonth(month).then((result) => {
        setData(result);
        api.getEquityCurve(month).then(setEquity).catch(() => setEquity(null));
      });
    }).catch((e) => setError(e.message));
    api.getEquityCurve(month).then(setEquity).catch(() => setEquity(null));
  }, [month]);

  if (error) return <div className="page"><div className="error">{error}</div></div>;
  if (!data) return <div className="page"><p>Loading…</p></div>;

  return (
    <div className="page">
      <nav className="muted"><Link to="/">Dashboard</Link> / {month}</nav>
      <h1>Month: {month}</h1>
      <p><strong>Total PnL:</strong> ₹{data.totalPnl?.toFixed(2)}</p>

      {equity && (
        <section className="card">
          <h2>Equity curve</h2>
          <p className="muted">Sharpe: {equity.sharpe != null ? equity.sharpe.toFixed(3) : 'n/a'} · Max drawdown: ₹{equity.maxDrawdown?.toFixed(2)}</p>
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
