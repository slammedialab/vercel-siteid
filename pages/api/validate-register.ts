// pages/api/validate-register.ts
import directory from '../../data/site-directory.json';
import { adminREST } from '../../lib/shopify';
import { withCORS } from '../../lib/cors';

const SHOP = process.env.SHOP as string;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN as string;

type Dir = Record<string, { accountName?: string; accountId?: string }>;

function normalizePhone(raw: any): string | null {
  const v = String(raw || '').trim();
  if (!v) return null;
  let s = v.replace(/[^\d+]/g, '');
  if (/^\d{10}$/.test(s)) s = '+1' + s;
  if (!/^\+\d{8,15}$/.test(s)) return null;
  return s;
}

export default async function handler(req: any, res: any) {
  withCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).end();

  try {
    const { email, firstName, lastName, phone, siteId, titleRole, password, update } = req.body || {};

    const emailLower = String(email || '').toLowerCase().trim();
    const siteIdStr  = String(siteId || '').trim();
    if (!emailLower) return jsonErr(res, 'Missing email', 'email');
    if (!siteIdStr)  return jsonErr(res, 'Missing siteId', 'siteId');

    const match = (directory as Dir)[siteIdStr];
    if (!match) return jsonErr(res, 'Invalid Site ID', 'siteId');

    const accountName = match.accountName || '';
    const accountId   = match.accountId   || '';

    const existingId = await findCustomerIdByEmailExact(emailLower);

    if (update === true) {
      if (!existingId) return jsonErr(res, 'No existing account for that email', 'email');
      const cid = existingId;

      await adminREST(SHOP, ADMIN_TOKEN, `/customers/${cid}.json`, {
        method: 'PUT',
        body: { customer: { id: cid, first_name: String(firstName || ''), last_name: String(lastName || '') } }
      });

      const phoneClean = normalizePhone(phone);
      if (phoneClean) {
        try {
          await adminREST(SHOP, ADMIN_TOKEN, `/customers/${cid}.json`, {
            method: 'PUT',
            body: { customer: { id: cid, phone: phoneClean } }
          });
        } catch {}
      }

      // Ensure approved tag
      try {
        const confirm = await adminREST(SHOP, ADMIN_TOKEN, `/customers/${cid}.json`);
        const tags = ((confirm?.customer?.tags || '') as string).split(',').map(t => t.trim()).filter(Boolean);
        if (!tags.includes('approved')) {
          tags.push('approved');
          await adminREST(SHOP, ADMIN_TOKEN, `/customers/${cid}.json`, {
            method: 'PUT',
            body: { customer: { id: cid, tags: tags.join(', ') } }
          });
        }
      } catch {}

      // Metafields
      await upsertMetafieldREST(cid, 'custom', 'custom_site_id', 'single_line_text_field', siteIdStr);
      await upsertMetafieldREST(cid, 'custom', 'account_name',   'single_line_text_field', accountName);
      await upsertMetafieldREST(cid, 'custom', 'account_id',     'single_line_text_field', accountId);
      await upsertMetafieldREST(cid, 'custom', 'title_role',     'single_line_text_field', String(titleRole || ''));

      return res.json({
        ok: true, action: 'updated', customerId: cid, email: emailLower, siteId: siteIdStr, shop: SHOP,
        accountName: accountName || null, accountId: accountId || null
      });
    }

    // Create-or-update
    let customerId: number;
    let action: 'created' | 'updated';
    if (!existingId) {
      if (!password || String(password).length < 8) return jsonErr(res, 'Password must be at least 8 characters', 'password');

      const phoneClean = normalizePhone(phone) || undefined;
      const createResp = await adminREST(SHOP, ADMIN_TOKEN, `/customers.json`, {
        method: 'POST',
        body: {
          customer: {
            email: emailLower,
            first_name: String(firstName || ''),
            last_name:  String(lastName  || ''),
            phone: phoneClean,
            verified_email: true,
            tags: 'approved',
            password: String(password),
            password_confirmation: String(password),
            send_email_welcome: false
          }
        }
      });

      customerId = createResp?.customer?.id ?? (await findCustomerIdByEmailExact(emailLower))!;
      if (!customerId) return jsonErr(res, 'Customer create returned no id');
      action = 'created';
    } else {
      customerId = existingId;
      action = 'updated';
      await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
        method: 'PUT',
        body: { customer: { id: customerId, first_name: String(firstName || ''), last_name: String(lastName || '') } }
      });
      const phoneClean = normalizePhone(phone);
      if (phoneClean) {
        try {
          await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
            method: 'PUT',
            body: { customer: { id: customerId, phone: phoneClean } }
          });
        } catch {}
      }
    }

    // Confirm email matches id
    const confirm = await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`);
    const foundEmail = (confirm?.customer?.email || '').toLowerCase();
    if (foundEmail !== emailLower) return jsonErr(res, `ID/email mismatch. ID ${customerId} belongs to ${confirm?.customer?.email || '(no email)'}`);

    // Ensure approved tag
    const existingTags = (confirm?.customer?.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean);
    if (!existingTags.includes('approved')) {
      existingTags.push('approved');
      await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
        method: 'PUT',
        body: { customer: { id: customerId, tags: existingTags.join(', ') } }
      });
    }

    // Metafields (always write from directory)
    await upsertMetafieldREST(customerId, 'custom', 'custom_site_id', 'single_line_text_field', siteIdStr);
    await upsertMetafieldREST(customerId, 'custom', 'account_name',   'single_line_text_field', accountName);
    await upsertMetafieldREST(customerId, 'custom', 'account_id',     'single_line_text_field', accountId);
    await upsertMetafieldREST(customerId, 'custom', 'title_role',     'single_line_text_field', String(titleRole || ''));

    const payload: any = {
      ok: true, action, customerId, email: emailLower, siteId: siteIdStr, shop: SHOP,
      accountName: accountName || null, accountId: accountId || null
    };
    if (action === 'created' && password) payload.password = String(password);
    return res.json(payload);

  } catch (e: any) {
    return jsonErr(res, String(e?.message || e));
  }
}

function jsonErr(res: any, error: string, field?: string) {
  return res.json({ ok: false, error, field, shop: SHOP });
}

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
