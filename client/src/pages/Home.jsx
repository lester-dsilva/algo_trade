import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';

export default function Home() {
  const [months, setMonths] = useState([]);
  const [selectedMonth, setSelectedMonth] = useState('');
  const [dataStatus, setDataStatus] = useState(null);
  const [loadStatus, setLoadStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadMonthLoading, setLoadMonthLoading] = useState(false);
  const [loadDateStatus, setLoadDateStatus] = useState(null);
  const [loadingDate, setLoadingDate] = useState(null);
  const [error, setError] = useState('');
  const [baselineName, setBaselineName] = useState('');
  const [baselineLoading, setBaselineLoading] = useState(false);
  const [baselineResult, setBaselineResult] = useState(null);
  const [baselines, setBaselines] = useState([]);
  const [customMonth, setCustomMonth] = useState('');

  useEffect(() => {
    api.getMonths().then((d) => {
      setMonths(d.months || []);
      if (d.months?.length && !selectedMonth) setSelectedMonth(d.months[0]);
    }).catch((e) => setError(e.message));
    api.getBaselines().then((d) => setBaselines(d.baselines || [])).catch(() => {});
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

  const handleRunAllSaveBaseline = () => {
    const name = (baselineName || 'baseline').trim().replace(/[^a-zA-Z0-9_]/g, '_') || 'baseline';
    setBaselineLoading(true);
    setError('');
    setBaselineResult(null);
    api.runBacktestAllSaveBaseline(name).then((data) => {
      setBaselineResult(data);
      setBaselineLoading(false);
      api.getBaselines().then((d) => setBaselines(d.baselines || [])).catch(() => {});
    }).catch((e) => {
      setError(e.message);
      setBaselineLoading(false);
    });
  };

  return (
    <div className="page">
      <h1>Backtest Dashboard</h1>
      {error && <div className="error">{error}</div>}

      <section className="card">
        <h2>Month</h2>
        <p className="muted" style={{ marginBottom: '0.5rem' }}>
          Select any month to view status or load data. You can also type a month below.
        </p>
        <select
          value={selectedMonth}
          onChange={(e) => {
            setSelectedMonth(e.target.value);
            if (e.target.value) setError('');
          }}
        >
          <option value="">Select month</option>
          {months.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem' }}>
          <label htmlFor="custom-month" className="muted" style={{ fontSize: '0.9rem' }}>
            Or specify month:
          </label>
          <input
            id="custom-month"
            type="month"
            value={customMonth}
            onChange={(e) => setCustomMonth(e.target.value)}
            style={{ padding: '0.35rem 0.5rem' }}
          />
          <button
            type="button"
            disabled={!customMonth || loadMonthLoading || loadStatus?.running}
            onClick={() => {
              if (!customMonth) return;
              const month = customMonth; // YYYY-MM from input type="month"
              setSelectedMonth(month);
              if (!months.includes(month)) {
                setMonths((prev) => [...prev, month].sort().reverse());
              }
              setCustomMonth('');
              api.getDataStatus(month).then(setDataStatus).catch((e) => setError(e.message));
            }}
          >
            Go
          </button>
        </div>
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
      </section>

      {loadStatus?.running && (
        <p className="muted">Fetching data for {loadStatus.month}… (refresh status automatically)</p>
      )}
      {loadDateStatus?.running && (
        <p className="muted">Fetching data for {loadDateStatus.date}…</p>
      )}

      <section className="card">
        <h2>Save baseline (all months)</h2>
        <p className="muted">Run backtest for all available dates in parallel and save a named baseline.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
          <input
            type="text"
            placeholder="Baseline name (e.g. v1_entry_logic)"
            value={baselineName}
            onChange={(e) => setBaselineName(e.target.value)}
            style={{ padding: '0.35rem 0.5rem', minWidth: '180px' }}
          />
          <button
            type="button"
            onClick={handleRunAllSaveBaseline}
            disabled={baselineLoading || months.length === 0}
          >
            {baselineLoading ? 'Running backtest…' : 'Run all & save baseline'}
          </button>
        </div>
        {baselineResult && (
          <div style={{ marginTop: '0.75rem', padding: '0.5rem', background: '#f0f8f0', borderRadius: 4 }}>
            <strong>Saved:</strong> {baselineResult.name} — ₹{baselineResult.totalPnl?.toFixed(2)} ({baselineResult.totalTrades} trades, {baselineResult.datesRun} dates)
          </div>
        )}
        {baselines.length > 0 && (
          <div style={{ marginTop: '0.75rem' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '0.35rem' }}>Saved baselines</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.9rem' }}>
              {baselines.map((b) => (
                <li key={b.name} style={{ padding: '0.2rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Link to={`/baseline/${encodeURIComponent(b.name)}`} style={{ fontWeight: 500 }}>
                    {b.name}
                  </Link>
                  <span className="muted">
                    {b.savedAt != null && ` — ${new Date(b.savedAt).toLocaleString()}`}
                    {b.totalPnl != null && ` — ₹${b.totalPnl.toFixed(2)} (${b.totalTrades} trades)`}
                  </span>
                  <button
                    type="button"
                    className="danger"
                    style={{ marginLeft: 'auto', fontSize: '0.8rem', padding: '0.15rem 0.4rem' }}
                    onClick={() => {
                      if (!window.confirm(`Delete baseline "${b.name}"?`)) return;
                      api.deleteBaseline(b.name).then(() => {
                        api.getBaselines().then((d) => setBaselines(d.baselines || [])).catch(() => {});
                      }).catch((e) => setError(e.message));
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
