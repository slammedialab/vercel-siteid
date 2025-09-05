// pages/api/validate-register.ts
import ids from '../../data/site-ids.json';
import { adminREST } from '../../lib/shopify';

const ID_SET = new Set<string>(ids as string[]);
const SHOP = process.env.SHOP as string;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN as string;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, firstName, lastName, siteId } = req.body || {};
  if (!email || !siteId) return res.json({ ok:false, error:'Missing email or siteId' });

  const id = String(siteId).trim();
  if (!ID_SET.has(id)) return res.json({ ok:false, field:'siteId', error:'Invalid Site ID' });

  try {
    // find existing
    const search = await adminREST(SHOP, ADMIN_TOKEN, `/customers/search.json`, {
      qs: { query: `email:${email}` }
    });
    let customerId: number | null = search?.customers?.[0]?.id ?? null;

    // create if missing
    if (!customerId) {
      const created = await adminREST(SHOP, ADMIN_TOKEN, `/customers.json`, {
        method: 'POST',
        body: { customer: { email, first_name: firstName || '', last_name: lastName || '', tags: 'approved' } }
      });
      customerId = created?.customer?.id ?? null;
      if (!customerId) throw new Error('Customer create failed');
    } else {
      // ensure tag
      const existing = search.customers[0];
      const tags = new Set((existing.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean));
      if (!tags.has('approved')) {
        tags.add('approved');
        await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
          method: 'PUT',
          body: { customer: { id: customerId, tags: Array.from(tags).join(', ') } }
        });
      }
    }

    // upsert metafields
    await upsertMetafield(customerId!, 'custom', 'site_id', 'single_line_text_field', id);
    await upsertMetafield(customerId!, 'custom', 'approved', 'boolean', 'true');

    return res.json({ ok: true });
  } catch (e: any) {
    console.error('register error:', e?.message);
    return res.json({ ok:false, error: e?.message || 'Server error' });
  }
}

async function upsertMetafield(
  customerId: number,
  namespace: string,
  key: string,
  type: string,
  value: string
) {
  const list = await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}/metafields.json`);
  const existing = (list?.metafields || []).find((m: any) => m.namespace === namespace && m.key === key);

  if (!existing) {
    await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}/metafields.json`, {
      method: 'POST',
      body: { metafield: { namespace, key, type, value } }
    });
  } else {
    await adminREST(SHOP, ADMIN_TOKEN, `/metafields/${existing.id}.json`, {
      method: 'PUT',
      body: { metafield: { id: existing.id, value, type } }
    });
  }
}
