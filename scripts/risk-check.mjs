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
  if (!Array.isArray(articles) || articles.length === 0) return { score: null, negHeadlines: [] };
  let neg = 0, pos = 0;
  const negHeadlines = [];
  for (const a of articles.slice(0, 25)) {
    const text = `${a.headline || ""} ${a.summary || ""}`.toLowerCase();
    let hit = false;
    for (const kw of keywords.negative) { if (text.includes(kw)) { neg++; hit = true; } }
    for (const kw of keywords.positive) { if (text.includes(kw)) pos++; }
    if (hit && negHeadlines.length < 3) negHeadlines.push(a.headline);
  }
  const net = neg - pos;
  return { score: Math.round(clampScore(net, 6)), negHeadlines };
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
      const { score: newsRisk, negHeadlines } = computeNewsRisk(news, keywords);
      const combined = momentum !== null && momentum < MOMENTUM_DOWN_THRESHOLD
                     && newsRisk !== null && newsRisk >= NEWS_RISK_THRESHOLD;

      const prior = state[s.sym] || { risk: false, lastAlertAt: null };
      const isNewRisk = combined && !prior.risk;
      const isStaleReminder = combined && prior.risk && prior.lastAlertAt
        && (now - new Date(prior.lastAlertAt).getTime()) >= REALERT_AFTER_MS;

      if (isNewRisk || isStaleReminder) {
        toAlert.push({ sym: s.sym, name: s.name, momentum, newsRisk, negHeadlines, price: quote.c, pct: quote.dp });
        state[s.sym] = { risk: true, lastAlertAt: new Date(now).toISOString() };
      } else {
        state[s.sym] = { risk: combined, lastAlertAt: combined ? prior.lastAlertAt : null };
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

  const lines = toAlert.map(a => {
    const headline = a.negHeadlines[0] ? `\n    Headline: "${a.negHeadlines[0]}"` : "";
    return `- ${a.sym} (${a.name}): $${a.price?.toFixed(2)} (${a.pct >= 0 ? "+" : ""}${a.pct?.toFixed(2)}% today), Momentum ${a.momentum}, News Risk ${a.newsRisk}${headline}`;
  });

  const text = [
    "MarketPulse Risk Watch — stocks where recent momentum has turned down AND headlines skew negative.",
    "This is a heuristic reflecting past price/news data, not a prediction, forecast, or investment advice. Verify independently before acting.",
    "",
    ...lines,
    "",
    "https://voltagejpb.github.io/Stocks/market-pulse.html",
  ].join("\n");

  await transporter.sendMail({
    from: GMAIL_USER,
    to: ALERT_EMAIL_TO,
    subject: `MarketPulse Risk Watch: ${toAlert.map(a => a.sym).join(", ")}`,
    text,
  });

  console.log(`Sent risk alert email for: ${toAlert.map(a => a.sym).join(", ")}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
