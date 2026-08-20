import type { HttpAdapter, HttpRequest, HttpResponse } from "../../src/core/adapters";

export interface StubRoute {
  status?: number;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
  /** When set, the request rejects with this message — a network failure, not a status. */
  fail?: string;
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
