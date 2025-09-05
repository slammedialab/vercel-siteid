// pages/api/self-test.ts
export default async function handler(req: any, res: any) {
    const shop = process.env.SHOP;
    const hasToken = !!process.env.ADMIN_TOKEN;
  
    if (!shop || !hasToken) {
      return res.status(200).json({
        ok: false,
        reason: 'missing_env',
        SHOP: shop || null,
        ADMIN_TOKEN_present: hasToken
      });
    }
  
    try {
      const r = await fetch(`https://${shop}/admin/api/2024-07/shop.json`, {
        headers: { 'X-Shopify-Access-Token': process.env.ADMIN_TOKEN as string }
      });
      const text = await r.text();
      return res.status(200).json({
        ok: r.ok,
        status: r.status,
        statusText: r.statusText,
        bodySnippet: text.slice(0, 300)
      });
    } catch (e: any) {
      return res.status(200).json({ ok: false, reason: 'network_error', message: e?.message });
    }
  }
  