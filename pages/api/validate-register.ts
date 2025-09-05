// pages/api/validate-register.ts
import ids from '../../data/site-ids.json';
import { adminGraphQL } from '../../lib/shopify';


const ID_SET = new Set<string>(ids as string[]);
const SHOP = process.env.SHOP as string;               // yourshop.myshopify.com
const ADMIN_TOKEN = process.env.ADMIN_TOKEN as string; // Admin API token

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email, firstName, lastName, siteId } = req.body || {};
  if (!email || !siteId) return res.json({ ok:false, error:'Missing email or siteId' });

  const id = String(siteId).trim();
  if (!ID_SET.has(id)) return res.json({ ok:false, field:'siteId', error:'Invalid Site ID' });

  try {
    // 1) Create (or detect existing) customer
    const createQ = `mutation customerCreate($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id email }
        userErrors { field message }
      }
    }`;
    const input = { email, firstName, lastName, tags: ['approved'] };
    const createResp: any = await adminGraphQL(SHOP, ADMIN_TOKEN, createQ, { input });

    let customerId = createResp?.data?.customerCreate?.customer?.id;
    const err = createResp?.data?.customerCreate?.userErrors?.[0];

    if (err && /already.*(taken|exists)/i.test(err.message)) {
      // find existing by email
      const findQ = `query ($query:String!) {
        customers(first:1, query:$query) { edges { node { id email } } }
      }`;
      const found: any = await adminGraphQL(SHOP, ADMIN_TOKEN, findQ, { query: `email:${email}` });
      customerId = found?.data?.customers?.edges?.[0]?.node?.id;
      if (!customerId) return res.json({ ok:false, error:'Customer lookup failed' });

      // ensure approved tag
      const tagsM = `mutation tagsAdd($id:ID!, $tags:[String!]!) {
        tagsAdd(id:$id, tags:$tags) { node { id } userErrors { field message } }
      }`;
      await adminGraphQL(SHOP, ADMIN_TOKEN, tagsM, { id: customerId, tags: ['approved'] });
    } else if (err) {
      return res.json({ ok:false, error: err.message });
    }

    if (!customerId) customerId = createResp.data.customerCreate.customer.id;

    // 2) Set metafields: custom.site_id + custom.approved
    const mfM = `mutation mf($metafields:[MetafieldsSetInput!]!) {
      metafieldsSet(metafields:$metafields) { userErrors { field message } }
    }`;
    const metafields = [
      { ownerId: customerId, namespace:'custom', key:'site_id', type:'single_line_text_field', value: id },
      { ownerId: customerId, namespace:'custom', key:'approved', type:'boolean', value: 'true' }
    ];
    const mfResp: any = await adminGraphQL(SHOP, ADMIN_TOKEN, mfM, { metafields });
    const mfErr = mfResp?.data?.metafieldsSet?.userErrors?.[0];
    if (mfErr) return res.json({ ok:false, error: mfErr.message });

    res.json({ ok:true });
  } catch (e: any) {
    res.json({ ok:false, error: e.message || 'Server error' });
  }
}
