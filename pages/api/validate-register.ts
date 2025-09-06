// pages/api/validate-register.ts

import ids from '../../data/site-ids.json';
import { adminREST } from '../../lib/shopify';
import { withCORS } from '../../lib/cors';

const SHOP = process.env.SHOP as string;            // e.g. yourshop.myshopify.com
const ADMIN_TOKEN = process.env.ADMIN_TOKEN as string;

// We are NOT using Storefront or GraphQL here to avoid 401s.
const ID_SET = new Set<string>((ids as any[]).map(v => String(v).trim()));

export default async function handler(req: any, res: any) {
  withCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).end();

  try {
    const {
      email,
      firstName,
      lastName,
      phone,          // optional
      siteId,
      titleRole,      // optional
      password        // required for instant login flow
    } = req.body || {};

    if (!email || !siteId) {
      return res.json({ ok: false, error: 'Missing email or siteId', shop: SHOP });
    }
    if (!password || String(password).length < 8) {
      return res.json({ ok: false, field: 'password', error: 'Password must be at least 8 characters', shop: SHOP });
    }

    const emailLower = String(email).toLowerCase().trim();
    const siteIdStr  = String(siteId).trim();

    if (!ID_SET.has(siteIdStr)) {
      return res.json({ ok: false, field: 'siteId', error: 'Invalid Site ID', shop: SHOP });
    }

    // 1) Try to find exact customer by email
    const existingId = await findCustomerIdByEmailExact(emailLower);

    let customerId: number;
    let action: 'created' | 'updated';

    if (!existingId) {
      // 2a) CREATE via Admin REST with password for Classic accounts
      const createResp = await adminREST(SHOP, ADMIN_TOKEN, `/customers.json`, {
        method: 'POST',
        body: {
          customer: {
            email: emailLower,
            first_name: firstName || '',
            last_name:  lastName  || '',
            phone:       phone     || undefined,
            verified_email: true,
            tags: 'approved',
            password: String(password),
            password_confirmation: String(password),
            send_email_welcome: false
          }
        }
      });

      const createdId = createResp?.customer?.id ?? null;
      if (!createdId) {
        // fallback: recheck by email
        const recheck = await findCustomerIdByEmailExact(emailLower);
        if (!recheck) {
          return res.json({
            ok: false,
            error: 'Customer create returned no id',
            debug: { shop: SHOP, createRespSnippet: JSON.stringify(createResp).slice(0, 400) }
          });
        }
        customerId = recheck;
      } else {
        customerId = createdId;
      }
      action = 'created';
    } else {
      // 2b) UPDATE name fields (don’t touch password)
      await adminREST(SHOP, ADMIN_TOKEN, `/customers/${existingId}.json`, {
        method: 'PUT',
        body: {
          customer: {
            id: existingId,
            first_name: firstName || '',
            last_name:  lastName  || ''
          }
        }
      });
      customerId = existingId;
      action = 'updated';
    }

    // 3) Confirm the email matches
    const confirm = await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`);
    const foundEmail = (confirm?.customer?.email || '').toLowerCase();
    if (foundEmail !== emailLower) {
      return res.json({
        ok: false,
        error: `ID/email mismatch. ID ${customerId} belongs to ${confirm?.customer?.email || '(no email)'}`,
        debug: { expectedEmail: emailLower, foundEmail, shop: SHOP }
      });
    }

    // 4) Ensure "approved" tag (preserve existing)
    const existingTags = (confirm?.customer?.tags || '')
      .split(',')
      .map((t: string) => t.trim())
      .filter(Boolean);
    const tagSet = new Set(existingTags);
    tagSet.add('approved');

    await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
      method: 'PUT',
      body: { customer: { id: customerId, tags: Array.from(tagSet).join(', ') } }
    });

    // 5) Upsert metafields: custom.custom_site_id and custom.titlerole
    await upsertMetafieldREST(customerId, 'custom', 'custom_site_id', 'single_line_text_field', siteIdStr);
    await upsertMetafieldREST(customerId, 'custom', 'titlerole',      'single_line_text_field', String(titleRole || ''));

    // 6) Done — return password back for theme to post to /account/login
    return res.json({
      ok: true,
      action,
      customerId,
      email: emailLower,
      siteId: siteIdStr,
      shop: SHOP,
      password: String(password)
    });
  } catch (e: any) {
    return res.json({ ok: false, error: String(e?.message || e), shop: SHOP });
  }
}

/* ---------------- Helpers ---------------- */
async function findCustomerIdByEmailExact(emailLower: string): Promise<number | null> {
  try {
    const resp = await adminREST(SHOP, ADMIN_TOKEN, `/customers/search.json`, { qs: { query: `email:"${emailLower}"` } });
    const c = resp?.customers?.[0];
    if (c && (c.email || '').toLowerCase() === emailLower) return c.id as number;
    return null;
  } catch {
    return null;
  }
}

async function upsertMetafieldREST(
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
