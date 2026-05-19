const { parse } = require('node-html-parser');

// Ourlads team URL format: /nfldepthcharts/depthchart/[TEAM_ID]
// Team IDs discovered from their all-teams index page
const TEAM_IDS = {
  ARI: 'ARI', ATL: 'ATL', BAL: 'BAL', BUF: 'BUF',
  CAR: 'CAR', CHI: 'CHI', CIN: 'CIN', CLE: 'CLE',
  DAL: 'DAL', DEN: 'DEN', DET: 'DET', GB:  'GB',
  HOU: 'HOU', IND: 'IND', JAX: 'JAX', KC:  'KC',
  LAC: 'LAC', LAR: 'LAR', LV:  'LV',  MIA: 'MIA',
  MIN: 'MIN', NE:  'NE',  NO:  'NO',  NYG: 'NYG',
  NYJ: 'NYJ', PHI: 'PHI', PIT: 'PIT', SEA: 'SEA',
  SF:  'SF',  TB:  'TB',  TEN: 'TEN', WAS: 'WAS',
};

const ALL_TEAMS  = Object.keys(TEAM_IDS);
const OURLADS_BASE = 'https://www.ourlads.com/nfldepthcharts/depthchart';

const cache = { data: null, ts: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000;

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.ourlads.com/nfldepthcharts/',
  'Connection': 'keep-alive',
};

// ─── Scraper ──────────────────────────────────────────────────────────────────

async function scrapeTeamDepthChart(teamAbbr) {
  const teamId = TEAM_IDS[teamAbbr];
  if (!teamId) throw new Error(`Unknown team: ${teamAbbr}`);

  const url = `${OURLADS_BASE}/${teamId}`;
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`Ourlads fetch failed for ${teamAbbr}: HTTP ${res.status}`);

  const html = await res.text();
  const root = parse(html);
  const depthMap = {};
  const RELEVANT = new Set(['QB','RB','FB','WR','LWR','RWR','SWR','TE','K']);

  root.querySelectorAll('tr').forEach((row) => {
    const cells = row.querySelectorAll('td');
    // Need at least 3 cells: position, jersey#, player name
    if (cells.length < 3) return;

    const rawPos  = cells[0].text.trim().toUpperCase().replace(/[^A-Z]/g, '');
    const basePos = rawPos.replace(/\d+$/, '');
    if (!RELEVANT.has(basePos) && !RELEVANT.has(rawPos)) return;

    // Skip cells[1] (jersey number) — start at cells[2] for actual players
    // Every 2 cells after that is jersey#, then player name
    let depthSlot = 1;
    for (let i = 2; i < cells.length; i += 2) {
      const anchor = cells[i].querySelector('a');
      const raw    = anchor ? anchor.text.trim() : cells[i].text.trim();
      const name   = formatName(raw);
      if (name && name.length > 2) {
        depthMap[`${rawPos}${depthSlot}`] = name;
        depthSlot++;
      }
    }
  });

  return depthMap;
}

function cleanName(raw) {
  return raw
    .replace(/\(Q\)|\(O\)|\(IR\)|\(D\)|\(P\)|\(DNR\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatName(raw) {
  // Remove contract/draft suffixes like "17/1", "SF24", "CF26", "T/NYJ", "U/Sea"
  let name = raw
    .replace(/\b(SF|CF|T|U)[\w\/]+\d*/gi, '')
    .replace(/\b\d{2}\/\d+\b/g, '')
    .replace(/\(Q\)|\(O\)|\(IR\)|\(D\)|\(P\)|\(DNR\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Flip "Last, First" → "First Last"
  if (name.includes(',')) {
    const [last, first] = name.split(',').map(s => s.trim());
    name = `${first} ${last}`.trim();
  }

  // Title case (Ourlads uses ALL CAPS for top players)
  name = name.replace(/\b\w+/g, w =>
    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );

  return name.length > 2 ? name : '';
}

// ─── Debug helper ─────────────────────────────────────────────────────────────

async function debugRawHtml(teamAbbr) {
  const teamId = TEAM_IDS[teamAbbr] ?? teamAbbr;
  const url    = `${OURLADS_BASE}/${teamId}`;
  const res    = await fetch(url, { headers: FETCH_HEADERS });
  return await res.text();
}

// ─── Vercel handler ───────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const teamParam = (req.query.team ?? 'all').toUpperCase();

  // Debug mode — dump raw HTML for a single team
  if (req.query.debug === '1') {
    const html = await debugRawHtml(teamParam === 'ALL' ? 'KC' : teamParam);
    return res.status(200).send(html);
  }

  try {
    if (teamParam === 'ALL') {
      if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
        return res.status(200).json({ ok: true, cached: true, data: cache.data });
      }

      const BATCH   = 6;
      const allData = {};

      for (let i = 0; i < ALL_TEAMS.length; i += BATCH) {
        const batch   = ALL_TEAMS.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map(async (abbr) => ({ abbr, chart: await scrapeTeamDepthChart(abbr) }))
        );
        results.forEach((r) => {
          if (r.status === 'fulfilled') allData[r.value.abbr] = r.value.chart;
          else console.error('Scrape failed:', r.reason);
        });
        if (i + BATCH < ALL_TEAMS.length) await sleep(600);
      }

      cache.data = allData;
      cache.ts   = Date.now();

      return res.status(200).json({ ok: true, cached: false, data: allData });
    }

    if (!TEAM_IDS[teamParam]) {
      return res.status(400).json({ ok: false, error: `Unknown team: ${teamParam}` });
    }

    const chart = await scrapeTeamDepthChart(teamParam);
    return res.status(200).json({ ok: true, data: { [teamParam]: chart } });

  } catch (err) {
    console.error('depth-charts error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
