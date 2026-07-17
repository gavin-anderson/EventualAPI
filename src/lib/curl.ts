import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Some upstreams (notably Benzinga) sit behind a WAF that resets Node/undici's
 * TLS connection based on its JA3 fingerprint, so native `fetch` fails. The
 * system `curl` binary presents an accepted fingerprint, so we shell out to it
 * for those hosts. `--retry-all-errors` rides out the intermittent resets.
 *
 * Runtime dependency: `curl` must be on PATH (present by default on the Ubuntu
 * box and on Windows 10+; `curl.exe` there).
 */
const CURL = process.platform === "win32" ? "curl.exe" : "curl";

export interface CurlOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** curl --retry count (retries connection resets + transient HTTP errors). */
  retries?: number;
}

function baseArgs(opts: CurlOptions, timeoutMs: number): string[] {
  const args = [
    "-s", // no progress meter
    "--retry",
    String(opts.retries ?? 5),
    "--retry-all-errors", // retry on the WAF's connection resets
    "--retry-delay",
    "1",
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
  ];
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    args.push("-H", `${k}: ${v}`);
  }
  return args;
}

/** GET a URL via the system curl and parse the JSON body. */
export async function curlGetJson<T>(url: string, opts: CurlOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  // --fail-with-body: non-zero exit on HTTP >= 400, but keep the response body.
  const args = [...baseArgs(opts, timeoutMs), "--fail-with-body", "-H", "accept: application/json", url];

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(CURL, args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs + 5_000, // node-level backstop beyond curl's own --max-time
    }));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    const body = (e.stdout ?? "").slice(0, 300);
    // Note: never include `url` here — it carries the API token in the query.
    throw new Error(
      `curl request failed (exit ${e.code ?? "?"}): ${e.stderr || e.message}${body ? ` — ${body}` : ""}`,
    );
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`curl response was not valid JSON: ${stdout.slice(0, 200)}`);
  }
}
