import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../api';

const DEFAULT_TIERS = [75000, 60000, 50000, 45000, 40000, 30000];

// Default baseline config (match v2/entryLogic.js and v2/scripts/runBacktest.js)
const BASELINE_CONFIG_DEFAULTS = {
  dayVolMult: 2.7,
  breakoutVolMult: 1.1,
  gapUpMaxPct: 3,
  moveUpMinPct: 4,
  pullbackPct: 1,
  pullbackMaxFromTopPct: 4,
  wickMaxPct: 0.35,
  consolidationRangePct: 2,
  maxEntryTime: '12:30',
  fixedSlPct: 1,
  maxDayMovePct: 14,
  breakoutStrengthMinPct: 0.4,
  firstTargetPct: 3,
  trailPct: 1.5,
  /** ₹ per trade; total day capital = 6 × this; up to 6 concurrent slots */
  capitalPerTrade: 50000,
};

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
  const [showBaselineConfigModal, setShowBaselineConfigModal] = useState(false);
  const [baselineConfig, setBaselineConfig] = useState(() => ({ ...BASELINE_CONFIG_DEFAULTS }));
  const [tieredMode, setTieredMode] = useState(false);
  const [tierAmounts, setTierAmounts] = useState([...DEFAULT_TIERS]);
  /** Optional inclusive YYYY-MM-DD filter for baseline run (only dates that already have v2 data). */
  const [baselineDateFrom, setBaselineDateFrom] = useState('');
  const [baselineDateTo, setBaselineDateTo] = useState('');

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

  const openBaselineConfigModal = () => {
    setBaselineConfig({ ...BASELINE_CONFIG_DEFAULTS });
    setTieredMode(false);
    setTierAmounts([...DEFAULT_TIERS]);
    setShowBaselineConfigModal(true);
  };

  const handleRunAllSaveBaseline = (nameOverride, configOverride) => {
    const name = ((nameOverride ?? baselineName) || 'baseline').trim().replace(/[^a-zA-Z0-9_]/g, '_') || 'baseline';
    let config = configOverride ?? baselineConfig;
    if (!configOverride && tieredMode) {
      const { capitalPerTrade: _drop, ...rest } = config;
      config = { ...rest, tiers: tierAmounts };
    }
    setShowBaselineConfigModal(false);
    setBaselineLoading(true);
    setError('');
    setBaselineResult(null);
    const range = {};
    if (baselineDateFrom.trim()) range.dateFrom = baselineDateFrom.trim();
    if (baselineDateTo.trim()) range.dateTo = baselineDateTo.trim();
    api.runBacktestAllSaveBaseline(name, config, range).then((data) => {
      setBaselineResult(data);
      setBaselineLoading(false);
      api.getBaselines().then((d) => setBaselines(d.baselines || [])).catch(() => {});
    }).catch((e) => {
      setError(e.message);
      setBaselineLoading(false);
    });
  };

  const setConfigValue = (key, value) => {
    setBaselineConfig((prev) => ({ ...prev, [key]: value }));
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
      {loadStatus?.logLines?.length > 0 && (
        <details className="card" style={{ marginTop: '0.75rem' }} open={!!loadStatus?.running}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            Load month log{loadStatus.month ? ` (${loadStatus.month})` : ''}
            {loadStatus.finished && loadStatus.code != null && ` — exit ${loadStatus.code}`}
          </summary>
          <pre
            className="muted"
            style={{
              marginTop: '0.5rem',
              maxHeight: 220,
              overflow: 'auto',
              fontSize: '0.75rem',
              lineHeight: 1.35,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {loadStatus.logLines.slice(-80).join('\n')}
          </pre>
        </details>
      )}
      {loadDateStatus?.running && (
        <p className="muted">Fetching data for {loadDateStatus.date}… (logs below update every ~2s)</p>
      )}
      {loadDateStatus?.logLines?.length > 0 && (
        <details className="card" style={{ marginTop: '0.75rem' }} open={!!loadDateStatus?.running}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            Load one day log{loadDateStatus.date ? ` (${loadDateStatus.date})` : ''}
            {loadDateStatus.finished && loadDateStatus.code != null && ` — exit ${loadDateStatus.code}`}
          </summary>
          <pre
            className="muted"
            style={{
              marginTop: '0.5rem',
              maxHeight: 220,
              overflow: 'auto',
              fontSize: '0.75rem',
              lineHeight: 1.35,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {loadDateStatus.logLines.slice(-80).join('\n')}
          </pre>
        </details>
      )}

      <section className="card">
        <h2>Save baseline (all months)</h2>
        <p className="muted">
          Run backtest for dates that have v2 data (parallel workers). Optional date range below; open config for entry/exit overrides.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
          <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}>
            From (optional)
            <input
              type="date"
              value={baselineDateFrom}
              onChange={(e) => setBaselineDateFrom(e.target.value)}
              style={{ padding: '0.35rem 0.5rem' }}
            />
          </label>
          <label className="muted" style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}>
            To (optional)
            <input
              type="date"
              value={baselineDateTo}
              onChange={(e) => setBaselineDateTo(e.target.value)}
              style={{ padding: '0.35rem 0.5rem' }}
            />
          </label>
        </div>
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
            onClick={openBaselineConfigModal}
            disabled={baselineLoading || months.length === 0}
          >
            {baselineLoading ? 'Running backtest…' : 'Run all & save baseline'}
          </button>
        </div>
        {showBaselineConfigModal && (
          <div className="modal-overlay" onClick={() => setShowBaselineConfigModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
              <h3 style={{ marginTop: 0 }}>Baseline config</h3>
              <p className="muted" style={{ marginBottom: '0.5rem' }}>
                Date range uses the <strong>From / To</strong> fields on the card behind this dialog (only dates with loaded v2 data are included).
              </p>
              <p className="muted" style={{ marginBottom: '1rem' }}>Override values (optional). Saved baseline will use these.</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem 1rem', marginBottom: '1rem' }}>
                <label style={{ gridColumn: '1 / -1', fontWeight: 600 }}>Entry — volume</label>
                <label><span className="muted">Day vol ≥ </span><input type="number" step="0.1" min="0" value={baselineConfig.dayVolMult} onChange={(e) => setConfigValue('dayVolMult', parseFloat(e.target.value) || 0)} style={{ width: 56, marginLeft: 4 }} />× prev</label>
                <label><span className="muted">Bar vol ≥ </span><input type="number" step="0.1" min="0" value={baselineConfig.breakoutVolMult} onChange={(e) => setConfigValue('breakoutVolMult', parseFloat(e.target.value) || 0)} style={{ width: 56, marginLeft: 4 }} />× avg 5</label>
                <label style={{ gridColumn: '1 / -1', fontWeight: 600, marginTop: '0.5rem' }}>Entry — other</label>
                <label><span className="muted">Gap up max %</span><input type="number" step="0.5" value={baselineConfig.gapUpMaxPct} onChange={(e) => setConfigValue('gapUpMaxPct', parseFloat(e.target.value) ?? 0)} style={{ width: 56, marginLeft: 4 }} /></label>
                <label><span className="muted">Move up min %</span><input type="number" step="0.5" value={baselineConfig.moveUpMinPct} onChange={(e) => setConfigValue('moveUpMinPct', parseFloat(e.target.value) ?? 0)} style={{ width: 56, marginLeft: 4 }} /></label>
                <label><span className="muted">Pullback %</span><input type="number" step="0.1" value={baselineConfig.pullbackPct} onChange={(e) => setConfigValue('pullbackPct', parseFloat(e.target.value) ?? 0)} style={{ width: 56, marginLeft: 4 }} /></label>
                <label><span className="muted">Pullback max from top %</span><input type="number" step="0.5" value={baselineConfig.pullbackMaxFromTopPct} onChange={(e) => setConfigValue('pullbackMaxFromTopPct', parseFloat(e.target.value) ?? 0)} style={{ width: 56, marginLeft: 4 }} /></label>
                <label><span className="muted">Max entry time</span><input type="text" value={baselineConfig.maxEntryTime} onChange={(e) => setConfigValue('maxEntryTime', e.target.value)} style={{ width: 56, marginLeft: 4 }} /></label>
                <label><span className="muted">Fixed SL %</span><input type="number" step="0.1" value={baselineConfig.fixedSlPct} onChange={(e) => setConfigValue('fixedSlPct', parseFloat(e.target.value) ?? 0)} style={{ width: 56, marginLeft: 4 }} /></label>
                <label style={{ gridColumn: '1 / -1', fontWeight: 600, marginTop: '0.5rem' }}>Sizing</label>
                <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input type="checkbox" checked={tieredMode} onChange={(e) => setTieredMode(e.target.checked)} />
                  <span>Tiered sizing (different capital per trade sequence)</span>
                </label>
                {!tieredMode && (
                  <label style={{ gridColumn: '1 / -1' }}>
                    <span className="muted">Capital per trade (₹)</span>
                    <input type="number" step="1000" min="1000" value={baselineConfig.capitalPerTrade} onChange={(e) => setConfigValue('capitalPerTrade', Math.max(1000, parseFloat(e.target.value) || 50000))} style={{ width: 100, marginLeft: 4 }} />
                    <span className="muted" style={{ marginLeft: 8, fontSize: '0.85rem' }}>Default ₹50k · max 6 trades/day</span>
                  </label>
                )}
                {tieredMode && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <p className="muted" style={{ fontSize: '0.85rem', marginBottom: '0.4rem' }}>Capital per trade by sequence (1st trade of day → 6th). Later trades get less.</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                      {tierAmounts.map((amt, i) => (
                        <label key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem', fontSize: '0.85rem' }}>
                          <span className="muted">{['1st','2nd','3rd','4th','5th','6th'][i]}</span>
                          <input
                            type="number"
                            step="5000"
                            min="1000"
                            value={amt}
                            onChange={(e) => {
                              const next = [...tierAmounts];
                              next[i] = Math.max(1000, parseFloat(e.target.value) || 1000);
                              setTierAmounts(next);
                            }}
                            style={{ width: 80 }}
                          />
                        </label>
                      ))}
                    </div>
                    <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.4rem' }}>
                      Total if all 6 fire: ₹{tierAmounts.reduce((s, v) => s + v, 0).toLocaleString('en-IN')}
                    </p>
                  </div>
                )}
                <label style={{ gridColumn: '1 / -1', fontWeight: 600, marginTop: '0.5rem' }}>Exit</label>
                <label><span className="muted">First target %</span><input type="number" step="0.5" value={baselineConfig.firstTargetPct} onChange={(e) => setConfigValue('firstTargetPct', parseFloat(e.target.value) ?? 0)} style={{ width: 56, marginLeft: 4 }} /></label>
                <label><span className="muted">Trail %</span><input type="number" step="0.1" value={baselineConfig.trailPct} onChange={(e) => setConfigValue('trailPct', parseFloat(e.target.value) ?? 0)} style={{ width: 56, marginLeft: 4 }} /></label>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setShowBaselineConfigModal(false)}>Cancel</button>
                <button type="button" onClick={() => handleRunAllSaveBaseline((baselineName || 'baseline').trim().replace(/[^a-zA-Z0-9_]/g, '_') || 'baseline')}>Run & save baseline</button>
              </div>
            </div>
          </div>
        )}
        {baselineResult && (
          <div style={{ marginTop: '0.75rem', padding: '0.5rem', background: '#f0f8f0', borderRadius: 4 }}>
            <strong>Saved:</strong> {baselineResult.name} — ₹{baselineResult.totalPnl?.toFixed(2)} ({baselineResult.totalTrades} trades, {baselineResult.datesRun} dates)
            {baselineResult.dateRange && (baselineResult.dateRange.from || baselineResult.dateRange.to) && (
              <span className="muted" style={{ display: 'block', marginTop: '0.25rem' }}>
                Range: {baselineResult.dateRange.from || '…'} → {baselineResult.dateRange.to || '…'}
              </span>
            )}
          </div>
        )}
        {baselines.length > 0 && (
          <div style={{ marginTop: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.35rem' }}>
              <h3 style={{ fontSize: '1rem', margin: 0 }}>Saved baselines</h3>
              {baselines.length >= 2 && (
                <Link to="/compare" style={{ fontSize: '0.85rem', fontWeight: 500 }}>
                  Compare baselines →
                </Link>
              )}
            </div>
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
