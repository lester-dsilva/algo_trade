/**
 * Run v3 swing backtest: daily screen → hourly volume breakout → swing exit.
 *
 * Run from repo root:
 *   node v3/scripts/runBacktest.js --symbol INOXINDIA --verbose
 *   node v3/scripts/runBacktest.js --from 2025-06-01 --to 2026-08-31
 */

import { loadDailyForSymbol, loadHourlyForSymbol, listSymbolsWithData } from '../lib/loadV3Data.js';
import { fileURLToPath } from 'url';
import path from 'path';
import { findHourlyEntryOnDay } from '../lib/hourlyEntryLogic.js';
import { simulateSwingTrade } from '../lib/swingExitLogic.js';
import { breadthFilterFromEnv, checkBreadthForDate } from '../lib/breadthFilter.js';
import { loadWatchlistSymbols } from '../lib/v3Universe.js';

function parseArgs(argv) {
  const breadthOpts = breadthFilterFromEnv();
  const opts = {
    symbol: null,
    from: null,
    to: null,
    verbose: false,
    positionValue: 50000,
    breadthEnabled: breadthOpts.enabled,
    breadthOpts,
    breadthCache: new Map(),
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--symbol' && argv[i + 1]) opts.symbol = argv[++i].toUpperCase();
    else if (argv[i] === '--from' && argv[i + 1]) opts.from = argv[++i];
    else if (argv[i] === '--to' && argv[i + 1]) opts.to = argv[++i];
    else if (argv[i] === '--verbose') opts.verbose = true;
    else if (argv[i] === '--no-breadth') opts.breadthEnabled = false;
    else if (argv[i] === '--position-value' && argv[i + 1]) opts.positionValue = parseFloat(argv[++i]);
  }
  return opts;
}

function isBreadthOk(date, opts) {
  if (!opts.breadthEnabled) return true;
  if (!opts.breadthCache.has(date)) {
    const symbols = opts.breadthSymbols || [];
    opts.breadthCache.set(date, checkBreadthForDate(symbols, date, opts.breadthOpts));
  }
  return opts.breadthCache.get(date).pass;
}


export function runBacktestForSymbol(symbol, opts = {}) {
  const positionValue = opts.positionValue ?? 50000;
  const dailyBars = loadDailyForSymbol(symbol);
  const hourlyBars = loadHourlyForSymbol(symbol);
  if (!dailyBars?.length || !hourlyBars?.length) return null;

  const from = opts.from || dailyBars[0].date;
  const to = opts.to || dailyBars[dailyBars.length - 1].date;

  const hourlyInRange = hourlyBars.filter((b) => b.date >= from && b.date <= to);
  const tradeDates = [...new Set(hourlyInRange.map((b) => b.date))].sort();

  const trades = [];
  let lastExitDate = null;

  for (const date of tradeDates) {
    if (lastExitDate && date <= lastExitDate) continue;
    if (!isBreadthOk(date, opts)) continue;

    const dayBars = hourlyBars.filter((b) => b.date === date);
    const dailyContext = { dailyBars };
    const entry = findHourlyEntryOnDay(dayBars, hourlyBars, dailyContext, opts.entryOpts);
    if (!entry) continue;

    const sim = simulateSwingTrade(
      { ...entry, entryPrice: entry.entryPrice },
      hourlyBars,
      dailyBars,
      { positionValue, ...opts.exitOpts }
    );

    if (sim.exitReason === 'skip') continue;

    const trade = {
      symbol,
      entryDate: entry.date,
      entryTime: entry.time,
      entryPrice: entry.entryPrice,
      stop: entry.stop,
      exitTime: sim.exitTime,
      exitPrice: sim.exitPrice,
      exitReason: sim.exitReason,
      pnl: sim.pnl,
      qty: sim.qty,
      holdDays: sim.holdDays,
      rMultiple: sim.rMultiple,
      breakoutVolRatio: entry.breakoutVolRatio,
    };
    trades.push(trade);
    lastExitDate = sim.exitDate;
  }

  return { symbol, from, to, trades };
}

function summarize(allTrades) {
  const wins = allTrades.filter((t) => t.pnl > 0);
  const losses = allTrades.filter((t) => t.pnl <= 0);
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const avgHold = allTrades.length
    ? allTrades.reduce((s, t) => s + t.holdDays, 0) / allTrades.length
    : 0;
  const avgR = allTrades.length
    ? allTrades.reduce((s, t) => s + (t.rMultiple || 0), 0) / allTrades.length
    : 0;
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const t of allTrades) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return {
    trades: allTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: allTrades.length ? Math.round((wins.length / allTrades.length) * 1000) / 10 : 0,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgHoldDays: Math.round(avgHold * 10) / 10,
    avgR: Math.round(avgR * 100) / 100,
    maxDrawdown: Math.round(maxDd * 100) / 100,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  opts.breadthSymbols = loadWatchlistSymbols();
  const symbols = opts.symbol ? [opts.symbol] : listSymbolsWithData('daily');

  if (!symbols.length) {
    console.error('No v3 data found. Run: node v3/scripts/fetchV3Data.js --symbol INOXINDIA');
    process.exit(1);
  }

  const allTrades = [];
  for (const sym of symbols) {
    const result = runBacktestForSymbol(sym, opts);
    if (!result) {
      console.error(`Skip ${sym}: missing data`);
      continue;
    }
    if (opts.verbose) {
      console.error(`\n=== ${sym} (${result.from} → ${result.to}) ===`);
      for (const t of result.trades) {
        console.error(
          `  ${t.entryDate} ${t.entryTime} @ ${t.entryPrice} → ${t.exitTime} @ ${t.exitPrice} | ${t.exitReason} | PnL ₹${t.pnl} | ${t.holdDays}d | ${t.rMultiple}R`
        );
      }
    }
    allTrades.push(...result.trades);
  }

  const summary = summarize(allTrades);
  console.log('\n--- v3 Swing Backtest Summary ---');
  if (opts.breadthEnabled) {
    console.log(`Breadth filter: ON (>= ${(opts.breadthOpts.minPct * 100).toFixed(0)}% watchlist above 20d SMA)`);
  } else {
    console.log('Breadth filter: OFF');
  }
  console.log(JSON.stringify(summary, null, 2));

  if (allTrades.length) {
    console.log('\n--- Trades CSV ---');
    const header = 'symbol,entryDate,entryTime,entryPrice,stop,exitTime,exitPrice,exitReason,pnl,qty,holdDays,rMultiple';
    console.log(header);
    for (const t of allTrades) {
      console.log(
        [t.symbol, t.entryDate, t.entryTime, t.entryPrice, t.stop, t.exitTime, t.exitPrice,
          t.exitReason, t.pnl, t.qty, t.holdDays, t.rMultiple].join(',')
      );
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error('ERROR:', err.message || err);
    process.exit(1);
  });
}
