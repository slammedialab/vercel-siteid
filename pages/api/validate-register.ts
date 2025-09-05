// pages/api/validate-register.ts
import ids from '../../data/site-ids.json';
import { adminREST } from '../../lib/shopify';

const SHOP = process.env.SHOP as string;           // e.g. centeringhealthcare.myshopify.com
const ADMIN_TOKEN = process.env.ADMIN_TOKEN as string;

const ID_SET = new Set<string>(ids as string[]);

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, firstName, lastName, siteId } = req.body || {};
  if (!email || !siteId) return res.json({ ok: false, error: 'Missing email or siteId' });

  const idStr = String(siteId).trim();
  if (!ID_SET.has(idStr)) return res.json({ ok: false, field: 'siteId', error: 'Invalid Site ID' });

  try {
    let customerId = await findCustomerIdByEmailExact(email);
    let action: 'created' | 'updated' | 'found' = 'found';

    if (!customerId) {
      // CREATE — trust only the response ID; if absent, fail (do not search)
      const created = await adminREST(SHOP, ADMIN_TOKEN, `/customers.json`, {
        method: 'POST',
        body: {
          customer: {
            email,
            first_name: firstName || '',
            last_name: lastName || '',
            verified_email: true,
            tags: 'approved'
          }
        }
      });

      customerId = created?.customer?.id ?? null;

      if (!customerId) {
        return res.json({
          ok: false,
          error: `Customer create returned no id`,
          debug: {
            shop: SHOP,
            createRespSnippet: JSON.stringify(created).slice(0, 400)
          }
        });
      }
      action = 'created';
    } else {
      // UPDATE names (safe no-op if same)
      await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
        method: 'PUT',
        body: { customer: { id: customerId, first_name: firstName || '', last_name: lastName || '' } }
      });
      action = 'updated';
    }

    // HARD CONFIRM — fetch by ID and assert email matches
    const confirm = await getCustomerById(customerId);
    if (!confirm) {
      return res.json({ ok: false, error: `Created/updated id ${customerId} not retrievable`, shop: SHOP });
    }
    const foundEmail = (confirm.email || '').toLowerCase();
    if (foundEmail !== String(email).toLowerCase()) {
      return res.json({
        ok: false,
        error: `ID/email mismatch. ID ${customerId} belongs to ${confirm.email || '(no email)'}`,
        debug: { expectedEmail: email, foundEmail: confirm.email, shop: SHOP }
      });
    }

    // TAGS — ensure approved + unique debug tag to find easily in Admin
    const debugTag = `debug-${Date.now()}`;
    await mergeTags(customerId, ['approved', debugTag]);

    // METAFIELDS — correct keys
    await upsertMetafield(customerId, 'custom', 'custom_site_id', 'single_line_text_field', idStr);
    await upsertMetafield(customerId, 'custom', 'approved', 'boolean', 'true');

    return res.json({ ok: true, action, customerId, email, siteId: idStr, shop: SHOP });
  } catch (e: any) {
    return res.json({ ok: false, error: String(e?.message || e), shop: SHOP });
  }
}

/* ---------------- helpers (STRICT) ---------------- */

async function findCustomerIdByEmailExact(email: string): Promise<number | null> {
  // Only exact, quoted search. Validate returned email matches exactly.
  try {
    const resp = await adminREST(SHOP, ADMIN_TOKEN, `/customers/search.json`, {
      qs: { query: `email:"${email}"` }
    });
    const c = resp?.customers?.[0];
    if (c && (c.email || '').toLowerCase() === String(email).toLowerCase()) {
      return c.id as number;
    }
    return null;
  } catch {
    return null;
  }
}

async function getCustomerById(customerId: number) {
  const resp = await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`);
  return resp?.customer || null;
}

async function mergeTags(customerId: number, toAdd: string[]) {
  const current = await getCustomerById(customerId);
  const existingTags = (current?.tags || '')
    .split(',')
    .map((t: string) => t.trim())
    .filter(Boolean);
  const set = new Set(existingTags);
  for (const t of toAdd) set.add(t);
  await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
    method: 'PUT',
    body: { customer: { id: customerId, tags: Array.from(set).join(', ') } }
  });
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
      body: { metafield: { id: existing.id, type, value } }
    });
  }
}
