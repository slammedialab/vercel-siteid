// pages/api/validate-siteid.ts
import ids from '../../data/site-ids.json';
import { withCORS } from '../../lib/cors';

const ID_SET = new Set<string>(ids as string[]);

export default async function handler(req: any, res: any) {
  withCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();

  const siteId = String(req.query.siteId ?? '').trim();
  const valid = siteId !== '' && ID_SET.has(siteId);

  // Cache a little (safe: the file is static)
  res.setHeader('Cache-Control', 'public, max-age=300');

  // For HEAD requests just send headers
  if (req.method === 'HEAD') return res.status(200).end();

  res.status(200).json({ valid });
}
