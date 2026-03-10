import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../api';
import ChartModal from '../components/ChartModal';

export default function DayDetail() {
  const { date } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [chartFor, setChartFor] = useState(null); // { date, symbol }

  useEffect(() => {
    if (!date) return;
    setError('');
    api.getTrades(date).then(setData).catch((e) => setError(e.message));
  }, [date]);

  if (error) return <div className="page"><div className="error">{error}</div></div>;
  if (!data) return <div className="page"><p>Loading…</p></div>;

  const month = date.slice(0, 7);

  return (
    <div className="page">
      <nav className="muted">
        <Link to="/">Dashboard</Link> / <Link to={`/month/${month}`}>{month}</Link> / {date}
      </nav>
      <h1>Day: {date}</h1>
      <p><strong>Total PnL:</strong> ₹{data.totalPnl?.toFixed(2)} · Trades: {data.trades} (W: {data.wins} L: {data.losses})</p>

      <section className="card">
        <h2>Trades</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Time</th>
              <th>Entry</th>
              <th>Stop</th>
              <th>Exit</th>
              <th>Reason</th>
              <th>PnL</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(data.results || []).map((r, i) => (
              <tr key={i}>
                <td>{r.symbol}</td>
                <td>{r.time}</td>
                <td>{r.entry?.toFixed(2)}</td>
                <td>{r.stop?.toFixed(2)}</td>
                <td>{r.exitPrice?.toFixed(2)}</td>
                <td>{r.exitReason}</td>
                <td className={r.pnl >= 0 ? 'positive' : 'negative'}>₹{r.pnl?.toFixed(2)}</td>
                <td>
                  <button onClick={() => setChartFor({ date, symbol: r.symbol })}>Chart</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {chartFor && (
        <ChartModal
          date={chartFor.date}
          symbol={chartFor.symbol}
          onClose={() => setChartFor(null)}
        />
      )}
    </div>
  );
}
