// lib/shopify.ts

export function apiVersion() {
    return process.env.SHOPIFY_API_VERSION || '2025-07';
  }
  
  // Allow JSON objects for body
  type RESTInit = Omit<RequestInit, 'body'> & {
    qs?: Record<string, string>;
    body?: any; // we'll JSON.stringify if it's not a string
  };
  
  export async function adminREST(
    shop: string,
    adminToken: string,
    path: string,            // e.g. `/customers.json`
    init?: RESTInit
  ) {
    const version = apiVersion();
    const url = new URL(`https://${shop}/admin/api/${version}${path}`);
  
    if (init?.qs) {
      for (const [k, v] of Object.entries(init.qs)) url.searchParams.set(k, v);
    }
  
    const body =
      init?.body == null
        ? undefined
        : typeof init.body === 'string'
        ? init.body
        : JSON.stringify(init.body);
  
    const r = await fetch(url.toString(), {
      method: init?.method || 'GET',
      headers: {
        'X-Shopify-Access-Token': adminToken,
        'Content-Type': 'application/json'
      },
      body
    });
  
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  
    if (!r.ok) {
      const snippet = text?.slice(0, 400);
      throw new Error(`REST ${r.status} ${r.statusText} :: ${snippet}`);
    }
  
    return json;
  }
  