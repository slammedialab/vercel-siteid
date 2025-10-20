// lib/site-directory.ts
/**
 * Build a directory map from a Google Sheet CSV.
 * Requires env: SHEET_CSV_URL
 * Optional:    CACHE_TTL_SECONDS (default 300)
 */

export type DirEntry = { accountName?: string; accountId?: string };
export type DirMap = Record<string, DirEntry>;

const CSV_URL = process.env.SHEET_CSV_URL;
const TTL = Math.max(30, Number(process.env.CACHE_TTL_SECONDS ?? 300));

type CacheShape = { at: number; map: DirMap };
const g = globalThis as any;
g.__SITE_DIR_CACHE__ ??= null as CacheShape | null;

/** Minimal CSV parser with quote support */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = '';
  let i = 0, q = false;

  while (i < text.length) {
    const ch = text[i];

    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      cell += ch; i++; continue;
    }

    if (ch === '"') { q = true; i++; continue; }
    if (ch === ',') { cur.push(cell); cell = ''; i++; continue; }
    if (ch === '\n') { cur.push(cell); rows.push(cur); cur = []; cell = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }

    cell += ch; i++;
  }
  // last cell
  if (cell.length || cur.length) { cur.push(cell); rows.push(cur); }
  return rows;
}

/** Flexible header resolver (case-insensitive, accepts synonyms) */
function resolveHeaderIndex(headers: string[], names: string[]): number {
  const lc = headers.map(h => h.trim().toLowerCase());
  for (const alias of names) {
    const idx = lc.indexOf(alias.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Convert CSV → DirMap */
function rowsToMap(rows: string[][]): DirMap {
  if (!rows.length) return {};
  const headers = rows[0].map(h => h.trim());
  const body = rows.slice(1);

  // Accept common aliases based on your screenshot (sitelist, siteid), plus robust fallbacks
  const siteIdIdx     = resolveHeaderIndex(headers, ['siteid', 'site_id', 'id']);
  const accountNameIdx= resolveHeaderIndex(headers, ['sitelist', 'accountname', 'account_name', 'name']);
  const accountIdIdx  = resolveHeaderIndex(headers, ['accountid', 'account_id']);

  if (siteIdIdx === -1) {
    throw new Error(`Sheet CSV is missing a "siteid" column (or alias). Found headers: ${headers.join(', ')}`);
  }

  const map: DirMap = {};
  for (const r of body) {
    const rawSiteId = (r[siteIdIdx] ?? '').trim();
    if (!rawSiteId) continue;
    const entry: DirEntry = {};
    if (accountNameIdx !== -1) entry.accountName = (r[accountNameIdx] ?? '').trim() || undefined;
    if (accountIdIdx   !== -1) entry.accountId   = (r[accountIdIdx]   ?? '').trim() || undefined;
    map[rawSiteId] = entry;
  }
  return map;
}

/** Fetch + cache the directory map */
export async function getDirectoryMap(): Promise<DirMap> {
  // If CSV_URL is not set, fall back to local JSON (keeps old behavior working).
  if (!CSV_URL) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const local = await import('../data/site-directory.json');
    return (local.default || local) as DirMap;
  }

  const now = Date.now();
  if (g.__SITE_DIR_CACHE__ && now - g.__SITE_DIR_CACHE__.at < TTL * 1000) {
    return g.__SITE_DIR_CACHE__.map;
  }

  const r = await fetch(CSV_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Failed to fetch SHEET_CSV_URL (${r.status})`);
  const text = await r.text();

  const rows = parseCSV(text);
  const map = rowsToMap(rows);
  g.__SITE_DIR_CACHE__ = { at: now, map };
  return map;
}
