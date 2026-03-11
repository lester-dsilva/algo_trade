import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api';

export default function Home() {
  const navigate = useNavigate();
  const [months, setMonths] = useState([]);
  const [selectedMonth, setSelectedMonth] = useState('');
  const [dataStatus, setDataStatus] = useState(null);
  const [loadStatus, setLoadStatus] = useState(null);
  const [backtestResult, setBacktestResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadMonthLoading, setLoadMonthLoading] = useState(false);
  const [loadDateStatus, setLoadDateStatus] = useState(null);
  const [loadingDate, setLoadingDate] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getMonths().then((d) => {
      setMonths(d.months || []);
      if (d.months?.length && !selectedMonth) setSelectedMonth(d.months[0]);
    }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selectedMonth) return;
    setError('');
    api.getDataStatus(selectedMonth).then(setDataStatus).catch((e) => setError(e.message));
  }, [selectedMonth]);

  // Only poll load-month status while the server says a job is running
  useEffect(() => {
    if (!loadStatus?.running) return;
    const t = setInterval(() => {
      api.getLoadMonthStatus().then((s) => {
        setLoadStatus(s);
        if (!s.running) {
          api.getDataStatus(selectedMonth).then(setDataStatus).catch(() => {});
          api.getMonths().then((d) => setMonths(d.months || []));
        }
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [loadStatus?.running, selectedMonth]);

  // Poll load-date status when a single-date load is running
  useEffect(() => {
    if (!loadDateStatus?.running) return;
    const t = setInterval(() => {
      api.getLoadDateStatus().then((s) => {
        setLoadDateStatus(s);
        if (!s.running) {
          setLoadingDate(null);
          if (selectedMonth) api.getDataStatus(selectedMonth).then(setDataStatus).catch(() => {});
          api.getMonths().then((d) => setMonths(d.months || []));
        }
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [loadDateStatus?.running, selectedMonth]);

  const handleLoadMonth = () => {
    if (!selectedMonth) return;
    setLoadMonthLoading(true);
    setError('');
    api.loadMonth(selectedMonth).then(() => {
      setLoadMonthLoading(false);
      // One fetch to get running: true so the polling effect starts
      api.getLoadMonthStatus().then(setLoadStatus).catch(() => {});
    }).catch((e) => {
      setError(e.message);
      setLoadMonthLoading(false);
    });
  };

  const handleLoadDate = (date) => {
    setError('');
    setLoadingDate(date);
    api.loadDate(date).then(() => {
      api.getLoadDateStatus().then(setLoadDateStatus).catch(() => {});
    }).catch((e) => {
      setError(e.message);
      setLoadingDate(null);
    });
  };

  const handleRunBacktest = () => {
    if (!selectedMonth) return;
    setLoading(true);
    setError('');
    api.backtestMonth(selectedMonth).then((data) => {
      setBacktestResult(data);
      setLoading(false);
    }).catch((e) => {
      setError(e.message);
      setLoading(false);
    });
  };

  return (
    <div className="page">
      <h1>Backtest Dashboard</h1>
      {error && <div className="error">{error}</div>}

      <section className="card">
        <h2>Month</h2>
        <select
          value={selectedMonth}
          onChange={(e) => {
            const month = e.target.value;
            setSelectedMonth(month);
            setBacktestResult(null);
            if (month) {
              api.getBacktestMonth(month).then((cached) => {
                if (cached) navigate(`/month/${month}`);
              }).catch(() => {});
            }
          }}
        >
          <option value="">Select month</option>
          {months.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        {dataStatus && (
          <>
            <p className="muted">
              Data: {dataStatus.withData} / {dataStatus.total} weekdays
            </p>
            {dataStatus.status?.some((s) => !s.hasData) && (
              <div className="missing-days" style={{ marginTop: '0.75rem' }}>
                <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Missing weekdays</h3>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {dataStatus.status
                    .filter((s) => !s.hasData)
                    .map((s) => (
                      <li
                        key={s.date}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.25rem 0.5rem',
                          background: s.isHoliday ? '#f0f0f0' : '#fff8e6',
                          borderRadius: 4,
                          fontSize: '0.9rem',
                        }}
                      >
                        <span>{s.date}</span>
                        {s.isHoliday ? (
                          <span className="muted">Market holiday</span>
                        ) : (
                          <button
                            type="button"
                            disabled={loadDateStatus?.running || loadMonthLoading || loadStatus?.running}
                            onClick={() => handleLoadDate(s.date)}
                          >
                            {loadingDate === s.date ? 'Loading…' : 'Load'}
                          </button>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card actions">
        <button
          onClick={handleLoadMonth}
          disabled={!selectedMonth || loadMonthLoading || (loadStatus?.running)}
        >
          {loadMonthLoading || loadStatus?.running ? 'Loading…' : 'Load data'}
        </button>
        <button
          onClick={handleRunBacktest}
          disabled={!selectedMonth || loading}
        >
          {loading ? 'Running…' : 'Run backtest'}
        </button>
      </section>

      {loadStatus?.running && (
        <p className="muted">Fetching data for {loadStatus.month}… (refresh status automatically)</p>
      )}
      {loadDateStatus?.running && (
        <p className="muted">Fetching data for {loadDateStatus.date}…</p>
      )}

      {backtestResult && (
        <section className="card">
          <h2>Backtest summary — {backtestResult.month}</h2>
          <p><strong>Total PnL:</strong> ₹{backtestResult.totalPnl?.toFixed(2)}</p>
          <button onClick={() => navigate(`/month/${backtestResult.month}`)}>
            View trades per day & equity curve
          </button>
        </section>
      )}
    </div>
  );
}
