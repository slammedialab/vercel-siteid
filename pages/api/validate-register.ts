// pages/api/validate-register.ts
import ids from '../../data/site-ids.json';
import { adminREST } from '../../lib/shopify';

const ID_SET = new Set<string>(ids as string[]);
const SHOP = process.env.SHOP as string;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN as string;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, firstName, lastName, siteId } = req.body || {};
  if (!email || !siteId) return res.json({ ok: false, error: 'Missing email or siteId' });

  const id = String(siteId).trim();
  if (!ID_SET.has(id)) return res.json({ ok: false, field: 'siteId', error: 'Invalid Site ID' });

  try {
    let customerId: number | null = null;

    // 1) Try to find existing by email
    const search = await adminREST(SHOP, ADMIN_TOKEN, `/customers/search.json`, {
      qs: { query: `email:${email}` }
    });
    customerId = search?.customers?.[0]?.id ?? null;

    // 2) Create if not found (with duplicate + post-create lookup fallback)
    if (!customerId) {
      try {
        const created = await adminREST(SHOP, ADMIN_TOKEN, `/customers.json`, {
          method: 'POST',
          body: {
            customer: {
              email,
              first_name: firstName || '',
              last_name: lastName || '',
              tags: 'approved',
              verified_email: true
            }
          }
        });

        customerId = created?.customer?.id ?? null;

        if (!customerId) {
          // Immediately search by email — sometimes creation returns no id but the record exists
          const check = await adminREST(SHOP, ADMIN_TOKEN, `/customers/search.json`, {
            qs: { query: `email:${email}` }
          });
          customerId = check?.customers?.[0]?.id ?? null;

          if (!customerId) {
            throw new Error(
              `Customer create returned no id; response: ${JSON.stringify(created).slice(0, 300)}`
            );
          }
        }
      } catch (e: any) {
        const msg = String(e?.message || '');
        // Duplicate/validation path: re-search by email and continue
        if (/already.*(taken|exists)/i.test(msg) || /email/i.test(msg)) {
          const again = await adminREST(SHOP, ADMIN_TOKEN, `/customers/search.json`, {
            qs: { query: `email:${email}` }
          });
          customerId = again?.customers?.[0]?.id ?? null;
        } else {
          return res.json({ ok: false, error: msg });
        }
      }
    }

    if (!customerId) {
      return res.json({ ok: false, error: 'Could not create or find customer' });
    }

    // 3) Ensure "approved" tag is present
    await ensureApprovedTag(customerId, search);

    // 4) Upsert metafields on the customer
    await upsertMetafield(customerId, 'custom', 'site_id', 'single_line_text_field', id);
    await upsertMetafield(customerId, 'custom', 'approved', 'boolean', 'true');

    return res.json({ ok: true });
  } catch (e: any) {
    console.error('register error:', e?.message);
    return res.json({ ok: false, error: e?.message || 'Server error' });
  }
}

async function ensureApprovedTag(customerId: number, initialSearch: any) {
  // If we already fetched the customer, try to reuse tags from there
  let existingTags = '';
  if (initialSearch?.customers?.[0]?.id === customerId) {
    existingTags = initialSearch.customers[0].tags || '';
  } else {
    // Fetch the single customer to read current tags
    const customerResp = await adminREST(
      SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`
    );
    existingTags = customerResp?.customer?.tags || '';
  }

  const tags = new Set(
    existingTags.split(',').map((t: string) => t.trim()).filter(Boolean)
  );

  if (!tags.has('approved')) {
    tags.add('approved');
    await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
      method: 'PUT',
      body: { customer: { id: customerId, tags: Array.from(tags).join(', ') } }
    });
  }
}

async function upsertMetafield(
  customerId: number,
  namespace: string,
  key: string,
  type: string,   // 'single_line_text_field' | 'boolean' | etc
  value: string
) {
  // list existing metafields for this customer
  const list = await adminREST(
    SHOP, ADMIN_TOKEN,
    `/customers/${customerId}/metafields.json`
  );

  const existing = (list?.metafields || []).find(
    (m: any) => m.namespace === namespace && m.key === key
  );

  if (!existing) {
    await adminREST(
      SHOP, ADMIN_TOKEN,
      `/customers/${customerId}/metafields.json`,
      {
        method: 'POST',
        body: { metafield: { namespace, key, type, value } }
      }
    );
  } else {
    await adminREST(
      SHOP, ADMIN_TOKEN,
      `/metafields/${existing.id}.json`,
      {
        method: 'PUT',
        body: { metafield: { id: existing.id, value, type } }
      }
    );
  }
}
