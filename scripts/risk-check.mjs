// Scheduled risk-check for MarketPulse. Runs from GitHub Actions on a cron
// schedule so alerts land even when the page isn't open. Mirrors the scoring
// logic in market-pulse.html (computeMomentum / computeNewsRisk) — keep the
// two in sync by hand if either changes, since there's no shared module
// between the browser script and this Node script.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || GMAIL_USER;
const ALPACA_API_KEY_ID = process.env.ALPACA_API_KEY_ID;
const ALPACA_API_SECRET_KEY = process.env.ALPACA_API_SECRET_KEY;
const ALPACA_BASE_URL = "https://paper-api.alpaca.markets"; // paper trading only — never the live-money endpoint

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = path.join(REPO_ROOT, "state", "risk-state.json");
const PAPER_STATE_PATH = path.join(REPO_ROOT, "state", "paper-trades.json");
const NEWS_WATCH_STATE_PATH = path.join(REPO_ROOT, "state", "news-watch-state.json");
const IPO_WATCH_STATE_PATH = path.join(REPO_ROOT, "state", "ipo-watch-state.json");
const PROJECTIONS_STATE_PATH = path.join(REPO_ROOT, "state", "projections.json");
const REALERT_AFTER_MS = 24 * 60 * 60 * 1000; // re-remind once a day while risk persists

// Paper-trading rule: buy $1,000 (simulated) when a stock's Momentum Score crosses
// into "Strong Up" territory, sell after ~5 trading days or sooner if Risk Watch
// flags it. No real money — Alpaca's paper API simulates fills against live prices.
const PAPER_ENABLED = Boolean(ALPACA_API_KEY_ID && ALPACA_API_SECRET_KEY);
const PAPER_ENTRY_MOMENTUM = 65;   // matches the "STRONG UP" cutoff used in market-pulse.html
const PAPER_NOTIONAL = 1000;       // simulated dollars per position
const PAPER_HOLDING_DAYS = 7;      // ~5 trading days, approximated in calendar days

// Trend Projection: NOT a forecast. A transparent formula — continue the recent
// 5-day daily average return rate forward — projected against what actually
// happens, tracked honestly (like Paper Trading) so its real accuracy is visible,
// not asserted. Reuses quote/metric data already fetched for the risk check.
const PROJECTION_HORIZON_DAYS = 5; // matches the paper-trading holding period, in calendar days

if (!FINNHUB_API_KEY) {
  console.error("FINNHUB_API_KEY is not set — add it as a repo Actions secret.");
  process.exit(1);
}

function clampScore(pct, span) {
  const v = Math.max(-span, Math.min(span, pct));
  return ((v + span) / (2 * span)) * 100;
}

const MOMENTUM_WEIGHTS = { fiveDay: 0.15, monthToDate: 0.15, week13: 0.25, week26: 0.20, today: 0.10, range52: 0.15 };
const MOMENTUM_DOWN_THRESHOLD = 45;
const NEWS_RISK_THRESHOLD = 60;

// A sudden, severe move shouldn't wait for the daily-reminder cadence below.
const EMERGENCY_PCT_THRESHOLD = -7;   // a large single-day drop (see IBM -25%, TSLA -19%/wk in watchlist.json for scale)
const NEWS_SPIKE_THRESHOLD = 2;       // this many *new* negative-keyword headlines since the last alert, on their own, is worth an immediate ping
const ESCALATION_DELTA = 12;          // if things get meaningfully worse since the last alert, re-notify immediately instead of waiting for the daily reminder

