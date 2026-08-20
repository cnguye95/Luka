import { requestUrl } from "obsidian";
import type { HttpAdapter, HttpRequest, HttpResponse } from "../core/adapters";

/**
 * HttpAdapter over Obsidian's requestUrl, which bypasses renderer CORS.
 * It offers no abort, so a timeout stops waiting but cannot cancel the request.
 */
export class ObsidianHttp implements HttpAdapter {
  async request(request: HttpRequest): Promise<HttpResponse> {
    const call = requestUrl({
      url: request.url,
      method: request.method ?? "GET",
      headers: request.headers,
      body: request.body,
      // Status codes are data the image filters inspect, not exceptions.
      throw: false,
    });

    const response =
      request.timeoutMs === undefined
        ? await call
        : await withTimeout(call, request.timeoutMs, request.url);

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      headers[name.toLowerCase()] = value;
    }

    return { status: response.status, headers, bytes: new Uint8Array(response.arrayBuffer) };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, url: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`request timed out after ${ms}ms: ${url}`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
