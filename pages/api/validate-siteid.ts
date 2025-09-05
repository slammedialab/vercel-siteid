// pages/api/validate-siteid.ts
import ids from '../../data/site-ids.json';

const ID_SET = new Set<string>(ids as string[]);

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') return res.status(405).end();
  const siteId = String(req.query.siteId || '').trim();
  res.json({ valid: ID_SET.has(siteId) });
}
