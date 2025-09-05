// pages/api/self-test.ts
import { adminREST } from '../../lib/shopify';

const SHOP = process.env.SHOP as string;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN as string;

export default async function handler(_req: any, res: any) {
  try {
    const data = await adminREST(SHOP, ADMIN_TOKEN, '/shop.json');
    res.json({
      ok: true,
      usingEnvShop: SHOP,
      shopFromToken: data?.shop?.myshopify_domain
    });
  } catch (e: any) {
    res.json({
      ok: false,
      error: String(e?.message || e),
      usingEnvShop: SHOP
    });
  }
}
