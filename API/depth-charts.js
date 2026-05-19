// =============================================================================
// FILE 3 OF 6 — api/depth-charts.js   (Vercel Serverless Function)
//
// Deploy this file to a Vercel project at /api/depth-charts.js
// It will be available at: https://YOUR-APP.vercel.app/api/depth-charts
//
// Query params:
//   ?team=SF          — single team (Ourlads abbreviation)
//   ?team=all         — all 32 teams (slower, ~4-6s, cached)
//
// Response: { [teamAbbr]: { [positionKey]: playerName } }
// Example:  { "SF": { "QB1": "Brock Purdy", "WR1": "Deebo Samuel", ... } }
//
// Dependencies — add to your Vercel project's package.json:
//   "node-fetch": "^3.3.2"
//   "node-html-parser": "^6.1.13"
// =============================================================================

import fetch from 'node-fetch';
import { parse } from 'node-html-parser';

// Ourlads uses its own team slug format — map standard NFL abbrs to Ourlads slugs
const TEAM_SLUGS = {
  ARI: 'arizona-cardinals',    ATL: 'atlanta-falcons',
  BAL: 'baltimore-ravens',     BUF: 'buffalo-bills',
  CAR: 'carolina-panthers',    CHI: 'chicago-bears',
  CIN: 'cincinnati-bengals',   CLE: 'cleveland-browns',
  DAL: 'dallas-cowboys',       DEN: 'denver-broncos',
  DET: 'detroit-lions',        GB:  'green-bay-packers',
  HOU: 'houston-texans',       IND: 'indianapolis-colts',
  JAX: 'jacksonville-jaguars', KC:  'kansas-city-chiefs',
  LAC: 'los-angeles-chargers', LAR: 'los-angeles-rams',
  LV:  'las-vegas-raiders',    MIA: 'miami-dolphins',
  MIN: 'minnesota-vikings',    NE:  'new-england-patriots',
  NO:  'new-orleans-saints',   NYG: 'new-york-giants',
  NYJ: 'new-york-jets',        PHI: 'philadelphia-eagles',
  PIT: 'pittsburgh-steelers',  SEA: 'seattle-seahawks',
  SF:  'san-francisco-49ers',  TB:  'tampa-bay-buccaneers',
  TEN: 'tennessee-titans',     WAS: 'washington-commanders',
};

const ALL_TEAMS = Object.keys(TEAM_SLUGS);
const OURLADS_BASE = 'https://www.ourlads.com/nfldepthcharts/depthchart';

// Simple in-memory cache — Vercel functions are warm for ~5 min
const cache = { data: null, ts: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Scraper ──────────────────────────────────────────────────────────────────

async function scrapeTeamDepthChart(teamAbbr) {
  const slug = TEAM_SLUGS[teamAbbr];
  if (!slug) throw new Error(`Unknown team abbreviation: ${teamAbbr}`);

  const url = `${OURLADS_BASE}/${slug}`;
  const res = await fetch(url, {
    headers: {
      // Mimic a real browser — Ourlads blocks default Node user-agents
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.ourlads.com/',
    },
  });

  if (!res.ok) throw new Error(`Ourlads fetch failed for ${teamAbbr}: HTTP ${res.status}`);

  const html = await res.text();
  const root = parse(html);

  const depthMap = {};

  // Ourlads depth chart table: each row has position label + player cells
  // Structure: <table class="dc-table"> <tr> <td class="dc-pos">QB</td> <td>Name</td>...
  const rows = root.querySelectorAll('tr');

  rows.forEach((row) => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) return;

    const posCell = cells[0];
    const posLabel = posCell.text.trim().toUpperCase();

    // Only capture fantasy-relevant positions
    const relevantPos = ['QB', 'RB', 'WR', 'TE', 'K', 'FB', 'LWR', 'RWR', 'SWR'];
    const basePos = posLabel.replace(/\d/g, '');
    if (!relevantPos.includes(basePos) && !relevantPos.includes(posLabel)) return;

    // Each subsequent cell is depth level 1, 2, 3, 4
    cells.slice(1).forEach((cell, idx) => {
      const playerName = extractPlayerName(cell.text.trim());
      if (!playerName) return;
      const key = `${posLabel}${idx + 1}`; // e.g. "QB1", "WR2"
      depthMap[key] = playerName;
    });
  });

  return depthMap;
}

/**
 * Cleans player name text from Ourlads cells.
 * Removes injury tags like "(Q)", "(O)", "(IR)" and extra whitespace.
 */
function extractPlayerName(raw) {
  return raw
    .replace(/\(Q\)|\(O\)|\(IR\)|\(D\)|\(P\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Vercel handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS — allow your Expo/RN app to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const teamParam = (req.query.team ?? 'all').toUpperCase();

  try {
    if (teamParam === 'ALL') {
      // Return cached full dataset if fresh
      if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
        return res.status(200).json({ ok: true, cached: true, data: cache.data });
      }

      // Fetch all 32 teams in parallel (batched to avoid overwhelming Ourlads)
      const BATCH = 8;
      const allData = {};

      for (let i = 0; i < ALL_TEAMS.length; i += BATCH) {
        const batch = ALL_TEAMS.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map(async (abbr) => ({ abbr, chart: await scrapeTeamDepthChart(abbr) }))
        );
        results.forEach((r) => {
          if (r.status === 'fulfilled') allData[r.value.abbr] = r.value.chart;
          else console.error(`Failed ${r.reason}`);
        });
        // Small delay between batches to be respectful
        if (i + BATCH < ALL_TEAMS.length) await sleep(500);
      }

      cache.data = allData;
      cache.ts   = Date.now();

      return res.status(200).json({ ok: true, cached: false, data: allData });
    }

    // Single team
    if (!TEAM_SLUGS[teamParam]) {
      return res.status(400).json({ ok: false, error: `Unknown team: ${teamParam}` });
    }
    const chart = await scrapeTeamDepthChart(teamParam);
    return res.status(200).json({ ok: true, data: { [teamParam]: chart } });

  } catch (err) {
    console.error('depth-charts error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
