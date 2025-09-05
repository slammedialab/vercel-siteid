// lib/shopify.ts
export function apiVersion() {
    return process.env.SHOPIFY_API_VERSION || '2025-07';
  }
  
  export async function adminREST(
    shop: string,
    adminToken: string,
    path: string, // e.g. `/customers.json`
    init?: RequestInit & { qs?: Record<string, string> }
  ) {
    const version = apiVersion();
    const url = new URL(`https://${shop}/admin/api/${version}${path}`);
    if (init?.qs) {
      for (const [k, v] of Object.entries(init.qs)) url.searchParams.set(k, v);
    }
  
    const r = await fetch(url.toString(), {
      method: init?.method || 'GET',
      headers: {
        'X-Shopify-Access-Token': adminToken,
        'Content-Type': 'application/json'
      },
      body: init?.body
        ? typeof init.body === 'string'
          ? init.body
          : JSON.stringify(init.body)
        : undefined
    });
  
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  
    if (!r.ok) {
      const snippet = text?.slice(0, 400);
      throw new Error(`REST ${r.status} ${r.statusText} :: ${snippet}`);
    }
    return json;
  }
  