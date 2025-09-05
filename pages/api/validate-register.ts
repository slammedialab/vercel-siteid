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
    // 1) Find existing
    let customerId = await findCustomerIdByEmail(email);

    // 2) Create if not found
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

        // Accept either shape: {customer:{...}} OR {customers:[{...}]}
        customerId =
          created?.customer?.id ??
          created?.customers?.[0]?.id ??
          null;

        // Fallback: tiny delay then re-search (eventual consistency)
        if (!customerId) {
          await sleep(350);
          customerId = await findCustomerIdByEmail(email);

          if (!customerId) {
            return res.json({
              ok: false,
              error: `Customer create returned no id. Response: ${JSON.stringify(created).slice(0, 300)}`
            });
          }
        }
      } catch (e: any) {
        const msg = String(e?.message || '');

        // Duplicate or validation errors: search and continue
        if (/already.*(taken|exists)/i.test(msg) || /email/i.test(msg)) {
          await sleep(200);
          customerId = await findCustomerIdByEmail(email);
          if (!customerId) {
            return res.json({ ok: false, error: `Duplicate email but not found via search. API said: ${msg}` });
          }
        } else {
          return res.json({ ok: false, error: msg });
        }
      }
    }

    if (!customerId) {
      return res.json({ ok: false, error: 'Could not create or find customer' });
    }

    // 3) Ensure "approved" tag present
    await ensureApprovedTag(customerId);

    // 4) Upsert metafields
    await upsertMetafield(customerId, 'custom', 'site_id', 'single_line_text_field', id);
    await upsertMetafield(customerId, 'custom', 'approved', 'boolean', 'true');

    return res.json({ ok: true });
  } catch (e: any) {
    console.error('register error:', e?.message);
    return res.json({ ok: false, error: e?.message || 'Server error' });
  }
}

async function findCustomerIdByEmail(email: string): Promise<number | null> {
  // Preferred: search endpoint with quoted email
  try {
    const quoted = await adminREST(SHOP, ADMIN_TOKEN, `/customers/search.json`, {
      qs: { query: `email:"${email}"` }
    });
    let id: number | null = quoted?.customers?.[0]?.id ?? null;
    if (id) return id;

    const unquoted = await adminREST(SHOP, ADMIN_TOKEN, `/customers/search.json`, {
      qs: { query: `email:${email}` }
    });
    id = unquoted?.customers?.[0]?.id ?? null;
    if (id) return id;
  } catch {
    // ignore and try the legacy route below
  }

  // Legacy fallback: /customers.json?email=...
  try {
    const legacy = await adminREST(SHOP, ADMIN_TOKEN, `/customers.json`, {
      qs: { email }
    });
    const id = legacy?.customers?.[0]?.id ?? null;
    return id ?? null;
  } catch {
    return null;
  }
}

async function ensureApprovedTag(customerId: number) {
  // Fetch single customer (ensures we have the current tags)
  const customerResp = await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`);
  const existingTags = customerResp?.customer?.tags || '';
  const tags = new Set(existingTags.split(',').map((t: string) => t.trim()).filter(Boolean));

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
  const list = await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}/metafields.json`);
  const existing = (list?.metafields || []).find(
    (m: any) => m.namespace === namespace && m.key === key
  );

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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
