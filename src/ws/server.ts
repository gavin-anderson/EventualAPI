import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import { logger } from "../lib/logger.js";
import * as hub from "./priceHub.js";

/**
 * Anonymous price WebSocket, attached to the same http.Server as the REST API on
 * path /v1/ws/prices. Speaks a tiny JSON protocol (raw RFC-6455 frames — the iOS
 * client uses URLSessionWebSocketTask, so no socket.io framing).
 *
 * Client → server:  {type:"subscribe"|"unsubscribe", tickers:[…]}, {type:"ping"}
 * Server → client:  {type:"subscribed"|"unsubscribed", tickers},
 *                   {type:"quote", ticker, coin, price, changePct, asOf},
 *                   {type:"pong"}, {type:"error", error, message}
 *
 * SCALING CAVEAT: subscription state and the poll loop are in-process. Behind >1
 * replica, each instance polls Hyperliquid independently and fans out only to its
 * own clients (correct, but upstream HL calls scale with replica count).
 * Horizontal scale needs sticky WS routing or a shared pub/sub fronting one poller.
 */

const VALID_TICKER = /^[A-Za-z0-9.-]{1,15}$/;

export function attachPriceWs(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/v1/ws/prices" });

  // Liveness tracking for the heartbeat below.
  const alive = new WeakSet<WebSocket>();

  wss.on("connection", (ws) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    ws.on("message", (data) => {
      void handleMessage(ws, data.toString());
    });
    ws.on("close", () => hub.drop(ws));
    ws.on("error", (err) => {
      logger.warn({ err }, "ws connection error");
      hub.drop(ws);
    });
  });

  // Reap half-open sockets: ping every 30s, terminate anything that missed the
  // previous round's pong.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref?.();
  wss.on("close", () => clearInterval(heartbeat));

  logger.info({ path: "/v1/ws/prices" }, "price websocket attached");
  return wss;
}

async function handleMessage(ws: WebSocket, raw: string): Promise<void> {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return send(ws, { type: "error", error: "bad_message", message: "invalid JSON" });
  }
  if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
    return send(ws, { type: "error", error: "bad_message", message: "missing type" });
  }

  const m = msg as { type: string; tickers?: unknown };
  switch (m.type) {
    case "ping":
      return send(ws, { type: "pong" });

    case "subscribe": {
      const tickers = sanitizeTickers(m.tickers);
      if (!tickers.length) {
        return send(ws, { type: "error", error: "bad_message", message: "no valid tickers" });
      }
      await hub.subscribe(ws, tickers);
      return send(ws, { type: "subscribed", tickers });
    }

    case "unsubscribe": {
      const tickers = sanitizeTickers(m.tickers);
      await hub.unsubscribe(ws, tickers);
      return send(ws, { type: "unsubscribed", tickers });
    }

    default:
      return send(ws, { type: "error", error: "bad_message", message: `unknown type: ${m.type}` });
  }
}

function sanitizeTickers(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    if (typeof t === "string" && VALID_TICKER.test(t)) out.push(t.toUpperCase());
  }
  return [...new Set(out)];
}

function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
