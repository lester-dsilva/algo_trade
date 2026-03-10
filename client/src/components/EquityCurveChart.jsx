import { useEffect, useRef, useState } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';

function formatChartTime(t) {
  if (!t) return '—';
  if (typeof t === 'string') return t;
  const y = t.year ?? t.y;
  const m = t.month ?? t.m;
  const d = t.day ?? t.d;
  if (y == null || m == null || d == null) return String(t);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export default function EquityCurveChart({ points }) {
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const seriesRef = useRef(null);
  const [measureMode, setMeasureMode] = useState(false);
  const [pointA, setPointA] = useState(null);
  const [pointB, setPointB] = useState(null);

  useEffect(() => {
    if (!points?.length || !chartRef.current) return;
    const container = chartRef.current;
    if (chartInstance.current) {
      chartInstance.current.remove();
      chartInstance.current = null;
      seriesRef.current = null;
    }
    const chart = createChart(container, {
      width: container.clientWidth,
      height: 280,
      layout: { background: { type: 'solid', color: '#fff' }, textColor: '#333' },
      grid: { vertLines: { color: '#eee' }, horzLines: { color: '#eee' } },
      timeScale: { timeVisible: true },
      rightPriceScale: { borderColor: '#ccc' },
    });
    const areaSeries = chart.addSeries(AreaSeries, {
      lineColor: '#2196f3',
      topColor: 'rgba(33, 150, 243, 0.4)',
      bottomColor: 'rgba(33, 150, 243, 0)',
    });
    seriesRef.current = areaSeries;
    const data = points.map((p) => {
      const [y, m, d] = (p.date || '').split('-').map(Number);
      return { time: { year: y, month: m, day: d }, value: p.cumulativePnl };
    });
    areaSeries.setData(data);
    chart.timeScale().fitContent();
    chartInstance.current = chart;

    const onResize = () => chart.applyOptions({ width: container.clientWidth });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartInstance.current = null;
      seriesRef.current = null;
    };
  }, [points, measureMode]);

  // Single click handler: alternate A / B using ref to avoid stale state
  const clickOrderRef = useRef(0);
  useEffect(() => {
    if (!measureMode || !chartInstance.current || !seriesRef.current) return;
    const chart = chartInstance.current;
    const areaSeries = seriesRef.current;
    const unsub = chart.subscribeClick((param) => {
      if (!param.point || param.seriesData.size === 0) return;
      const d = param.seriesData.get(areaSeries);
      const value = d?.value;
      if (value == null) return;
      const timeStr = formatChartTime(param.time);
      clickOrderRef.current += 1;
      const isA = clickOrderRef.current % 2 === 1;
      if (isA) {
        setPointA({ time: timeStr, value });
        setPointB(null);
      } else {
        setPointB({ time: timeStr, value });
      }
    });
    return () => { unsub(); };
  }, [measureMode]);

  const clearMeasure = () => {
    setPointA(null);
    setPointB(null);
    clickOrderRef.current = 0;
  };

  let percentChange = null;
  if (pointA && pointB && pointA.value != null && pointB.value != null) {
    if (pointA.value === 0) {
      percentChange = pointB.value === 0 ? '0%' : 'n/a (from zero)';
    } else {
      const pct = ((pointB.value - pointA.value) / Math.abs(pointA.value)) * 100;
      percentChange = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
    }
  }

  if (!points?.length) return <p className="muted">No equity data</p>;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => setMeasureMode((m) => !m)}
          style={{ fontWeight: measureMode ? 'bold' : undefined }}
        >
          {measureMode ? 'Measure % (on)' : 'Measure %'}
        </button>
        {measureMode && (
          <>
            <button type="button" onClick={clearMeasure}>Clear</button>
            <span className="muted">Click point A, then point B on the chart</span>
          </>
        )}
      </div>
      {measureMode && (pointA || pointB) && (
        <div className="muted" style={{ marginBottom: '0.5rem', fontSize: '0.9rem' }}>
          {pointA && <span>A: {pointA.time} = ₹{pointA.value?.toFixed(2)}</span>}
          {pointA && pointB && ' → '}
          {pointB && <span>B: {pointB.time} = ₹{pointB.value?.toFixed(2)}</span>}
          {percentChange != null && (
            <strong style={{ marginLeft: '0.5rem' }}>Change: {percentChange}</strong>
          )}
        </div>
      )}
      <div ref={chartRef} style={{ width: '100%', minHeight: 280 }} />
    </div>
  );
}
