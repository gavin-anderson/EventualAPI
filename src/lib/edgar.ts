import { config } from "../config/env.js";
import { etDateOf } from "./datetime.js";

/**
 * SEC EDGAR: the exact moment results came out, and each company's fiscal year.
 *
 * Companies file an 8-K with Item 2.02 ("Results of Operations") when they
 * release earnings; its `acceptanceDateTime` is to the second and trails the
 * press release by seconds to minutes. EDGAR is public domain and free, with a
 * fair-access cap of 10 requests/second and a request for a descriptive
 * User-Agent (SEC_USER_AGENT, ideally with a contact email).
 *
 * Foreign private issuers (ARM, ASML, BABA, NBIS, TSM) file 6-Ks, which carry no
 * item codes, so they get no exact time here and keep their session slot.
 */

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SUBMISSIONS_URL = "https://data.sec.gov/submissions";
const REQUEST_TIMEOUT_MS = 20_000;

export interface Submissions {
  /** "MMDD" of the fiscal year end, e.g. "0926" for Apple. */
  fiscalYearEnd: string | null;
  /** acceptanceDateTime (UTC ISO) of every recent 8-K carrying Item 2.02, newest first. */
  earningsReleases: string[];
}

interface SubmissionsResponse {
  fiscalYearEnd?: string | null;
  filings: {
    recent: {
      form: string[];
      items: string[];
      acceptanceDateTime: string[];
    };
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": config.sec.userAgent, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`EDGAR HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

let cikMap: Promise<Map<string, string>> | null = null;

/** Ticker → zero-padded 10-digit CIK. Fetched once per process. */
export function tickerToCik(): Promise<Map<string, string>> {
  cikMap ??= getJson<Record<string, { cik_str: number; ticker: string }>>(TICKERS_URL)
    .then((data) => new Map(
      Object.values(data).map((c) => [c.ticker.toUpperCase(), String(c.cik_str).padStart(10, "0")]),
    ))
    .catch((err) => { cikMap = null; throw err; });
  return cikMap;
}

/** Submissions for a ticker, or null when it isn't an SEC filer. */
export async function fetchSubmissions(ticker: string): Promise<Submissions | null> {
  const cik = (await tickerToCik()).get(ticker.toUpperCase());
  if (!cik) return null;
  const data = await getJson<SubmissionsResponse>(`${SUBMISSIONS_URL}/CIK${cik}.json`);
  const r = data.filings.recent;
  const earningsReleases: string[] = [];
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] === "8-K" && (r.items[i] ?? "").split(",").includes("2.02")) {
      earningsReleases.push(new Date(r.acceptanceDateTime[i]!).toISOString());
    }
  }
  return { fiscalYearEnd: data.fiscalYearEnd ?? null, earningsReleases };
}

/**
 * The earnings release filed on a given ET calendar day, if any. Matching on the
 * report date (rather than taking any 2.02) skips pre-announcements and other
 * off-cycle 2.02 filings. Earliest wins if a company filed twice that day.
 */
export function releaseOn(releases: string[], etDate: string): string | null {
  const sameDay = releases.filter((iso) => etDateOf(iso) === etDate).sort();
  return sameDay[0] ?? null;
}

/**
 * Fiscal quarter label for a quarter ending on `fiscalDateEnding`, given the
 * company's fiscal year end ("MMDD"). Apple (FY ends late Sep): quarter ending
 * 2026-09-30 → Q4 2026; ending 2026-12-31 → Q1 2027. NVIDIA (FY ends late Jan):
 * quarter ending 2026-10-31 → Q3 2027.
 *
 * 52/53-week years that end in the first week of a month (e.g. "0102") belong to
 * the previous month. Without a fiscal year end we fall back to calendar quarters.
 */
export function fiscalPeriod(
  fiscalDateEnding: string,
  fiscalYearEnd: string | null,
): { period: string; periodYear: number } {
  const year = Number(fiscalDateEnding.slice(0, 4));
  const month = Number(fiscalDateEnding.slice(5, 7));
  let fyMonth = 12;
  if (fiscalYearEnd && /^\d{4}$/.test(fiscalYearEnd)) {
    fyMonth = Number(fiscalYearEnd.slice(0, 2));
    if (Number(fiscalYearEnd.slice(2)) <= 7) fyMonth = fyMonth === 1 ? 12 : fyMonth - 1;
  }
  const monthsIntoFy = (month - fyMonth + 11) % 12; // 0..11, 11 = the FY's last month
  const quarter = Math.floor(monthsIntoFy / 3) + 1;
  return { period: `Q${quarter}`, periodYear: month > fyMonth ? year + 1 : year };
}
