// One-off (manually triggered) research tool — NOT part of the recurring
// risk-check cron. Answers a narrow, honest question: across real historical
// prices, which take-profit / stop-loss / entry-momentum / hold-days
// combination for the Paper Trading rule would have produced the best real
// (simulated) result?
//
// Scope and limitations, disclosed up front rather than glossed over:
// - Uses real historical daily bars from Alpaca's Market Data API (free tier,
//   IEX feed, split-adjusted) — no fabricated or estimated prices.
// - Momentum here is reconstructed from price alone (5-day / month-to-date /
//   13-week / 26-week returns, today's move, 52-week range position) using
//   the exact same weights and formula as computeMomentum() in
//   risk-check.mjs / market-pulse.html, so it's an apples-to-apples replay of
//   the real live signal — NOT a different or improved model.
// - It CANNOT replay the Risk Watch news-based exit, because there is no
//   historical archive of the headlines that would have been seen on any
//   past date. This backtest isolates and calibrates only the take-profit /
//   stop-loss / hold-days part of the rule. Risk Watch stays a live, honest,
//   currently-tracked exit on top of whatever this picks.
// - Past performance on historical data is not a guarantee of future
//   performance. This picks the least-bad-in-hindsight parameters, not a
//   predictor of what will happen next.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALPACA_API_KEY_ID = process.env.ALPACA_API_KEY_ID;
const ALPACA_API_SECRET_KEY = process.env.ALPACA_API_SECRET_KEY;
const ALPACA_DATA_URL = "https://data.alpaca.markets";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_PATH = path.join(REPO_ROOT, "state", "backtest-results.json");

const BACKTEST_YEARS = 5;
const NOTIONAL = 1000;       // matches PAPER_NOTIONAL in risk-check.mjs
const MIN_TRADES_TO_RANK = 50; // ignore parameter combos with too few trades to mean anything

// Must exactly mirror MOMENTUM_WEIGHTS / clampScore / computeMomentum in
// risk-check.mjs — the whole point is replaying the real live formula.
const MOMENTUM_WEIGHTS = { fiveDay: 0.15, monthToDate: 0.15, week13: 0.25, week26: 0.20, today: 0.10, range52: 0.15 };

function clampScore(pct, span) {
  const v = Math.max(-span, Math.min(span, pct));
  return ((v + span) / (2 * span)) * 100;
}

