// pages/api/validate-register.ts
import ids from '../../data/site-ids.json';
import { adminREST } from '../../lib/shopify';

const SHOP = process.env.SHOP as string;
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
    // 1) Find or create
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
            tags: 'approved', // seed with approved; we’ll still merge below
          },
        },
      });

      customerId = created?.customer?.id ?? created?.customers?.[0]?.id ?? null;

      if (!customerId) {
        // small delay and re-search (eventual consistency)
        await sleep(350);
        customerId = await findCustomerIdByEmail(email);
        if (!customerId) {
          return res.json({
            ok: false,
            error:
              'Customer create returned no id. Response: ' +
              JSON.stringify(created).slice(0, 300),
          });
        }
      }
      action = 'created';
    } else {
      // Update (names only; tags/metafields handled separately)
      await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
        method: 'PUT',
        body: {
          customer: {
            id: customerId,
            first_name: firstName || '',
            last_name: lastName || '',
          },
        },
      });
      action = 'updated';
    }

    // 2) Ensure "approved" tag
    await ensureApprovedTag(customerId);

    // 3) Upsert required metafields
    await upsertMetafield(customerId, 'custom', 'custom_site_id', 'single_line_text_field', idStr); // ✅ correct key
    await upsertMetafield(customerId, 'custom', 'approved', 'boolean', 'true');

    return res.json({
      ok: true,
      action,
      customerId,
      email,
      siteId: idStr,
    });
  } catch (e: any) {
    console.error('register error:', e?.message || e);
    return res.json({ ok: false, error: e?.message || 'Server error' });
  }
}

async function findCustomerIdByEmail(email: string): Promise<number | null> {
  // Prefer /customers/search with quoted email
  try {
    const quoted = await adminREST(SHOP, ADMIN_TOKEN, `/customers/search.json`, {
      qs: { query: `email:"${email}"` },
    });
    let id = quoted?.customers?.[0]?.id ?? null;
    if (id) return id;

    const unquoted = await adminREST(SHOP, ADMIN_TOKEN, `/customers/search.json`, {
      qs: { query: `email:${email}` },
    });
    id = unquoted?.customers?.[0]?.id ?? null;
    if (id) return id;
  } catch {
    // fall through
  }

  // Legacy fallback
  try {
    const legacy = await adminREST(SHOP, ADMIN_TOKEN, `/customers.json`, {
      qs: { email },
    });
    return legacy?.customers?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function ensureApprovedTag(customerId: number) {
  const customerResp = await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`);
  const existingTags = customerResp?.customer?.tags || '';
  const tags = new Set(
    existingTags
      .split(',')
      .map((t: string) => t.trim())
      .filter(Boolean),
  );

  if (!tags.has('approved')) {
    tags.add('approved');
    await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
      method: 'PUT',
      body: { customer: { id: customerId, tags: Array.from(tags).join(', ') } },
    });
  }
}

async function upsertMetafield(
  customerId: number,
  namespace: string,
  key: string,
  type: string, // 'single_line_text_field' | 'boolean' | etc
  value: string,
) {
  const list = await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}/metafields.json`);
  const existing = (list?.metafields || []).find((m: any) => m.namespace === namespace && m.key === key);

  if (!existing) {
    await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}/metafields.json`, {
      method: 'POST',
      body: { metafield: { namespace, key, type, value } },
    });
  } else {
    await adminREST(SHOP, ADMIN_TOKEN, `/metafields/${existing.id}.json`, {
      method: 'PUT',
      body: { metafield: { id: existing.id, type, value } },
    });
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
