// pages/api/admin-probe.ts
import { adminREST } from '../../lib/shopify';

const SHOP = process.env.SHOP as string;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN as string;

export default async function handler(_req: any, res: any) {
  const out: any = { shopEnv: SHOP };
  try {
    // 1) What shop does this token belong to?
    const shopResp = await adminREST(SHOP, ADMIN_TOKEN, '/shop.json');
    out.shopFromToken = shopResp?.shop?.myshopify_domain;

    // 2) Scopes check
    const scopes = await fetch(`https://${SHOP}/admin/oauth/access_scopes.json`, {
      headers: { 'X-Shopify-Access-Token': ADMIN_TOKEN }
    });
    out.scopesStatus = scopes.status;
    out.scopesText = (await scopes.text()).slice(0, 400);

    // 3) Strict search for your email (edit here if you want)
    const email = 'newuser+1@example.com';
    const search = await adminREST(SHOP, ADMIN_TOKEN, '/customers/search.json', {
      qs: { query: `email:"${email.toLowerCase()}"` }
    });
    out.searchExactEmail = (search?.customers?.[0]?.email || null);

    // 4) Raw POST to /customers.json and return the raw status + snippet
    const version = process.env.SHOPIFY_API_VERSION || '2025-04'; // safer pin
    const url = `https://${SHOP}/admin/api/${version}/customers.json`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': ADMIN_TOKEN,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        customer: {
          email,
          first_name: 'Probe',
          last_name: 'User',
          verified_email: true,
          tags: 'probe'
        }
      })
    });
    const text = await r.text();
    out.postStatus = r.status;
    out.postStatusText = r.statusText;
    out.postSnippet = text.slice(0, 400);
    out.requestId = r.headers.get('x-request-id');

    return res.json({ ok: true, ...out });
  } catch (e: any) {
    return res.json({ ok: false, error: String(e?.message || e), ...out });
  }
}
