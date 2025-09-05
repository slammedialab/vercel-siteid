// lib/shopify.ts
export async function adminGraphQL(shop: string, adminToken: string, query: string, variables?: Record<string, any>) {
    const version = process.env.SHOPIFY_API_VERSION || '2025-07'; // <-- match 2025-07
    const r = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': adminToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, variables })
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Shopify GraphQL ${r.status} :: ${body.slice(0,300)}`);
    }
    return r.json();
  }
  