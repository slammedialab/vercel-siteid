// /api/customer-save.js
export default async function handler(req, res) {
    // --- CORS (allow calls from your storefront) ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
  
    if (req.method !== 'POST') {
      return res.status(405).json({ ok:false, error:'Method not allowed' });
    }
  
    // ── envs as you configured them on Vercel ───────────────────────────────
    const SHOP  = process.env.SHOP;                  // e.g. rgbpxx-es.myshopify.com
    const TOKEN = process.env.ADMIN_TOKEN;           // Admin API token
    const VER   = process.env.SHOPIFY_API_VERSION || '2025-07';
  
    if (!SHOP || !TOKEN) {
      return res.status(500).json({ ok:false, error:'Missing SHOP or ADMIN_TOKEN env' });
    }
  
    const { email, phone, siteId, titleRole, firstName, lastName } = req.body || {};
    if (!email) return res.status(400).json({ ok:false, error:'Missing email' });
  
    const GQL = `https://${SHOP}/admin/api/${VER}/graphql.json`;
  
    async function gql(query, variables) {
      const r = await fetch(GQL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': TOKEN
        },
        body: JSON.stringify({ query, variables })
      });
      const j = await r.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors));
      const ue = j.data?.customerUpdate?.userErrors || j.data?.metafieldsSet?.userErrors;
      if (ue && ue.length) throw new Error(JSON.stringify(ue));
      return j.data;
    }
  
    try {
      // 1) Find customer by email
      const d = await gql(
        `query($q:String!){ customers(first:1, query:$q){ edges{ node{ id } } } }`,
        { q: `email:${email}` }
      );
      const node = d.customers.edges[0]?.node;
      if (!node) return res.status(404).json({ ok:false, error:'Customer not found' });
      const id = node.id;
  
      // 2) Update core fields (contact phone + names)
      await gql(
        `mutation U($id:ID!,$phone:String,$first:String,$last:String){
          customerUpdate(input:{id:$id, phone:$phone, firstName:$first, lastName:$last}){
            customer{ id }
            userErrors{ field message }
          }
        }`,
        { id, phone: phone || null, first: firstName || null, last: lastName || null }
      );
  
      // 3) Upsert metafields (write to custom.custom_site_id + optional title_role)
      const metas = [];
      if (siteId != null && siteId !== '') {
        metas.push({
          ownerId: id,
          namespace: "custom",
          key: "custom_site_id",                  // <-- the required key
          type: "single_line_text_field",
          value: String(siteId)
        });
      }
      if (titleRole != null && titleRole !== '') {
        metas.push({
          ownerId: id,
          namespace: "custom",
          key: "title_role",
          type: "single_line_text_field",
          value: String(titleRole)
        });
      }
  
      if (metas.length) {
        await gql(
          `mutation S($metafields:[MetafieldsSetInput!]!){
            metafieldsSet(metafields:$metafields){ userErrors{ field message } }
          }`,
          { metafields: metas }
        );
      }
  
      return res.status(200).json({ ok:true });
    } catch (e) {
      return res.status(500).json({ ok:false, error:String(e?.message || e) });
    }
  }
  