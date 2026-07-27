import { runBacktestForDate } from './runBacktest.js';
for (const opts of [{ volMode: 'fullday' }, { volMode: 'pace', paceVolMult: 2.7 }]) {
  const out = runBacktestForDate('2026-06-01', { quiet: true, ...opts });
  const r = out.results.find((x) => x.symbol.toUpperCase() === 'REDINGTON');
  console.log(`${opts.volMode}${opts.paceVolMult ? ' K=' + opts.paceVolMult : ''}: REDINGTON ${r ? (r.time || '').slice(0, 5) + ' @ ' + r.entry + ' -> ' + r.exitReason + ' pnl=' + Math.round(r.pnl) : 'no trade'}  | day trades=${out.trades}`);
}
