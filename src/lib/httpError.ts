/**
 * Small typed HTTP error. Thrown from routes/middleware and rendered by the
 * central error handler into a stable JSON shape: { error, message }.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly expose: boolean;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    // 4xx messages are safe to show the client; 5xx are not.
    this.expose = status < 500;
  }
}

export const badRequest = (msg?: string) => new HttpError(400, "bad_request", msg);
export const unauthorized = (msg?: string) => new HttpError(401, "unauthorized", msg);
export const forbidden = (msg?: string) => new HttpError(403, "forbidden", msg);
export const notFound = (msg?: string) => new HttpError(404, "not_found", msg);
export const serviceUnavailable = (code: string, msg?: string) =>
  new HttpError(503, code, msg);
