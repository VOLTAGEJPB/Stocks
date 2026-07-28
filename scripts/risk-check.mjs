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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = path.join(REPO_ROOT, "state", "risk-state.json");
const REALERT_AFTER_MS = 24 * 60 * 60 * 1000; // re-remind once a day while risk persists

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

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const watchlist = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "watchlist.json"), "utf8"));
  const keywords = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "news-keywords.json"), "utf8"));
  const state = await loadState();
  const now = Date.now();
  const toAlert = [];

  for (const s of watchlist) {
    try {
      const [quote, metrics, news] = await Promise.all([
        fetchJson(`https://finnhub.io/api/v1/quote?symbol=${s.sym}&token=${FINNHUB_API_KEY}`),
        fetchJson(`https://finnhub.io/api/v1/stock/metric?symbol=${s.sym}&metric=all&token=${FINNHUB_API_KEY}`),
        fetchJson(`https://finnhub.io/api/v1/company-news?symbol=${s.sym}&from=${dateStr(new Date(now - 7 * 86400000))}&to=${dateStr(new Date(now))}&token=${FINNHUB_API_KEY}`),
      ]);

      const momentum = computeMomentum(metrics.metric || null, quote.dp, quote.c);
      const { score: newsRisk, negHeadlines, negCount } = computeNewsRisk(news, keywords);
      const pct = quote.dp;
      const severity = computeSeverity(momentum, newsRisk, pct);

      const prior = state[s.sym] || { flagged: false, lastAlertAt: null, lastSeverity: null, lastNegCount: 0 };
      const riskNow = momentum !== null && momentum < MOMENTUM_DOWN_THRESHOLD
                    && newsRisk !== null && newsRisk >= NEWS_RISK_THRESHOLD;
      const emergencyNow = pct <= EMERGENCY_PCT_THRESHOLD
                         || (negCount - (prior.lastNegCount ?? 0)) >= NEWS_SPIKE_THRESHOLD;
      const flaggedNow = riskNow || emergencyNow;
      const isFirstFlag = flaggedNow && !prior.flagged;
      const isDailyReminder = riskNow && prior.flagged && prior.lastAlertAt
        && (now - new Date(prior.lastAlertAt).getTime()) >= REALERT_AFTER_MS;
      const isEscalation = flaggedNow && prior.flagged && prior.lastAlertAt
        && severity >= (prior.lastSeverity ?? 0) + ESCALATION_DELTA;

      if (isFirstFlag || isDailyReminder || isEscalation) {
        const reason = emergencyNow ? "EMERGENCY" : isEscalation ? "ESCALATION" : isFirstFlag ? "NEW" : "REMINDER";
        toAlert.push({ sym: s.sym, name: s.name, momentum, newsRisk, negHeadlines, price: quote.c, pct, reason });
        state[s.sym] = { flagged: true, lastAlertAt: new Date(now).toISOString(), lastSeverity: severity, lastNegCount: negCount };
      } else {
        state[s.sym] = {
          flagged: flaggedNow,
          lastAlertAt: flaggedNow ? prior.lastAlertAt : null,
          lastSeverity: flaggedNow ? (prior.lastSeverity ?? severity) : null,
          lastNegCount: flaggedNow ? (prior.lastNegCount ?? negCount) : 0,
        };
      }
    } catch (err) {
      console.error(`Skipping ${s.sym}: ${err.message}`);
    }
  }

  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");

  if (toAlert.length === 0) {
    console.log("No new risk alerts this run.");
    return;
  }

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !ALERT_EMAIL_TO) {
    console.log(`${toAlert.length} stock(s) newly flagged, but email isn't configured (GMAIL_USER/GMAIL_APP_PASSWORD/ALERT_EMAIL_TO). Flagged: ${toAlert.map(a => a.sym).join(", ")}`);
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  const hasEmergency = toAlert.some(a => a.reason === "EMERGENCY");
  const reasonLabel = { EMERGENCY: "EMERGENCY — sudden severe move", ESCALATION: "ESCALATION — got meaningfully worse since the last alert", NEW: "new risk flag", REMINDER: "still flagged (daily reminder)" };

  const lines = toAlert.map(a => {
    const headline = a.negHeadlines[0] ? `\n    Headline: "${a.negHeadlines[0]}"` : "";
    return `- [${reasonLabel[a.reason]}] ${a.sym} (${a.name}): $${a.price?.toFixed(2)} (${a.pct >= 0 ? "+" : ""}${a.pct?.toFixed(2)}% today), Momentum ${a.momentum}, News Risk ${a.newsRisk}${headline}`;
  });

  const text = [
    "MarketPulse alert — stocks where recent momentum has turned down and/or headlines/price action look severe.",
    "This is a heuristic reflecting past price/news data, not a prediction, forecast, or investment advice. Verify independently before acting.",
    "",
    ...lines,
    "",
    "https://voltagejpb.github.io/Stocks/market-pulse.html",
  ].join("\n");

  const subjectPrefix = hasEmergency ? "🚨 EMERGENCY" : "MarketPulse Risk Watch";
  await transporter.sendMail({
    from: GMAIL_USER,
    to: ALERT_EMAIL_TO,
    subject: `${subjectPrefix}: ${toAlert.map(a => a.sym).join(", ")}`,
    text,
  });

  console.log(`Sent alert email (${toAlert.map(a => `${a.sym}:${a.reason}`).join(", ")})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
