// pages/api/validate-register.ts
import ids from '../../data/site-ids.json';
import { adminREST } from '../../lib/shopify';

const SHOP = process.env.SHOP as string;           // e.g. centeringhealthcare.myshopify.com
const ADMIN_TOKEN = process.env.ADMIN_TOKEN as string;

const ID_SET = new Set<string>(ids as string[]);

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, firstName, lastName, siteId } = req.body || {};
  if (!email || !siteId) {
    return res.json({ ok: false, error: 'Missing email or siteId' });
  }

  const idStr = String(siteId).trim();
  if (!ID_SET.has(idStr)) {
    return res.json({ ok: false, field: 'siteId', error: 'Invalid Site ID' });
  }

  try {
    let customerId = await findCustomerIdByEmail(email);
    let action: 'created' | 'updated' | 'found' = 'found';

    if (!customerId) {
      // Create
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

      customerId = created?.customer?.id ?? created?.customers?.[0]?.id ?? null;

      if (!customerId) {
        await sleep(350); // eventual consistency
        customerId = await findCustomerIdByEmail(email);
        if (!customerId) {
          return res.json({
            ok: false,
            error: `Customer create returned no id. Response: ${JSON.stringify(created).slice(0, 300)}`
          });
        }
      }
      action = 'created';
    } else {
      // Update core fields
      await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
        method: 'PUT',
        body: {
          customer: {
            id: customerId,
            first_name: firstName || '',
            last_name: lastName || ''
          }
        }
      });
      action = 'updated';
    }

    // --- HARD CONFIRM: read back by ID and assert email matches ---
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

    // Ensure tags: approved + debug tag
    const debugTag = `debug-${Date.now()}`;
    await mergeTags(customerId, ['approved', debugTag]);

    // Upsert metafields
    await upsertMetafield(customerId, 'custom', 'custom_site_id', 'single_line_text_field', idStr); // ✅ correct key
    await upsertMetafield(customerId, 'custom', 'approved', 'boolean', 'true');

    // Done
    return res.json({
      ok: true,
      action,
      customerId,
      email,
      siteId: idStr,
      shop: SHOP
    });
  } catch (e: any) {
    console.error('validate-register error:', e?.message || e);
    return res.json({ ok: false, error: e?.message || 'Server error', shop: SHOP });
  }
}

/* ---------------- helpers ---------------- */

async function findCustomerIdByEmail(email: string): Promise<number | null> {
  try {
    const quoted = await adminREST(SHOP, ADMIN_TOKEN, `/customers/search.json`, {
      qs: { query: `email:"${email}"` }
    });
    let id = quoted?.customers?.[0]?.id ?? null;
    if (id) return id;

    const unquoted = await adminREST(SHOP, ADMIN_TOKEN, `/customers/search.json`, {
      qs: { query: `email:${email}` }
    });
    id = unquoted?.customers?.[0]?.id ?? null;
    if (id) return id;
  } catch {
    // fall through
  }

  try {
    const legacy = await adminREST(SHOP, ADMIN_TOKEN, `/customers.json`, { qs: { email } });
    return legacy?.customers?.[0]?.id ?? null;
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

  const newTags = Array.from(set).join(', ');
  await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
    method: 'PUT',
    body: { customer: { id: customerId, tags: newTags } }
  });
}

async function upsertMetafield(
  customerId: number,
  namespace: string,
  key: string,
  type: string, // 'single_line_text_field' | 'boolean' | etc
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
