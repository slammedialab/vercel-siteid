// pages/api/validate-siteid.ts
import ids from '../../data/site-ids.json';
import { withCORS } from '../../lib/cors';

// Normalize ALL ids to strings once
const ID_SET = new Set(
  (ids as Array<string | number>)
    .filter(Boolean)
    .map(v => String(v).trim())
);

export default async function handler(req: any, res: any) {
  withCORS(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).end();

  const siteId = String(req.query.siteId ?? '').trim();
  const valid  = !!siteId && ID_SET.has(siteId);

  return res.status(200).json({ valid });
}
