// pages/api/validate-register.ts
import ids from '../../data/site-ids.json';
import { adminREST } from '../../lib/shopify';
import { withCORS } from '../../lib/cors';

const SHOP = process.env.SHOP as string;                 // e.g. your-shop.myshopify.com
const ADMIN_TOKEN = process.env.ADMIN_TOKEN as string;

// Storefront (for creating with password)
const SF_API_VERSION   = process.env.STOREFRONT_API_VERSION || '2025-07';
const STOREFRONT_TOKEN = process.env.STOREFRONT_TOKEN as string;
const SF_URL           = `https://${SHOP}/api/${SF_API_VERSION}/graphql.json`;

// Accept both ["910001"] and [910001]
const ID_SET = new Set<string>((ids as any[]).map(v => String(v).trim()));

function genTempPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=';
  return Array.from({ length: 18 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function storefrontGraphQL<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  const r = await fetch(SF_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await r.json();
  if (!r.ok || json.errors) throw new Error(`Storefront ${r.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return json.data as T;
}

const SF_CUSTOMER_CREATE = `
  mutation customerCreate($input: CustomerCreateInput!) {
    customerCreate(input: $input) {
      customer { id email }
      userErrors { field message code }
    }
  }
`;

export default async function handler(req: any, res: any) {
  withCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).end();

  const { email, firstName, lastName, phone, siteId, titleRole, password } = req.body || {};
  if (!email || !siteId) return res.json({ ok:false, error:'Missing email or siteId', shop: SHOP });

  const siteIdStr = String(siteId).trim();
  if (!ID_SET.has(siteIdStr)) return res.json({ ok:false, field:'siteId', error:'Invalid Site ID', shop: SHOP });

  try {
    const emailLower = String(email).toLowerCase();

    // Strict exact email lookup
    const existingId = await findCustomerIdByEmailExact(emailLower);

    let customerId: number;
    let action: 'created' | 'updated';
    let finalPassword: string | undefined;

    if (!existingId) {
      // Create WITH provided password (or generate fallback)
      const chosenPassword =
        (typeof password === 'string' && password.length >= 8) ? password : genTempPassword();
      finalPassword = chosenPassword;

      const sf = await storefrontGraphQL(SF_CUSTOMER_CREATE, {
        input: {
          email: emailLower,
          password: chosenPassword,
          firstName: firstName || null,
          lastName:  lastName  || null,
          phone:     phone     || null,
          acceptsMarketing: false,
        },
      });

      const errs: any[] = (sf as any)?.customerCreate?.userErrors || [];
      if (errs.length) {
        return res.json({
          ok: false,
          error: errs.map(e => e.message).join('; '),
          field: errs[0]?.field?.[0],
          shop: SHOP,
        });
      }

      const gid = (sf as any)?.customerCreate?.customer?.id; // gid://shopify/Customer/<id>
      if (!gid) return res.json({ ok:false, error:'customerCreate returned no id', shop: SHOP });

      customerId = Number(String(gid).split('/').pop());
      action = 'created';
    } else {
      // Update names (cannot set password here)
      await adminREST(SHOP, ADMIN_TOKEN, `/customers/${existingId}.json`, {
        method: 'PUT',
        body: { customer: { id: existingId, first_name: firstName || '', last_name: lastName || '' } },
      });
      customerId = existingId;
      action = 'updated';
    }

    // Confirm the email for this ID (defensive)
    const confirm = await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`);
    const foundEmail = (confirm?.customer?.email || '').toLowerCase();
    if (foundEmail !== emailLower) {
      return res.json({
        ok:false,
        error:`ID/email mismatch. ID ${customerId} belongs to ${confirm?.customer?.email || '(no email)'}`,
        debug:{ expectedEmail: emailLower, foundEmail, shop: SHOP }
      });
    }

    // Ensure tag 'approved'
    const existingTags = (confirm?.customer?.tags || '')
      .split(',').map((t:string)=>t.trim()).filter(Boolean);
    const tagSet = new Set(existingTags);
    tagSet.add('approved');
    await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
      method:'PUT',
      body:{ customer: { id: customerId, tags: Array.from(tagSet).join(', ') } }
    });

    // === WRITE METAFIELDS BEFORE RESPONDING ===
    await upsertMetafieldREST(customerId, 'custom', 'custom_site_id', 'single_line_text_field', siteIdStr);
    await upsertMetafieldREST(customerId, 'custom', 'approved',       'boolean',               'true');
    if (typeof titleRole === 'string' && titleRole.trim()) {
      await upsertMetafieldREST(customerId, 'custom', 'titlerole',    'single_line_text_field', String(titleRole).trim());
    }

    // Respond:
    if (action === 'created' && finalPassword) {
      // No redirect so client posts to /account/login using this password
      return res.json({
        ok: true,
        action,
        customerId,
        email: emailLower,
        siteId: siteIdStr,
        password: finalPassword,
        shop: SHOP
      });
    }

    // Existing account (can’t set password) – send to login page (prefilled)
    return res.json({
      ok: true,
      action,
      customerId,
      email: emailLower,
      siteId: siteIdStr,
      redirect: `/account/login?email=${encodeURIComponent(emailLower)}`,
      shop: SHOP
    });

  } catch (e:any) {
    return res.json({ ok:false, error: String(e?.message || e), shop: SHOP });
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
