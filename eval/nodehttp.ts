import type { HttpAdapter, HttpRequest, HttpResponse } from "../src/core/adapters";

/**
 * HttpAdapter over fetch with a real abort on timeout. Used by the env-gated
 * live provider test and by the eval harness's `--live` mode; it lives here
 * because both node adapters live in eval/.
 */
export class NodeHttp implements HttpAdapter {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer =
      req.timeoutMs !== undefined
        ? setTimeout(() => controller.abort(), req.timeoutMs)
        : undefined;
    try {
      const response = await fetch(req.url, {
        method: req.method ?? "GET",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      return { status: response.status, headers, bytes };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
