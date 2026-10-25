# Replacing Benzinga for the earnings schedule

> **Status (2026-10-25): decided and implemented.** Alpha Vantage (free personal
> key) plus SEC EDGAR replaced Benzinga; the "Code change" section below is now in
> `src/lib/alphavantage.ts`, `src/lib/edgar.ts` and the earnings jobs. A commercial
> licence is still needed before public launch. Current behaviour is described in
> [EARNINGS_DATA.md](EARNINGS_DATA.md); this file is kept as the decision record.

Checked 2026-10-25 against our 61 `equity` assets in Supabase. **Verified** = I ran
it live today. **Assumed** = from docs/search or inference, not tested.

## Recommendation

**Alpha Vantage for the schedule + EPS, SEC EDGAR for exact release times.**

| Need | Source | Why |
|---|---|---|
| Upcoming date + BMO/AMC + EPS estimate | Alpha Vantage `EARNINGS_CALENDAR` | One CSV call returns the whole US market for 3 months, so 1 call/day covers the daily sync |
| History (3y): date, EPS actual/estimate/surprise, BMO/AMC | Alpha Vantage `EARNINGS` (per ticker) | Same vendor, replaces `fetchHistoricalEarnings` |
| Exact release time (history, and "results are out" on the day) | SEC EDGAR 8-K Item 2.02 `acceptanceDateTime` | Free, public-domain, to the second |

Exact *scheduled* time before the release isn't available from any affordable feed
I found; the app keeps showing "after market close" until EDGAR stamps the real time.

## What I tested

**Alpha Vantage calendar** (Verified, demo key, full-market CSV, 4,270 rows):
46/61 of our tickers have an upcoming date, 29 of those with `pre-market`/`post-market`.
The 17 blank sessions are all 11+ days out (e.g. IREN 11-05, NVDA 11-18, ORCL 12-09),
so the session fills in as the date nears (Assumed; it's how the imminent job already works).
The 15 missing: ASML, TSM, NFLX, META, TSLA, IBM, WDC, BX, BE already reported this
month (Nasdaq shows them Oct 14-22), so they're simply outside the window; BMNR and
the 5 non-US names (HYUNDAI, IBIDEN, KIOXIA, SMSN, SOFTBANK) have no coverage.

**Nasdaq calendar** (Verified, keyless): identical dates and sessions to Alpha Vantage
for all 46 tickers, so AV appears to resell the same feed. Not usable directly: no API
licence, and it's a site endpoint, not a product.

**Alpha Vantage history** (Verified for IBM only, demo key is IBM-only): 123 quarters
back to 1996 with `reportedEPS`, `estimatedEPS`, `surprisePercentage`, `reportTime`.
Coverage of our other tickers is Assumed until we have a real key.

**SEC EDGAR** (Verified): 51/61 tickers have 8-K Item 2.02 filings with timestamps,
e.g. AAPL 2026-07-30 20:30:28Z (Apple's 4:30 PM ET release), META 2026-10-21 20:03:35Z.
Gaps: ARM, ASML, BABA, NBIS, TSM file 6-Ks (no item codes, needs title filtering);
the 5 non-US names aren't SEC filers. Filing time trails the press release by seconds
to a few minutes (Assumed from the AAPL/IBM examples). A few 2.02s aren't quarterly
results (TSLA 10-02, EBAY 10-22 look like pre-announcements), so match each to the
calendar date rather than trusting every 2.02.

**Finnhub, FMP** (Verified only that both 401 without a key). Not tested further:
both need a sign-up, which I can't do.

## Licences (the real constraint)

Every free tier forbids showing data to app users:

- **Alpha Vantage**: free key is "personal, non-commercial use"; providing info "to
  individuals or entities other than User" counts as commercial (ToS PDF, Verified).
  Premium is $49.99/mo (75 req/min) published; commercial use needs a written
  agreement via premium@alphavantage.co, price unpublished.
- **Finnhub**: "strictly for personal use unless explicitly stated otherwise" and no
  redistribution without written approval (ToS, Verified). Commercial is quote-only;
  a competitor lists the All-in-One plan at $3,500/mo (Assumed).
- **FMP**: personal plans $22-149/mo; display needs a separate Data Display and
  Licensing Agreement (Assumed, via search; their site 403s to me).
- **Massive (Polygon)** resells Benzinga earnings as partner data, quote-only (Assumed).
- **SEC EDGAR**: public domain, free; just send a `User-Agent` with contact email and
  stay under 10 req/s.

So the decision is which vendor gives the cheapest **written display licence**. AV is
my pick because its data is verified to cover us, one call/day fits the smallest tier,
and it covers history too. FMP is the fallback if AV's quote is high.

## Code change once a source is chosen

- New `src/lib/alphavantage.ts` mapping to the existing `EarningsEventRow`
  (`pre-market`→`bmo`, `post-market`→`amc`, blank→`session` null). Period/year come
  from `fiscalDateEnding`, which is a real fiscal quarter, unlike the current
  `deriveQuarter` fallback.
- New `src/lib/edgar.ts`: ticker→CIK map, 8-K 2.02 lookups. `refreshImminentEarnings`
  polls EDGAR for imminent tickers and, on a new 2.02, sets `time_precision='exact'`
  with the acceptance time. That's also the push-notification hook.
- `syncEarningsHistory` takes `reported_at` from EDGAR when it matches, else the
  session default; `source` becomes `alphavantage` / `edgar`.
- Non-US 5 + BMNR: manual entry in `earnings_events` for now.

No prior Finnhub code (`syncFinnhubEarnings.ts`, `finnhub.ts`) or `INTEGRATION_PLAN.md`
exists on this machine; I searched Documents, OneDrive and Downloads.
