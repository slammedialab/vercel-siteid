export async function adminGraphQL(
    shop: string,
    adminToken: string,
    query: string,
    variables?: Record<string, any>
  ) {
    const r = await fetch(`https://${shop}/admin/api/2024-07/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': adminToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, variables })
    });
    if (!r.ok) throw new Error(`Shopify GraphQL ${r.status}`);
    return r.json();
  }
  