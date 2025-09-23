// pages/api/validate-siteid.ts
import directory from '../../data/site-directory.json';
import { withCORS } from '../../lib/cors';

type Dir = Record<string, { accountName?: string; accountId?: string }>;

export default async function handler(req: any, res: any) {
  withCORS(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).end();

  const siteId = String(req.query.siteId ?? '').trim();
  const entry  = (directory as Dir)[siteId];

  const valid = !!entry;
  return res.status(200).json({
    valid,
    accountName: valid ? (entry.accountName ?? null) : null,
    accountId:   valid ? (entry.accountId   ?? null) : null
  });
}
