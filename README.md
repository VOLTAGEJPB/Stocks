# Stocks

## MarketPulse

`market-pulse.html` is a live stock dashboard, served via GitHub Pages at
https://voltagejpb.github.io/Stocks/market-pulse.html. Paste in a free
[Finnhub](https://finnhub.io/) API key to connect it.

- **Momentum Score** — a weighted blend of real 5-day, month-to-date,
  13-week, and 26-week price returns plus position in the 52-week range.
  The board sorts by it and a "Trending Up" strip surfaces the top movers.
- **Risk Watch** — flags a stock when its Momentum Score has turned down
  *and* its last 7 days of headlines skew negative on a keyword count, or
  immediately on its own for a severe single-day price move (🚨
  EMERGENCY). Fires a browser notification while the page is open.

Neither is a prediction, probability, or forecast — both are transparent
reads of real, past price and news data. Not investment advice.

### Email alerts even when the page is closed

A GitHub Actions workflow (`.github/workflows/risk-alert.yml`) runs
`scripts/risk-check.mjs` on a schedule (every 30 minutes, roughly US
market hours, Mon-Fri) to check the same Risk Watch signal server-side
and email you. State is tracked in `state/risk-state.json` so alerts
aren't repeated needlessly, but nothing big gets stuck waiting behind a
quiet period either — an email goes out when:

- a stock **newly** flags (Risk Watch or Emergency),
- a flagged stock **escalates** — gets meaningfully worse than it was at
  the last alert (further price drop, more negative headlines, momentum
  still sliding) — sent immediately, not held for the next scheduled
  reminder, and
- a flagged stock is still flagged after 24 hours, as a reminder that it
  hasn't resolved.

A sudden, severe move (roughly a 7%+ single-day drop, or a fresh burst of
negative-keyword headlines) is always treated as an emergency and emailed
right away, whether or not the stock was already on the radar.

This needs a few things set up in the repo that only a repo owner/admin
can do (Claude can't create secrets or your email credentials):

1. **Get a free Finnhub API key**: https://finnhub.io/register
2. **Create a Gmail App Password** (needed because Gmail blocks plain
   password login for scripts):
   - Turn on 2-Step Verification on your Google Account, if not already on:
     https://myaccount.google.com/security
   - Go to https://myaccount.google.com/apppasswords, create an app
     password (name it e.g. "MarketPulse Alerts"), and copy the 16-character
     password it gives you.
3. **Add these as repo secrets** — go to this repo's
   **Settings → Secrets and variables → Actions → New repository secret**
   and add:
   - `FINNHUB_API_KEY` — the key from step 1
   - `GMAIL_USER` — the Gmail address you'll send *from* (can be the same
     as the address you want to receive alerts at)
   - `GMAIL_APP_PASSWORD` — the 16-character app password from step 2
   - `ALERT_EMAIL_TO` — the address you want alerts sent *to* (e.g.
     `joel.perez5588@gmail.com`)
4. Once the secrets are set, the workflow will start running on its own
   schedule. You can also trigger it manually any time from the repo's
   **Actions** tab → "MarketPulse Risk Alert" → **Run workflow**.

Scheduled workflows are automatically disabled by GitHub after 60 days
of repo inactivity — if alerts stop, re-enable it from the Actions tab.

### Paper trading (simulated — no real money)

The same scheduled script also runs a simple, fully simulated trading rule
against [Alpaca](https://alpaca.markets/)'s **paper trading** API: no real
money, no real brokerage account, no real orders — Alpaca just simulates
fills against live prices so a rule can be tracked honestly over time.

**The rule**: buy $1,000 (simulated) worth of a stock when its Momentum
Score crosses into "Strong Up" (≥65). Sell after ~5 trading days, or
sooner if Risk Watch flags that stock. Results — win rate, average
return, open positions — are tracked in `state/paper-trades.json`, shown
in a "📊 Paper Trading" panel on the page, and included in the alert email
whenever a simulated trade opens or closes. These are real (paper) trade
outcomes, not an invented number — and past paper-trade results are not a
guarantee of future performance, paper or otherwise.

To turn this on, get free paper-trading API keys from Alpaca (sign up at
https://alpaca.markets/, then generate keys from the **paper trading**
dashboard — never the live-money one) and add two more repo secrets the
same way as above:

- `ALPACA_API_KEY_ID`
- `ALPACA_API_SECRET_KEY`

Without these two secrets, the paper-trading step is skipped entirely —
the rest of MarketPulse (Momentum Score, Risk Watch, email alerts) works
the same either way.
