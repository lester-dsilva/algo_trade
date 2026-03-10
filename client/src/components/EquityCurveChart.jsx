import { useEffect, useRef } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';

export default function EquityCurveChart({ points }) {
  const chartRef = useRef(null);
  const chartInstance = useRef(null);

  useEffect(() => {
    if (!points?.length || !chartRef.current) return;
    const container = chartRef.current;
    if (chartInstance.current) {
      chartInstance.current.remove();
      chartInstance.current = null;
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
    };
  }, [points]);

  if (!points?.length) return <p className="muted">No equity data</p>;
  return <div ref={chartRef} style={{ width: '100%', minHeight: 280 }} />;
}
