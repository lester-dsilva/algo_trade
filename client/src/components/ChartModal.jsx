import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  createSeriesMarkers,
} from 'lightweight-charts';
import * as api from '../api';

// IST: treat bar date+time as UTC for axis so chart shows 09:15, 09:18 (IST labels)
function parseTime3m(bar) {
  const str = `${bar.date}T${(bar.time || '').slice(0, 5)}:00Z`;
  return Math.floor(new Date(str).getTime() / 1000);
}

// Daily: business day for lightweight-charts
function toBusinessDay(dateStr) {
  const [y, m, d] = (dateStr || '').split('-').map(Number);
  return { year: y, month: m, day: d };
}

const DEFAULT_MOVE_WINDOW_BARS = 11;
// Match v2/entryLogic.js for volume condition text (defaults; API may send entryParams)
const DEFAULT_DAY_VOL_MULT = 2.7;
const DEFAULT_DAY_VOL_RAMP = true;
const DEFAULT_MAX_ENTRY_TIME = '12:30';
const BREAKOUT_VOL_MULT = 1.1;
const VOL_AVG_LOOKBACK = 5;

export default function ChartModal({ date, symbol, baselineName, onClose }) {
  const [searchParams] = useSearchParams();
  /** URL ?baseline= wins when navigation state dropped; prop wins when set (e.g. Compare). */
  const baselineForApi = baselineName ?? searchParams.get('baseline') ?? undefined;

  const [mode, setMode] = useState('3m');
  const [data, setData] = useState(null);
  const [dailyData, setDailyData] = useState(null);
  const [error, setError] = useState('');
  const [clickedBarReason, setClickedBarReason] = useState(null);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);

  useEffect(() => {
    if (!date || !symbol) return;
    setError('');
    setDailyData(null);
    setClickedBarReason(null);
    api.getChart3m(date, symbol, baselineForApi).then(setData).catch((e) => setError(e.message));
  }, [date, symbol, baselineForApi]);

  useEffect(() => {
    if (mode !== 'daily' || !symbol) return;
    setError('');
    api.getChartDaily(symbol, 20).then(setDailyData).catch((e) => setError(e.message));
  }, [mode, symbol]);

  useEffect(() => {
    const is3m = mode === '3m';
    const bars = is3m ? data?.bars : dailyData?.bars;
    if (!bars?.length || !chartRef.current) return;

    const container = chartRef.current;
    if (chartInstance.current) {
      chartInstance.current.remove();
      chartInstance.current = null;
    }

    const chart = createChart(container, {
      width: container.clientWidth,
      height: 420,
      layout: { background: { type: 'solid', color: '#fff' }, textColor: '#333' },
      grid: { vertLines: { color: '#eee' }, horzLines: { color: '#eee' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#ccc' },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
    });

    if (is3m) {
      setClickedBarReason(null);
      candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.4 } });
      const chartBars = data.bars.map((b, idx) => ({
        time: parseTime3m(b),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        index: idx,
      }));
      candleSeries.setData(chartBars);

      const failedBarsMap = new Map();
      (data.failedBars || []).forEach((fb) => {
        const t = (fb.time || '').slice(0, 5);
        if (t) failedBarsMap.set(t, fb.reason);
      });

      const moveWindowBars = Math.max(
        VOL_AVG_LOOKBACK,
        data.entryParams?.moveWindowBars ?? DEFAULT_MOVE_WINDOW_BARS,
      );
      const firstEntryBarTime = (data.bars[moveWindowBars]?.time || '').slice(0, 5);

      chart.subscribeClick((param) => {
        if (param.time == null || param.seriesData?.size === 0) return;
        const i = chartBars.findIndex((b) => b.time === param.time);
        if (i < 0) return;
        const barTimeStr = (data.bars[i]?.time || '').slice(0, 5);
        const bar = data.bars[i];
        let message;
        if (i === data.entry?.barIndex) {
          message = 'Entry bar';
        } else if (i < moveWindowBars) {
          message = `Before entry window (first entry bar index ${moveWindowBars}${firstEntryBarTime ? `, ~${firstEntryBarTime}` : ''})`;
        } else {
          const reason = failedBarsMap.get(barTimeStr);
          message = reason ? `Why no entry: ${reason}` : 'No skip reason for this bar';
        }
        // Volume conditions (match entryLogic: ramp to dayVolMult× by maxEntryTime, bar vol >= 1.1x avg(prev 5))
        let volumeConditions = null;
        const prevVol = data.prevDay?.volume ?? 0;
        const ep = data.entryParams || {};
        const dayVolMult = ep.dayVolMult ?? DEFAULT_DAY_VOL_MULT;
        const dayVolRamp = ep.dayVolRamp !== undefined ? ep.dayVolRamp : DEFAULT_DAY_VOL_RAMP;
        const maxT = (ep.maxEntryTime || DEFAULT_MAX_ENTRY_TIME).slice(0, 5);
        const totalBarsToMaxEntry = Math.max(
          1,
          ep.totalBarsToMaxEntry ??
            data.bars.filter((b) => (b.time || '').slice(0, 5) <= maxT).length,
        );
        if (prevVol >= 0 && bar?.volume != null) {
          const cumVol = data.bars.slice(0, i + 1).reduce((s, b) => s + (b.volume || 0), 0);
          const requiredMult =
            dayVolRamp !== false
              ? dayVolMult * Math.min(1, (i + 1) / totalBarsToMaxEntry)
              : dayVolMult;
          const dayVolRequired = prevVol > 0 ? requiredMult * prevVol : 0;
          const dayVolMet = prevVol > 0 ? cumVol >= dayVolRequired : true;
          volumeConditions = {
            dayVol: cumVol,
            dayVolRequired,
            prevVol,
            dayVolMet,
            dayVolMult,
            dayVolRamp,
            requiredMult,
            maxEntryTime: ep.maxEntryTime || DEFAULT_MAX_ENTRY_TIME,
          };
          if (i >= VOL_AVG_LOOKBACK) {
            const recent5 = data.bars.slice(i - VOL_AVG_LOOKBACK, i);
            const avg5 = recent5.reduce((s, b) => s + (b.volume || 0), 0) / VOL_AVG_LOOKBACK;
            const barVolRequired = BREAKOUT_VOL_MULT * avg5;
            const barVolMet = avg5 > 0 ? (bar.volume || 0) >= barVolRequired : true;
            volumeConditions.barVol = bar.volume || 0;
            volumeConditions.avg5 = avg5;
            volumeConditions.barVolRequired = barVolRequired;
            volumeConditions.barVolMet = barVolMet;
          }
        }
        setClickedBarReason({ barTime: barTimeStr, message, volumeConditions });
      });

      if (data.entry?.price != null) {
        const line = chart.addSeries(LineSeries, { color: '#2196f3', lineWidth: 2 });
        line.setData(chartBars.map((b) => ({ time: b.time, value: data.entry.price })));
      }
      if (data.stop != null) {
        const line = chart.addSeries(LineSeries, { color: '#f44336', lineWidth: 1 });
        line.setData(chartBars.map((b) => ({ time: b.time, value: data.stop })));
      }
      if (data.exit?.price != null) {
        const line = chart.addSeries(LineSeries, { color: '#4caf50', lineWidth: 1 });
        line.setData(chartBars.map((b) => ({ time: b.time, value: data.exit.price })));
      }

      const markers = [];
      if (data.entry?.barIndex != null) {
        const b = chartBars[data.entry.barIndex];
        if (b) {
          markers.push({
            time: b.time,
            position: 'belowBar',
            color: '#2196f3',
            shape: 'arrowUp',
            text: 'Entry',
          });
        }
      }
      if (data.exit?.barIndex != null) {
        const b = chartBars[data.exit.barIndex];
        if (b) {
          markers.push({
            time: b.time,
            position: 'aboveBar',
            color: '#4caf50',
            shape: 'arrowDown',
            text: 'Exit',
          });
        }
      }
      if (markers.length) createSeriesMarkers(candleSeries, markers);

      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        scaleMargins: { top: 0.7, bottom: 0 },
      });
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.7, bottom: 0 } });
      const volData = data.bars.map((b) => ({
        time: parseTime3m(b),
        value: b.volume ?? 0,
        color: b.close >= b.open ? '#26a69a' : '#ef5350',
      }));
      volumeSeries.setData(volData);
    } else {
      const chartBars = dailyData.bars.map((b) => ({
        time: toBusinessDay(b.date),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }));
      candleSeries.setData(chartBars);

      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        scaleMargins: { top: 0.7, bottom: 0 },
      });
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.7, bottom: 0 } });
      const volData = dailyData.bars.map((b) => ({
        time: toBusinessDay(b.date),
        value: b.volume ?? 0,
        color: b.close >= b.open ? '#26a69a' : '#ef5350',
      }));
      volumeSeries.setData(volData);
    }

    chart.timeScale().fitContent();
    chartInstance.current = chart;
    const onResize = () => chart.applyOptions({ width: container.clientWidth });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartInstance.current = null;
    };
  }, [data, dailyData, mode]);

  const showChart = (mode === '3m' && data?.bars?.length) || (mode === 'daily' && dailyData?.bars?.length);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            {mode === '3m' ? `3m — ${symbol} (${date})` : `Daily — ${symbol} (last 20 days)`}
          </h2>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              type="button"
              className={mode === '3m' ? 'active' : ''}
              onClick={() => { setMode('3m'); setClickedBarReason(null); }}
            >
              3m
            </button>
            <button
              type="button"
              className={mode === 'daily' ? 'active' : ''}
              onClick={() => { setMode('daily'); setClickedBarReason(null); }}
            >
              Daily
            </button>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        {mode === '3m' && !data && !error && <p>Loading 3m…</p>}
        {mode === 'daily' && !dailyData && !error && <p>Loading daily…</p>}
        {mode === '3m' && data && (
          <p className="muted">
            Entry: {data.entry?.price?.toFixed(2)} · Stop: {data.stop?.toFixed(2)} · Exit: {data.exit?.price?.toFixed(2)} ({data.exit?.reason}) · Axis: IST
            {data.baseline ? ` · Chart config: baseline “${data.baseline}”` : ''}
            {baselineForApi && !data.baseline && (
              <span style={{ color: '#c62828' }}>
                {' '}
                — Baseline “{baselineForApi}” was not applied by the API. Restart the dashboard Node process (port 4000)
                so it runs the current code; otherwise the chart recomputes entry and will not match the table.
              </span>
            )}
          </p>
        )}
        {mode === '3m' && clickedBarReason && (
          <div style={{ marginTop: '0.25rem', marginBottom: 0, padding: '0.35rem 0.5rem', background: '#f5f5f5', borderRadius: 4 }}>
            <p style={{ margin: 0 }}>Bar {clickedBarReason.barTime} — {clickedBarReason.message}</p>
            {clickedBarReason.volumeConditions && (
              <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem' }}>
                <strong>Volume conditions:</strong>{' '}
                Day vol: {clickedBarReason.volumeConditions.dayVol?.toLocaleString()} / {clickedBarReason.volumeConditions.dayVolRequired?.toLocaleString()} (≥{clickedBarReason.volumeConditions.requiredMult?.toFixed(2)}× prev {clickedBarReason.volumeConditions.prevVol?.toLocaleString()}{clickedBarReason.volumeConditions.dayVolRamp !== false ? `, ramp to ${clickedBarReason.volumeConditions.dayVolMult}× by ${clickedBarReason.volumeConditions.maxEntryTime}` : ''}) — {clickedBarReason.volumeConditions.dayVolMet ? 'Met' : 'Not met'}
                {clickedBarReason.volumeConditions.barVol != null && (
                  <> · Bar vol: {clickedBarReason.volumeConditions.barVol?.toLocaleString()} / {clickedBarReason.volumeConditions.barVolRequired?.toFixed(0)} (≥{BREAKOUT_VOL_MULT}× avg 5) — {clickedBarReason.volumeConditions.barVolMet ? 'Met' : 'Not met'}</>
                )}
              </p>
            )}
          </div>
        )}
        {showChart && (
          <div ref={chartRef} style={{ width: '100%', minHeight: 420 }} />
        )}
      </div>
    </div>
  );
}
