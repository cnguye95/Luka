// HttpAdapter stubs: one routed by URL, recording each URL asked for, and one
// that replays a scripted sequence of responses in order for retry paths,
// recording every request it was handed.
import type { HttpAdapter, HttpRequest, HttpResponse } from "../../src/core/adapters";
import { utf8 } from "../../src/core/hash";

export interface StubRoute {
  status?: number;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
  /** When set, the request rejects with this message — a network failure, not a status. */
  fail?: string;
}

/** A route whose body is `value` as JSON — what an API endpoint would send. */
export function jsonRoute(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): StubRoute {
  return { status, headers, bytes: utf8(JSON.stringify(value)) };
}

/**
 * HttpAdapter that answers each request with the next scripted response, in
 * order, regardless of URL — for retry sequences like 429-then-200. Captures
 * every request so tests can assert on bodies and headers.
 */
export class ScriptedHttp implements HttpAdapter {
  readonly requests: HttpRequest[] = [];
  private cursor = 0;

  constructor(private readonly script: StubRoute[]) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const route = this.script[this.cursor];
    if (!route) throw new Error(`ScriptedHttp: script exhausted after ${this.cursor} response(s)`);
    this.cursor += 1;
    if (route.fail !== undefined) throw new Error(route.fail);
    return {
      status: route.status ?? 200,
      headers: route.headers ?? {},
      bytes: route.bytes ?? new Uint8Array(),
    };
  }
}

/** HttpAdapter stub. Unrouted URLs reject, standing in for DNS failure. */
export class StubHttp implements HttpAdapter {
  readonly requests: string[] = [];

  constructor(private readonly routes: Record<string, StubRoute> = {}) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req.url);
    const route = this.routes[req.url];
    if (!route) throw new Error(`getaddrinfo ENOTFOUND (unrouted: ${req.url})`);
    if (route.fail !== undefined) throw new Error(route.fail);
    return {
      status: route.status ?? 200,
      headers: route.headers ?? {},
      bytes: route.bytes ?? new Uint8Array(),
    };
  }
}
