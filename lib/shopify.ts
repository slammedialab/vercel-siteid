// lib/shopify.ts
export function apiVersion(): string {
    return process.env.SHOPIFY_API_VERSION || "2025-07";
  }
  
  export type RESTInit = Omit<RequestInit, "body" | "headers"> & {
    qs?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
    tries?: number;
  };
  
  function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
  
  export async function adminREST(
    shop: string,
    adminToken: string,
    path: string,
    init: RESTInit = {}
  ): Promise<any> {
    const version = apiVersion();
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`https://${shop}/admin/api/${version}${normalizedPath}`);
  
    if (init.qs) {
      for (const [k, v] of Object.entries(init.qs)) {
        if (v == null) continue;
        url.searchParams.set(k, String(v));
      }
    }
  
    const method = (init.method || "GET").toString().toUpperCase();
    let body: string | undefined = undefined;
  
    if (init.body != null && method !== "GET" && method !== "HEAD") {
      body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    }
  
    const headers: Record<string, string> = {
      "X-Shopify-Access-Token": adminToken,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    };
  
    const tries = typeof init.tries === "number" ? Math.max(0, init.tries) : 1;
    let attempt = 0;
  
    while (true) {
      const r = await fetch(url.toString(), {
        ...init,
        method,
        headers,
        body,
      });
  
      if ((r.status === 429 || r.status >= 500) && attempt < tries) {
        await sleep(300 * (attempt + 1));
        attempt++;
        continue;
      }
  
      const text = await r.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
  
      if (!r.ok) {
        const snippet = (text || "").slice(0, 400);
        throw new Error(`REST ${r.status} ${r.statusText} :: ${snippet}`);
      }
      return json;
    }
  }
  