function computeMomentum(m, todayPct, price) {
  const parts = [];
  const add = (score, weight) => { if (typeof score === "number" && !Number.isNaN(score)) parts.push({ score, weight }); };
  if (m) {
    if (typeof m["5DayPriceReturnDaily"] === "number") add(clampScore(m["5DayPriceReturnDaily"], 15), MOMENTUM_WEIGHTS.fiveDay);
    if (typeof m["monthToDatePriceReturnDaily"] === "number") add(clampScore(m["monthToDatePriceReturnDaily"], 20), MOMENTUM_WEIGHTS.monthToDate);
    if (typeof m["13WeekPriceReturnDaily"] === "number") add(clampScore(m["13WeekPriceReturnDaily"], 35), MOMENTUM_WEIGHTS.week13);
    if (typeof m["26WeekPriceReturnDaily"] === "number") add(clampScore(m["26WeekPriceReturnDaily"], 50), MOMENTUM_WEIGHTS.week26);
    const hi = m["52WeekHigh"], lo = m["52WeekLow"];
    if (typeof hi === "number" && typeof lo === "number" && hi > lo && typeof price === "number") {
      add(Math.max(0, Math.min(100, ((price - lo) / (hi - lo)) * 100)), MOMENTUM_WEIGHTS.range52);
    }
  }
  if (typeof todayPct === "number" && !Number.isNaN(todayPct)) add(clampScore(todayPct, 8), MOMENTUM_WEIGHTS.today);
  if (parts.length === 0) return null;
  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const raw = parts.reduce((a, p) => a + p.score * p.weight, 0) / totalWeight;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

function computeNewsRisk(articles, keywords) {
  if (!Array.isArray(articles) || articles.length === 0) return { score: null, negHeadlines: [], negCount: 0 };
  let neg = 0, pos = 0, negCount = 0;
  const negHeadlines = [];
  for (const a of articles.slice(0, 25)) {
    const text = `${a.headline || ""} ${a.summary || ""}`.toLowerCase();
    let hit = false;
    for (const kw of keywords.negative) { if (text.includes(kw)) { neg++; hit = true; } }
    for (const kw of keywords.positive) { if (text.includes(kw)) pos++; }
    if (hit) {
      negCount++;
      if (negHeadlines.length < 3) negHeadlines.push(a.headline);
    }
  }
  const net = neg - pos;
  return { score: Math.round(clampScore(net, 6)), negHeadlines, negCount };
}

// Blends momentum + news + today's move into one "how bad does this look right
// now" number, used only to detect whether things have gotten meaningfully
// worse since the last email — not shown as a standalone metric anywhere.
function computeSeverity(momentum, newsRisk, pct) {
  const momentumPart = 100 - (momentum ?? 50);
  const newsPart = newsRisk ?? 50;
  const dropPart = clampScore(Math.max(0, -(pct ?? 0)), 15);
  return Math.round(0.4 * momentumPart + 0.35 * newsPart + 0.25 * dropPart);
}

function dateStr(d) { return d.toISOString().slice(0, 10); }

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadState() {
  return loadJson(STATE_PATH, {});
}

async function loadPaperState() {
  return loadJson(PAPER_STATE_PATH, { openPositions: {}, closedTrades: [] });
}

async function loadNewsWatchState() {
  return loadJson(NEWS_WATCH_STATE_PATH, {});
}

async function loadIpoWatchState() {
  return loadJson(IPO_WATCH_STATE_PATH, {});
}

async function loadProjectionsState() {
  return loadJson(PROJECTIONS_STATE_PATH, { pending: {}, resolved: [], stats: { totalResolved: 0, directionHits: 0, directionAccuracyPct: null, avgAbsErrorPct: null } });
}

// Naive linear extrapolation of the 5-day daily average return rate, continued
// forward for PROJECTION_HORIZON_DAYS more days. Deliberately simple and fully
// disclosed as a formula — not a model, not a forecast.
function computeProjection(price, fiveDayReturnPct) {
  if (typeof price !== "number" || typeof fiveDayReturnPct !== "number") return null;
  const dailyRatePct = fiveDayReturnPct / 5;
  const projectedPct = dailyRatePct * PROJECTION_HORIZON_DAYS;
  const projectedPrice = price * (1 + projectedPct / 100);
  return { projectedPrice: Math.round(projectedPrice * 100) / 100, projectedPct: Math.round(projectedPct * 100) / 100 };
}

function computeProjectionStats(resolved) {
  const total = resolved.length;
  if (total === 0) return { totalResolved: 0, directionHits: 0, directionAccuracyPct: null, avgAbsErrorPct: null };
  const hits = resolved.filter(r => r.directionHit).length;
  const avgAbsErrorPct = resolved.reduce((a, r) => a + Math.abs(r.errorPct), 0) / total;
  return {
    totalResolved: total,
    directionHits: hits,
    directionAccuracyPct: Math.round((hits / total) * 1000) / 10,
    avgAbsErrorPct: Math.round(avgAbsErrorPct * 100) / 100,
  };
}

// Loose match since a private company's name in Finnhub's IPO calendar may not
// exactly match how we refer to it — e.g. "Lambda Labs" could file as "Lambda,
// Inc.", so a plain substring check in either direction misses it. Match on
// the watched name's first (most distinctive) word as a whole word instead.
function namesMatch(watched, calendarName) {
  if (!calendarName) return false;
  const firstWord = watched.toLowerCase().trim().split(/\s+/)[0].replace(/[^a-z0-9]/g, "");
  if (!firstWord) return false;
  const calendarWords = calendarName.toLowerCase().split(/[^a-z0-9]+/);
  return calendarWords.includes(firstWord);
}

async function alpacaRequest(method, urlPath, body) {
  const res = await fetch(`${ALPACA_BASE_URL}${urlPath}`, {
    method,
    headers: {
      "APCA-API-KEY-ID": ALPACA_API_KEY_ID,
      "APCA-API-SECRET-KEY": ALPACA_API_SECRET_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Alpaca ${method} ${urlPath}: ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

function submitPaperOrder(symbol, side, notional) {
  return alpacaRequest("POST", "/v2/orders", { symbol, notional, side, type: "market", time_in_force: "day" });
}

function getPaperPosition(symbol) {
  return alpacaRequest("GET", `/v2/positions/${symbol}`);
}

function closePaperPosition(symbol) {
  return alpacaRequest("DELETE", `/v2/positions/${symbol}`);
}

function computePaperStats(closedTrades) {
  const total = closedTrades.length;
  if (total === 0) return { totalTrades: 0, wins: 0, winRatePct: null, avgReturnPct: null };
  const wins = closedTrades.filter(t => t.returnPct > 0).length;
  const avgReturnPct = closedTrades.reduce((a, t) => a + t.returnPct, 0) / total;
  return { totalTrades: total, wins, winRatePct: Math.round((wins / total) * 1000) / 10, avgReturnPct: Math.round(avgReturnPct * 100) / 100 };
}

async function main() {
  const watchlist = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "watchlist.json"), "utf8"));
  const keywords = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "news-keywords.json"), "utf8"));
  const newsWatchList = await loadJson(path.join(REPO_ROOT, "news-watch.json"), []);
  const ipoWatchList = await loadJson(path.join(REPO_ROOT, "ipo-watch.json"), []);
  const state = await loadState();
  const paperState = await loadPaperState();
  const newsWatchState = await loadNewsWatchState();
  const ipoWatchState = await loadIpoWatchState();
  const projectionsState = await loadProjectionsState();
  const now = Date.now();
  const toAlert = [];
  const paperEvents = [];
  const newsWatchEvents = [];
  const ipoWatchEvents = [];

  if (ipoWatchList.length > 0) {
    try {
      const from = dateStr(new Date(now - 14 * 86400000));
      const to = dateStr(new Date(now + 180 * 86400000));
      const { ipoCalendar } = await fetchJson(`https://finnhub.io/api/v1/calendar/ipo?from=${from}&to=${to}&token=${FINNHUB_API_KEY}`);
      for (const watched of ipoWatchList) {
        if (ipoWatchState[watched]) continue; // already notified once — going public is a one-time event
        const match = (ipoCalendar || []).find(entry => namesMatch(watched, entry.name));
        if (match) {
          ipoWatchEvents.push({ watched, name: match.name, symbol: match.symbol, exchange: match.exchange, date: match.date, status: match.status });
          ipoWatchState[watched] = { notifiedAt: new Date(now).toISOString(), matchedName: match.name, date: match.date };
        }
      }
    } catch (err) {
      console.error(`IPO calendar check failed: ${err.message}`);
    }
  }

  for (const s of watchlist) {
    try {
      // A small stagger between symbols, cheap insurance against Finnhub's free-tier
      // rate limit now that the watchlist has grown — a symbol that does get rate
      // limited just logs and is skipped for this run, not fatal to the whole job.
      await new Promise(resolve => setTimeout(resolve, 150));
      const [quote, metrics, news] = await Promise.all([
        fetchJson(`https://finnhub.io/api/v1/quote?symbol=${s.sym}&token=${FINNHUB_API_KEY}`),
        fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${s.sym}&metric=all&token=${FINNHUB_API_KEY}`),
        fetchJson(`https://finnhub.io/api/v1/company-news?symbol=${s.sym}&from=${dateStr(new Date(now - 7 * 86400000))}&to=${dateStr(new Date(now))}&token=${FINNHUB_API_KEY}`),
      ]);

      const momentum = computeMomentum(metrics.metric || null, quote.dp, quote.c);
      const { score: newsRisk, negHeadlines, negCount } = computeNewsRisk(news, keywords);
      const pct = quote.dp;
      const severity = computeSeverity(momentum, newsRisk, pct);
      console.log(`${s.sym}: price=${quote.c} pct=${pct} momentum=${momentum} newsRisk=${newsRisk} negCount=${negCount} severity=${severity}`);

      const prior = state[s.sym] || { seen: false, flagged: false, lastAlertAt: null, lastSeverity: null, lastNegCount: 0 };
      const riskNow = momentum !== null && momentum < MOMENTUM_DOWN_THRESHOLD
                    && newsRisk !== null && newsRisk >= NEWS_RISK_THRESHOLD;
      // The spike check needs a real prior observation to compare against — without
      // `prior.seen`, a symbol's first-ever check (or the news backlog after a state
      // reset) reads as a "sudden spike" purely because the baseline defaults to 0.
      const newsSpike = prior.seen && (negCount - (prior.lastNegCount ?? 0)) >= NEWS_SPIKE_THRESHOLD;
      const emergencyNow = pct <= EMERGENCY_PCT_THRESHOLD || newsSpike;
      const flaggedNow = riskNow || emergencyNow;
      const isFirstFlag = flaggedNow && !prior.flagged;
      const isDailyReminder = riskNow && prior.flagged && prior.lastAlertAt
        && (now - new Date(prior.lastAlertAt).getTime()) >= REALERT_AFTER_MS;
      const isEscalation = flaggedNow && prior.flagged && prior.lastAlertAt
        && severity >= (prior.lastSeverity ?? 0) + ESCALATION_DELTA;

      if (isFirstFlag || isDailyReminder || isEscalation) {
        const reason = emergencyNow ? "EMERGENCY" : isEscalation ? "ESCALATION" : isFirstFlag ? "NEW" : "REMINDER";
        toAlert.push({ sym: s.sym, name: s.name, momentum, newsRisk, negHeadlines, price: quote.c, pct, reason });
        state[s.sym] = { seen: true, flagged: true, lastAlertAt: new Date(now).toISOString(), lastSeverity: severity, lastNegCount: negCount };
      } else {
        // lastNegCount always tracks the real current count (flagged or not), so the
        // next run's spike check measures genuinely new headlines since this check —
        // never an artificial reset — and lastSeverity/lastAlertAt only move on an
        // actual alert, so escalation is always measured from what was last emailed.
        state[s.sym] = {
          seen: true,
          flagged: flaggedNow,
          lastAlertAt: flaggedNow ? prior.lastAlertAt : null,
          lastSeverity: flaggedNow ? (prior.lastSeverity ?? severity) : null,
          lastNegCount: negCount,
        };
      }

      if (newsWatchList.includes(s.sym)) {
        const priorWatch = newsWatchState[s.sym] || { seen: false, lastSeenAt: 0 };
        // Same cold-start problem as the risk spike check: without `seen`, the
        // entire 7-day backlog would read as "new" on the first-ever check.
        const freshHeadlines = priorWatch.seen
          ? news.filter(a => typeof a.datetime === "number" && a.datetime > priorWatch.lastSeenAt)
          : [];
        const maxDatetime = news.reduce((max, a) => Math.max(max, a.datetime || 0), priorWatch.lastSeenAt);
        if (freshHeadlines.length > 0) {
          newsWatchEvents.push({
            sym: s.sym, name: s.name,
            headlines: freshHeadlines
              .sort((a, b) => b.datetime - a.datetime)
              .slice(0, 5)
              .map(a => ({ headline: a.headline, url: a.url, source: a.source })),
          });
        }
        newsWatchState[s.sym] = { seen: true, lastSeenAt: maxDatetime };
      }

      {
        const pending = projectionsState.pending[s.sym];
        if (pending && now >= new Date(pending.targetDate).getTime()) {
          const actualPrice = quote.c;
          const actualPct = Math.round(((actualPrice - pending.currentPriceAtProjection) / pending.currentPriceAtProjection) * 10000) / 100;
          const errorPct = Math.round((actualPct - pending.projectedPct) * 100) / 100;
          const directionHit = Math.sign(actualPct) === Math.sign(pending.projectedPct) || (Math.abs(actualPct) < 0.5 && Math.abs(pending.projectedPct) < 0.5);
          projectionsState.resolved.push({
            sym: s.sym, name: s.name,
            madeAt: pending.madeAt, targetDate: pending.targetDate,
            projectedPrice: pending.projectedPrice, projectedPct: pending.projectedPct,
            actualPrice, actualPct, errorPct, directionHit,
          });
          // Cap history so the state file (and stats) don't grow unbounded forever —
          // keep the most recent 300, which is plenty for an honest accuracy read.
          if (projectionsState.resolved.length > 300) projectionsState.resolved = projectionsState.resolved.slice(-300);
          delete projectionsState.pending[s.sym];
        }
        if (!projectionsState.pending[s.sym]) {
          const fiveDayReturn = metrics.metric?.["5DayPriceReturnDaily"];
          const projection = computeProjection(quote.c, fiveDayReturn);
          if (projection) {
            projectionsState.pending[s.sym] = {
              name: s.name,
              madeAt: new Date(now).toISOString(),
              targetDate: new Date(now + PROJECTION_HORIZON_DAYS * 86400000).toISOString(),
              currentPriceAtProjection: quote.c,
              projectedPrice: projection.projectedPrice,
              projectedPct: projection.projectedPct,
            };
          }
        }
      }

      if (PAPER_ENABLED) {
        const openPosition = paperState.openPositions[s.sym];
        if (!openPosition && momentum !== null && momentum >= PAPER_ENTRY_MOMENTUM) {
          await submitPaperOrder(s.sym, "buy", PAPER_NOTIONAL);
          paperState.openPositions[s.sym] = { entryDate: new Date(now).toISOString(), entryMomentum: momentum };
          paperEvents.push({ sym: s.sym, name: s.name, action: "BUY", momentum, reason: "Momentum crossed into Strong Up" });
        } else if (openPosition) {
          const daysHeld = (now - new Date(openPosition.entryDate).getTime()) / 86400000;
          const exitReason = flaggedNow ? "Risk Watch flagged" : daysHeld >= PAPER_HOLDING_DAYS ? `Held ${PAPER_HOLDING_DAYS}+ days` : null;
          if (exitReason) {
            const position = await getPaperPosition(s.sym);
            const returnPct = position ? Math.round(Number(position.unrealized_plpc) * 10000) / 100 : null;
            await closePaperPosition(s.sym);
            paperState.closedTrades.push({
              sym: s.sym, name: s.name,
              entryDate: openPosition.entryDate, exitDate: new Date(now).toISOString(),
              returnPct, exitReason,
            });
            delete paperState.openPositions[s.sym];
            paperEvents.push({ sym: s.sym, name: s.name, action: "SELL", returnPct, reason: exitReason });
          }
        }
      }
    } catch (err) {
      console.error(`Skipping ${s.sym}: ${err.message}`);
    }
  }

  if (PAPER_ENABLED) {
    paperState.stats = computePaperStats(paperState.closedTrades);
    await fs.writeFile(PAPER_STATE_PATH, JSON.stringify(paperState, null, 2) + "\n");
  }

  await fs.writeFile(NEWS_WATCH_STATE_PATH, JSON.stringify(newsWatchState, null, 2) + "\n");
  await fs.writeFile(IPO_WATCH_STATE_PATH, JSON.stringify(ipoWatchState, null, 2) + "\n");

  projectionsState.stats = computeProjectionStats(projectionsState.resolved);
  await fs.writeFile(PROJECTIONS_STATE_PATH, JSON.stringify(projectionsState, null, 2) + "\n");

  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");

  if (toAlert.length === 0 && paperEvents.length === 0 && newsWatchEvents.length === 0 && ipoWatchEvents.length === 0) {
    console.log("No new risk alerts, paper trades, watched headlines, or IPO matches this run.");
    return;
  }

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !ALERT_EMAIL_TO) {
    console.log(`${toAlert.length} risk alert(s), ${paperEvents.length} paper trade event(s), ${newsWatchEvents.length} news-watch symbol(s), ${ipoWatchEvents.length} IPO match(es), but email isn't configured (GMAIL_USER/GMAIL_APP_PASSWORD/ALERT_EMAIL_TO).`);
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  const hasEmergency = toAlert.some(a => a.reason === "EMERGENCY");
  const reasonLabel = { EMERGENCY: "EMERGENCY — sudden severe move", ESCALATION: "ESCALATION — got meaningfully worse since the last alert", NEW: "new risk flag", REMINDER: "still flagged (daily reminder)" };

  if (toAlert.length > 0 || paperEvents.length > 0) {
    const sections = [];

    if (toAlert.length > 0) {
      const lines = toAlert.map(a => {
        const headline = a.negHeadlines[0] ? `\n    Headline: "${a.negHeadlines[0]}"` : "";
        return `- [${reasonLabel[a.reason]}] ${a.sym} (${a.name}): $${a.price?.toFixed(2)} (${a.pct >= 0 ? "+" : ""}${a.pct?.toFixed(2)}% today), Momentum ${a.momentum}, News Risk ${a.newsRisk}${headline}`;
      });
      sections.push([
        "MarketPulse alert — stocks where recent momentum has turned down and/or headlines/price action look severe.",
        "This is a heuristic reflecting past price/news data, not a prediction, forecast, or investment advice. Verify independently before acting.",
        "",
        ...lines,
      ].join("\n"));
    }

    if (paperEvents.length > 0) {
      const lines = paperEvents.map(e => {
        const detail = e.action === "BUY" ? `Momentum ${e.momentum}` : `Return ${e.returnPct >= 0 ? "+" : ""}${e.returnPct?.toFixed(2)}%`;
        return `- ${e.action} ${e.sym} (${e.name}) — ${e.reason} — ${detail}`;
      });
      const stats = paperState.stats;
      const statsLine = stats.totalTrades > 0
        ? `Track record so far: ${stats.totalTrades} closed trade(s), ${stats.winRatePct}% win rate, ${stats.avgReturnPct >= 0 ? "+" : ""}${stats.avgReturnPct}% average return.`
        : "No closed trades yet.";
      sections.push([
        "📊 Paper Trading (simulated via Alpaca — no real money) — buys on Momentum Score crossing into Strong Up, sells after ~5 trading days or if Risk Watch flags it.",
        ...lines,
        "",
        statsLine,
        "Past paper-trade results are not a guarantee of future performance.",
      ].join("\n"));
    }

    sections.push("https://voltagejpb.github.io/Stocks/market-pulse.html");
    const text = sections.join("\n\n");

    const subjectPrefix = hasEmergency ? "🚨 EMERGENCY" : toAlert.length > 0 ? "MarketPulse Risk Watch" : "MarketPulse Paper Trading";
    const subjectSyms = toAlert.length > 0 ? toAlert.map(a => a.sym) : paperEvents.map(e => e.sym);
    await transporter.sendMail({
      from: GMAIL_USER,
      to: ALERT_EMAIL_TO,
      subject: `${subjectPrefix}: ${subjectSyms.join(", ")}`,
      text,
    });

    console.log(`Sent email (risk: ${toAlert.map(a => `${a.sym}:${a.reason}`).join(", ") || "none"}; paper: ${paperEvents.map(e => `${e.sym}:${e.action}`).join(", ") || "none"})`);
  }

  if (newsWatchEvents.length > 0) {
    const lines = newsWatchEvents.flatMap(e => [
      `${e.sym} (${e.name}):`,
      ...e.headlines.map(h => `  - "${h.headline}"${h.source ? ` [${h.source}]` : ""}${h.url ? `\n    ${h.url}` : ""}`),
    ]);
    const text = [
      `📰 MarketPulse News Watch — new headlines for ${newsWatchEvents.map(e => e.sym).join(", ")} since the last check.`,
      "Raw headlines, not sentiment-scored or risk-filtered — just surfacing what's new.",
      "",
      ...lines,
      "",
      "https://voltagejpb.github.io/Stocks/market-pulse.html",
    ].join("\n");

    await transporter.sendMail({
      from: GMAIL_USER,
      to: ALERT_EMAIL_TO,
      subject: `📰 MarketPulse News Watch: ${newsWatchEvents.map(e => e.sym).join(", ")}`,
      text,
    });

    console.log(`Sent News Watch email (${newsWatchEvents.map(e => `${e.sym}:${e.headlines.length}`).join(", ")})`);
  }

  if (ipoWatchEvents.length > 0) {
    const lines = ipoWatchEvents.map(e =>
      `- ${e.watched} → matched "${e.name}"${e.symbol ? ` (${e.symbol})` : ""}${e.exchange ? ` on ${e.exchange}` : ""}, date ${e.date}${e.status ? `, status: ${e.status}` : ""}`
    );
    const text = [
      `🔔 MarketPulse IPO Watch — a company you're watching showed up on the IPO calendar.`,
      "This is a one-time notification per company — verify the listing independently before acting.",
      "",
      ...lines,
      "",
      "https://voltagejpb.github.io/Stocks/market-pulse.html",
    ].join("\n");

    await transporter.sendMail({
      from: GMAIL_USER,
      to: ALERT_EMAIL_TO,
      subject: `🔔 MarketPulse IPO Watch: ${ipoWatchEvents.map(e => e.watched).join(", ")}`,
      text,
    });

    console.log(`Sent IPO Watch email (${ipoWatchEvents.map(e => e.watched).join(", ")})`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
