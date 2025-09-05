// pages/api/validate-register.ts

import ids from '../../data/site-ids.json';
import { adminREST } from '../../lib/shopify';
import { withCORS } from '../../lib/cors';

const SHOP = process.env.SHOP as string;            // e.g. centeringhealthcare.myshopify.com
const ADMIN_TOKEN = process.env.ADMIN_TOKEN as string;

// If you want to retry GraphQL later, set this true and set GRAPHQL_API_VERSION below.
const USE_GRAPHQL = false;
const GRAPHQL_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-04'; // safer fallback

const ID_SET = new Set<string>(ids as string[]);

/* ---------------- GraphQL helper (disabled by default) ---------------- */
async function adminGraphQL<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  const url = `https://${SHOP}/admin/api/${GRAPHQL_API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const json = await r.json();
  if (!r.ok || json.errors) {
    throw new Error(`GraphQL ${r.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json.data;
}

const GQL_GET_BY_EMAIL = `
  query getCustomerByEmail($q:String!){ customers(first:1, query:$q){edges{node{id email}}} }
`;
const GQL_CREATE = `
  mutation customerCreate($input:CustomerInput!){
    customerCreate(input:$input){ customer{id email} userErrors{field message} }
  }
`;
const GQL_UPDATE = `
  mutation customerUpdate($id:ID!, $input:CustomerInput!){
    customerUpdate(id:$id, input:$input){ customer{id email} userErrors{field message} }
  }
`;
const GQL_META_SET = `
  mutation metafieldsSet($metafields:[MetafieldsSetInput!]!){
    metafieldsSet(metafields:$metafields){ metafields{ownerId key namespace} userErrors{field message} }
  }
`;

/* ---------------- Route ---------------- */
export default async function handler(req: any, res: any) {
  withCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email, firstName, lastName, siteId } = req.body || {};
  if (!email || !siteId) return res.json({ ok: false, error: 'Missing email or siteId', shop: SHOP });

  const siteIdStr = String(siteId).trim();
  if (!ID_SET.has(siteIdStr)) return res.json({ ok: false, field: 'siteId', error: 'Invalid Site ID', shop: SHOP });

  try {
    const emailLower = String(email).toLowerCase();

    // ---------- STRICT FIND (REST, exact) ----------
    const existingId = await findCustomerIdByEmailExact(emailLower);

    let customerId: number;
    let action: 'created' | 'updated';

    if (!existingId) {
      // ---------- CREATE ----------
      if (USE_GRAPHQL) {
        const created = await adminGraphQL(GQL_CREATE, {
          input: { email: emailLower, firstName: firstName || null, lastName: lastName || null, tags: ['approved'] }
        });
        const errs = created?.customerCreate?.userErrors;
        if (errs?.length) return res.json({ ok: false, error: 'customerCreate userErrors', details: errs, shop: SHOP });
        const gid = created?.customerCreate?.customer?.id;
        if (!gid) return res.json({ ok: false, error: 'customerCreate returned no id', shop: SHOP });
        customerId = Number(gid.split('/').pop());
      } else {
        const createResp = await adminREST(SHOP, ADMIN_TOKEN, `/customers.json`, {
          method: 'POST',
          body: {
            customer: {
              email: emailLower,
              first_name: firstName || '',
              last_name: lastName || '',
              verified_email: true,
              tags: 'approved'
            }
          }
        });

        // REST create should return {customer:{...}}. If not, fail hard.
        const createdId = createResp?.customer?.id ?? null;
        if (!createdId) {
          // attempt a STRICT re-check by email; accept only if exact email matches
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
      }
      action = 'created';
    } else {
      // ---------- UPDATE ----------
      if (USE_GRAPHQL) {
        const gid = `gid://shopify/Customer/${existingId}`;
        const updated = await adminGraphQL(GQL_UPDATE, {
          id: gid,
          input: { firstName: firstName || null, lastName: lastName || null }
        });
        const errs = updated?.customerUpdate?.userErrors;
        if (errs?.length) return res.json({ ok: false, error: 'customerUpdate userErrors', details: errs, shop: SHOP });
      } else {
        await adminREST(SHOP, ADMIN_TOKEN, `/customers/${existingId}.json`, {
          method: 'PUT',
          body: { customer: { id: existingId, first_name: firstName || '', last_name: lastName || '' } }
        });
      }
      customerId = existingId;
      action = 'updated';
    }

    // ---------- HARD CONFIRM BY ID ----------
    const confirm = await adminREST(SHOP, ADMIN_TOKEN, `/customers/${customerId}.json`);
    const foundEmail = (confirm?.customer?.email || '').toLowerCase();
    if (foundEmail !== emailLower) {
      return res.json({
        ok: false,
        error: `ID/email mismatch. ID ${customerId} belongs to ${confirm?.customer?.email || '(no email)'}`,
        debug: { expectedEmail: emailLower, foundEmail, shop: SHOP }
      });
    }

    // ---------- ENSURE TAGS (approved only — removed debug-<timestamp>) ----------
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

    // ---------- METAFIELDS: custom.custom_site_id + custom.approved ----------
    if (USE_GRAPHQL) {
      const gid = `gid://shopify/Customer/${customerId}`;
      const metaWrite = await adminGraphQL(GQL_META_SET, {
        metafields: [
          { ownerId: gid, namespace: 'custom', key: 'custom_site_id', type: 'single_line_text_field', value: siteIdStr },
          { ownerId: gid, namespace: 'custom', key: 'approved', type: 'boolean', value: 'true' }
        ]
      });
      const metaErrs = metaWrite?.metafieldsSet?.userErrors;
      if (metaErrs?.length) return res.json({ ok: false, error: 'metafieldsSet userErrors', details: metaErrs, shop: SHOP });
    } else {
      await upsertMetafieldREST(customerId, 'custom', 'custom_site_id', 'single_line_text_field', siteIdStr);
      await upsertMetafieldREST(customerId, 'custom', 'approved', 'boolean', 'true');
    }

    // ---------- DONE ----------
    return res.json({ ok: true, action, customerId, email: emailLower, siteId: siteIdStr, shop: SHOP });
  } catch (e: any) {
    return res.json({ ok: false, error: String(e?.message || e), shop: SHOP });
  }
}

/* ---------------- STRICT helpers (REST) ---------------- */
async function findCustomerIdByEmailExact(emailLower: string): Promise<number | null> {
  // Exact, quoted search only; accept only if returned email exactly matches.
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
