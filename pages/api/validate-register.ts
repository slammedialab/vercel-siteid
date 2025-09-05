// pages/api/validate-register.ts
import ids from '../../data/site-ids.json';
import { adminREST, apiVersion } from '../../lib/shopify';

const SHOP = process.env.SHOP as string;           // e.g. centeringhealthcare.myshopify.com
const ADMIN_TOKEN = process.env.ADMIN_TOKEN as string;
const API_VERSION = apiVersion();                  // e.g. '2025-07'

const ID_SET = new Set<string>(ids as string[]);

/* ---------------- GraphQL Helper ---------------- */
async function adminGraphQL<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await r.json();
  if (!r.ok || json.errors) {
    throw new Error(`GraphQL ${r.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json.data;
}

/* ---------------- GraphQL Docs ---------------- */
const GET_CUSTOMER_BY_EMAIL = `
  query getCustomerByEmail($q: String!) {
    customers(first: 1, query: $q) { edges { node { id email tags } } }
  }
`;

const CUSTOMER_CREATE = `
  mutation customerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id email }
      userErrors { field message }
    }
  }
`;

const CUSTOMER_UPDATE = `
  mutation customerUpdate($id: ID!, $input: CustomerInput!) {
    customerUpdate(id: $id, input: $input) {
      customer { id email }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_SET = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { ownerId namespace key type value }
      userErrors { field message }
    }
  }
`;

/* ---------------- API Route ---------------- */
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, firstName, lastName, siteId } = req.body || {};
  if (!email || !siteId) return res.json({ ok: false, error: 'Missing email or siteId' });

  const idStr = String(siteId).trim();
  if (!ID_SET.has(idStr)) {
    return res.json({ ok: false, field: 'siteId', error: 'Invalid Site ID' });
  }

  try {
    const emailLower = String(email).toLowerCase();

    // 1) STRICT find by email (GraphQL)
    const q = `email:"${emailLower}"`;
    const s = await adminGraphQL(GET_CUSTOMER_BY_EMAIL, { q });
    const found = s?.customers?.edges?.[0]?.node ?? null;

    let customerGid: string | null = null;
    let action: 'created' | 'updated';

    if (!found) {
      // 2) CREATE via GraphQL (deterministic)
      const created = await adminGraphQL(CUSTOMER_CREATE, {
        input: {
          email: emailLower,
          firstName: firstName || null,
          lastName: lastName || null,
          tags: ['approved'] // seed tag
        }
      });

      const errs = created?.customerCreate?.userErrors;
      if (errs?.length) {
        return res.json({ ok: false, error: 'customerCreate userErrors', details: errs, shop: SHOP });
      }

      customerGid = created?.customerCreate?.customer?.id ?? null;
      if (!customerGid) {
        return res.json({ ok: false, error: 'customerCreate returned no id', shop: SHOP });
      }
      action = 'created';
    } else {
      customerGid = found.id;
      // 3) UPDATE names via GraphQL
      const updated = await adminGraphQL(CUSTOMER_UPDATE, {
        id: customerGid,
        input: {
          firstName: firstName || null,
          lastName: lastName || null
        }
      });
      const errs = updated?.customerUpdate?.userErrors;
      if (errs?.length) {
        return res.json({ ok: false, error: 'customerUpdate userErrors', details: errs, shop: SHOP });
      }
      action = 'updated';
    }

    // Convert gid → numeric id for REST confirm & metafield convenience
    const customerId = Number(customerGid.split('/').pop());

    // 4) HARD CONFIRM by ID via REST and assert email matches
    const confirm = await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`);
    const foundEmail = (confirm?.customer?.email || '').toLowerCase();
    if (foundEmail !== emailLower) {
      return res.json({
        ok: false,
        error: `ID/email mismatch. ID ${customerId} belongs to ${confirm?.customer?.email || '(no email)'}`,
        debug: { expectedEmail: emailLower, foundEmail, shop: SHOP }
      });
    }

    // 5) Ensure tags: add approved + unique debug tag
    const existingTags = (confirm?.customer?.tags || '')
      .split(',')
      .map((t: string) => t.trim())
      .filter(Boolean);
    const tagSet = new Set(existingTags);
    tagSet.add('approved');
    const debugTag = `debug-${Date.now()}`;
    tagSet.add(debugTag);

    await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`, {
      method: 'PUT',
      body: { customer: { id: customerId, tags: Array.from(tagSet).join(', ') } }
    });

    // 6) Upsert metafields via GraphQL (most reliable path)
    const metaWrite = await adminGraphQL(METAFIELDS_SET, {
      metafields: [
        {
          ownerId: customerGid,
          namespace: 'custom',
          key: 'custom_site_id',
          type: 'single_line_text_field',
          value: idStr
        },
        {
          ownerId: customerGid,
          namespace: 'custom',
          key: 'approved',
          type: 'boolean',
          value: 'true'
        }
      ]
    });
    const metaErrs = metaWrite?.metafieldsSet?.userErrors;
    if (metaErrs?.length) {
      return res.json({ ok: false, error: 'metafieldsSet userErrors', details: metaErrs, shop: SHOP });
    }

    // 7) Done
    return res.json({
      ok: true,
      action,
      customerId,
      email: emailLower,
      siteId: idStr,
      shop: SHOP,
      debugTag
    });
  } catch (e: any) {
    return res.json({ ok: false, error: String(e?.message || e), shop: SHOP });
  }
}