function computeMomentum({ r5, rMtd, r13, r26, todayPct, price, hi52, lo52 }) {
  const parts = [];
  const add = (score, weight) => { if (typeof score === "number" && !Number.isNaN(score)) parts.push({ score, weight }); };
  if (typeof r5 === "number") add(clampScore(r5, 15), MOMENTUM_WEIGHTS.fiveDay);
  if (typeof rMtd === "number") add(clampScore(rMtd, 20), MOMENTUM_WEIGHTS.monthToDate);
  if (typeof r13 === "number") add(clampScore(r13, 35), MOMENTUM_WEIGHTS.week13);
  if (typeof r26 === "number") add(clampScore(r26, 50), MOMENTUM_WEIGHTS.week26);
  if (typeof hi52 === "number" && typeof lo52 === "number" && hi52 > lo52 && typeof price === "number") {
    add(Math.max(0, Math.min(100, ((price - lo52) / (hi52 - lo52)) * 100)), MOMENTUM_WEIGHTS.range52);
  }
  if (typeof todayPct === "number") add(clampScore(todayPct, 8), MOMENTUM_WEIGHTS.today);
  if (parts.length === 0) return null;
  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const raw = parts.reduce((a, p) => a + p.score * p.weight, 0) / totalWeight;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

function pctChange(from, to) { return ((to - from) / from) * 100; }

async function fetchDailyBars(symbol, start, end) {
  const bars = [];
  let pageToken = null;
  do {
    const url = new URL(`${ALPACA_DATA_URL}/v2/stocks/${symbol}/bars`);
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("limit", "10000");
    url.searchParams.set("adjustment", "split");
    // Free/paper Alpaca accounts are only entitled to the IEX feed — the
    // endpoint defaults to SIP, which returns a blanket 403 without this.
    url.searchParams.set("feed", "iex");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const res = await fetch(url, {
      headers: { "APCA-API-KEY-ID": ALPACA_API_KEY_ID, "APCA-API-SECRET-KEY": ALPACA_API_SECRET_KEY },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    bars.push(...(data.bars || []));
    pageToken = data.next_page_token || null;
  } while (pageToken);
  return bars.map(b => ({ date: b.t.slice(0, 10), close: b.c }));
}

// Reconstructs the same six inputs computeMomentum() uses, purely from a daily
// close-price series — a historical replay of the live signal, not a new one.
function computeMomentumSeries(series) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const price = series[i].close;
    const r5 = i >= 5 ? pctChange(series[i - 5].close, price) : null;
    const today = i >= 1 ? pctChange(series[i - 1].close, price) : null;
    const r13 = i >= 65 ? pctChange(series[i - 65].close, price) : null;
    const r26 = i >= 130 ? pctChange(series[i - 130].close, price) : null;

    const ym = series[i].date.slice(0, 7);
    let mtdIdx = i;
    while (mtdIdx > 0 && series[mtdIdx - 1].date.slice(0, 7) === ym) mtdIdx--;
    const rMtd = mtdIdx !== i ? pctChange(series[mtdIdx].close, price) : null;

    const windowStart = Math.max(0, i - 251); // trailing ~252 trading days ~= 52 weeks
    let hi52 = -Infinity, lo52 = Infinity;
    for (let j = windowStart; j <= i; j++) {
      if (series[j].close > hi52) hi52 = series[j].close;
      if (series[j].close < lo52) lo52 = series[j].close;
    }

    out.push({
      date: series[i].date,
      price,
      momentum: computeMomentum({ r5, rMtd, r13, r26, todayPct: today, price, hi52, lo52 }),
    });
  }
  return out;
}

// Simulates ONLY the take-profit / stop-loss / hold-days part of the paper-
// trading rule (Risk Watch can't be replayed historically — see file header).
function simulate(momentumSeries, { entryMomentum, takeProfitPct, stopLossPct, holdDays }) {
  const trades = [];
  let position = null;
  for (let i = 0; i < momentumSeries.length; i++) {
    const { momentum, price } = momentumSeries[i];
    if (!position) {
      if (momentum !== null && momentum >= entryMomentum) position = { entryIdx: i, entryPrice: price };
      continue;
    }
    const daysHeld = i - position.entryIdx;
    const returnPct = pctChange(position.entryPrice, price);
    const hitTakeProfit = returnPct >= takeProfitPct;
    const hitStopLoss = returnPct <= stopLossPct;
    const hitCeiling = daysHeld >= holdDays;
    if (hitTakeProfit || hitStopLoss || hitCeiling) {
      trades.push({ returnPct: Math.round(returnPct * 100) / 100, exitReason: hitTakeProfit ? "take-profit" : hitStopLoss ? "stop-loss" : "hold-days" });
      position = null;
    }
  }
  return trades;
}

function summarize(trades) {
  const total = trades.length;
  if (total === 0) return { totalTrades: 0, wins: 0, winRatePct: null, avgReturnPct: null, netProfitUsd: 0, profitFactor: null };
  const wins = trades.filter(t => t.returnPct > 0).length;
  const netProfitUsd = trades.reduce((a, t) => a + (t.returnPct / 100) * NOTIONAL, 0);
  const grossProfit = trades.filter(t => t.returnPct > 0).reduce((a, t) => a + (t.returnPct / 100) * NOTIONAL, 0);
  const grossLoss = Math.abs(trades.filter(t => t.returnPct < 0).reduce((a, t) => a + (t.returnPct / 100) * NOTIONAL, 0));
  return {
    totalTrades: total,
    wins,
    winRatePct: Math.round((wins / total) * 1000) / 10,
    avgReturnPct: Math.round((trades.reduce((a, t) => a + t.returnPct, 0) / total) * 100) / 100,
    netProfitUsd: Math.round(netProfitUsd * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : (grossProfit > 0 ? null : null),
  };
}

async function main() {
  if (!ALPACA_API_KEY_ID || !ALPACA_API_SECRET_KEY) {
    console.error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set — this backtest needs the same Alpaca keys paper trading uses.");
    process.exit(1);
  }

  const watchlist = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "watchlist.json"), "utf8"));
  const end = new Date();
  const start = new Date(end.getTime() - BACKTEST_YEARS * 365 * 86400000);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  const momentumSeriesBySymbol = {};
  const symbolsUsed = [];
  const symbolsSkipped = [];

  for (const s of watchlist) {
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      const series = await fetchDailyBars(s.sym, startStr, endStr);
      if (series.length < 260) { // need at least ~1 year for the 52-week range to mean anything
        symbolsSkipped.push({ sym: s.sym, reason: `only ${series.length} trading days of history available` });
        continue;
      }
      momentumSeriesBySymbol[s.sym] = computeMomentumSeries(series);
      symbolsUsed.push(s.sym);
      console.log(`${s.sym}: ${series.length} bars (${series[0].date} to ${series[series.length - 1].date})`);
    } catch (err) {
      symbolsSkipped.push({ sym: s.sym, reason: err.message });
      console.error(`Skipping ${s.sym}: ${err.message}`);
    }
  }

  const ENTRY_CANDIDATES = [55, 60, 65, 70];
  const TAKE_PROFIT_CANDIDATES = [5, 8, 12];
  const STOP_LOSS_CANDIDATES = [-3, -4, -6];
  const HOLD_DAYS_CANDIDATES = [5, 7, 10];

  const allResults = [];
  for (const entryMomentum of ENTRY_CANDIDATES) {
    for (const takeProfitPct of TAKE_PROFIT_CANDIDATES) {
      for (const stopLossPct of STOP_LOSS_CANDIDATES) {
        for (const holdDays of HOLD_DAYS_CANDIDATES) {
          const params = { entryMomentum, takeProfitPct, stopLossPct, holdDays };
          let allTrades = [];
          for (const sym of symbolsUsed) allTrades = allTrades.concat(simulate(momentumSeriesBySymbol[sym], params));
          allResults.push({ params, ...summarize(allTrades) });
        }
      }
    }
  }

  const rankable = allResults.filter(r => r.totalTrades >= MIN_TRADES_TO_RANK);
  rankable.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  const best = rankable[0] || null;

  let currentTrades = [];
  const currentParams = { entryMomentum: 65, takeProfitPct: 8, stopLossPct: -4, holdDays: 7 };
  for (const sym of symbolsUsed) currentTrades = currentTrades.concat(simulate(momentumSeriesBySymbol[sym], currentParams));
  const currentResult = { params: currentParams, ...summarize(currentTrades) };

  const output = {
    generatedAt: new Date().toISOString(),
    methodology: "Replays computeMomentum() against real historical daily prices (Alpaca Market Data API, IEX feed, split-adjusted) to find which take-profit/stop-loss/entry-momentum/hold-days combination for Paper Trading would have produced the best real (simulated) net profit. Does NOT replay the Risk Watch news-based exit — no historical headline archive exists to test that against, so this calibrates only the take-profit/stop-loss/hold-days part of the live rule. Ranked by total net simulated $ profit among combinations with at least " + MIN_TRADES_TO_RANK + " trades in the sample (to avoid picking a combination based on a thin, lucky sample). Past performance on historical data is not a guarantee of future performance.",
    period: { start: startStr, end: endStr, years: BACKTEST_YEARS },
    symbolsUsed,
    symbolsSkipped,
    minTradesToRank: MIN_TRADES_TO_RANK,
    parameterGrid: { entryMomentum: ENTRY_CANDIDATES, takeProfitPct: TAKE_PROFIT_CANDIDATES, stopLossPct: STOP_LOSS_CANDIDATES, holdDays: HOLD_DAYS_CANDIDATES },
    currentDefault: currentResult,
    best,
    top10: rankable.slice(0, 10),
  };

  await fs.mkdir(path.dirname(RESULTS_PATH), { recursive: true });
  await fs.writeFile(RESULTS_PATH, JSON.stringify(output, null, 2) + "\n");

  console.log(`\nCurrent default (${JSON.stringify(currentParams)}): ${currentResult.totalTrades} trades, ${currentResult.winRatePct}% win rate, $${currentResult.netProfitUsd} net`);
  if (best) {
    console.log(`Best found (${JSON.stringify(best.params)}): ${best.totalTrades} trades, ${best.winRatePct}% win rate, $${best.netProfitUsd} net`);
  } else {
    console.log("No parameter combination reached the minimum trade count to rank.");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
