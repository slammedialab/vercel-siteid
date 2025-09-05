// lib/shopify.ts

/** Returns the Admin API version to use, defaulting to a current, supported one. */
export function apiVersion(): string {
    // Use your preferred default. It must be a valid Admin API version string.
    return process.env.SHOPIFY_API_VERSION || "2025-07";
  }
  
  /** Extra options we support on top of the Fetch RequestInit */
  export type RESTInit = Omit<RequestInit, "body" | "headers"> & {
    /** Querystring parameters appended to the URL */
    qs?: Record<string, string | number | boolean | null | undefined>;
    /** Body; will be JSON.stringified unless already a string */
    body?: unknown;
    /** Additional headers (merged after auth header) */
    headers?: Record<string, string>;
    /** Number of extra attempts on 429/5xx (default 1 => total 2 tries) */
    tries?: number;
  };
  
  /** Sleep helper for retry backoff */
  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
  
  /**
   * Minimal Admin REST helper.
   * Throws with a readable snippet on non-2xx.
   * Returns parsed JSON when possible, else null.
   */
  export async function adminREST(
    shop: string,
    adminToken: string,
    path: string, // e.g. "/customers.json" or "customers.json"
    init: RESTInit = {}
  ): Promise<any> {
    const version = apiVersion();
  
    // Normalize the path
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`https://${shop}/admin/api/${version}${normalizedPath}`);
  
    // Apply query params
    if (init.qs) {
      for (const [k, v] of Object.entries(init.qs)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
  
    // Decide method and body
    const method = (init.method || "GET").toString().toUpperCase();
    let body: string | undefined = undefined;
  
    if (init.body != null && method !== "GET" && method !== "HEAD") {
      body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    }
  
    // Headers
    const headers: Record<string, string> = {
      "X-Shopify-Access-Token": adminToken,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    };
  
    const tries = typeof init.tries === "number" ? Math.max(0, init.tries) : 1; // default 1 extra try
    let attempt = 0;
  
    // We intentionally don't pass init.body since we computed `body`
    // and we don't pass init.headers since we merged them into `headers`
    while (true) {
      const r = await fetch(url.toString(), {
        ...init,
        method,
        headers,
        body,
      });
  
      // Retry on rate limit / transient server errors
      if ((r.status === 429 || r.status >= 500) && attempt < tries) {
        // Simple backoff: 300ms * (attempt + 1)
        await sleep(300 * (attempt + 1));
        attempt++;
        continue;
      }
  
      // Try to parse body safely
      const text = await r.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON; leave as null and rely on status below.
      }
  
      if (!r.ok) {
        const snippet = (text || "").slice(0, 400);
        throw new Error(`REST ${r.status} ${r.statusText} :: ${snippet}`);
      }
  
      // Success
      return json;
    }
  }
  