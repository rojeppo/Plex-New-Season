const fs = require('fs');

const PLEX_URL     = process.env.PLEX_URL;
const PLEX_TOKEN   = process.env.PLEX_TOKEN;
const TVDB_API_KEY = process.env.TVDB_API_KEY;

if (!PLEX_URL || !PLEX_TOKEN) {
  console.error('Missing PLEX_URL or PLEX_TOKEN environment variables.');
  process.exit(1);
}
if (!TVDB_API_KEY) {
  console.error('Missing TVDB_API_KEY environment variable.');
  process.exit(1);
}

// ── Config ───────────────────────────────────────────────────────────────────
const config = {
  ownerName:    process.env.OWNER_NAME    || 'My',
  siteTitle:    process.env.SITE_TITLE    || 'Episode Calendar',
  defaultTheme: process.env.DEFAULT_THEME || 'system',
};
fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
console.log('config.json written:', config);

const WINDOW_DAYS = parseInt(process.env.CALENDAR_WINDOW_DAYS || '90', 10);
const TVDB_BASE = 'https://api4.thetvdb.com/v4';

// ── Plex helpers ─────────────────────────────────────────────────────────────
async function plexGet(p) {
  const sep = p.includes('?') ? '&' : '?';
  const url = `${PLEX_URL}${p}${sep}X-Plex-Token=${PLEX_TOKEN}&X-Plex-Container-Start=0&X-Plex-Container-Size=5000`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Plex returned HTTP ${res.status} for ${p}`);
  return res.json();
}

// Extract TVDB ID from Plex's Guid array (new agent) or legacy guid string
function extractTvdbId(item) {
  if (Array.isArray(item.Guid)) {
    const g = item.Guid.find(g => g.id?.startsWith('tvdb://'));
    if (g) return g.id.replace('tvdb://', '');
  }
  if (item.guid) {
    const m = item.guid.match(/thetvdb:\/\/(\d+)/);
    if (m) return m[1];
  }
  return null;
}

// ── TVDB helpers ─────────────────────────────────────────────────────────────
// v4 auth is a login step (apikey -> short-lived JWT), not a flat query-param key like TMDb.
let tvdbToken = null;

async function tvdbLogin() {
  const res = await fetch(`${TVDB_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: TVDB_API_KEY }),
  });
  if (!res.ok) throw new Error(`TVDB login failed: HTTP ${res.status}`);
  const data = await res.json();
  tvdbToken = data.data?.token;
  if (!tvdbToken) throw new Error('TVDB login response had no token.');
}

async function tvdbGet(path) {
  const res = await fetch(`${TVDB_BASE}${path}`, {
    headers: { Authorization: `Bearer ${tvdbToken}` },
  });
  if (!res.ok) throw new Error(`TVDB returned HTTP ${res.status} for ${path}`);
  return res.json();
}

async function getSeriesExtended(tvdbId) {
  const json = await tvdbGet(`/series/${tvdbId}/extended`);
  return json.data;
}

async function getSeasonExtended(seasonId) {
  const json = await tvdbGet(`/seasons/${seasonId}/extended`);
  return json.data;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await tvdbLogin();
  console.log('Logged in to TVDB.');

  console.log('Connecting to Plex...');
  const libData  = await plexGet('/library/sections');
  const sections = (libData.MediaContainer?.Directory || []).filter(s => s.type === 'show');
  console.log(`Found ${sections.length} TV section(s).`);

  // Previous run's season counts, so we can tell a *new* season from one we already knew about.
  let prevState = {};
  try {
    prevState = JSON.parse(fs.readFileSync('seasons-state.json', 'utf8'));
    console.log(`Loaded previous state for ${Object.keys(prevState).length} show(s).`);
  } catch (e) {
    console.log('No previous seasons-state.json found — starting fresh baseline (no announcements will fire this run).');
  }

  const nextState  = {};
  const upcoming   = [];
  const newSeasons = [];

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const windowStart = new Date(today); windowStart.setDate(windowStart.getDate() - 3);
  const windowEnd   = new Date(today); windowEnd.setDate(windowEnd.getDate() + WINDOW_DAYS);

  for (const sec of sections) {
    console.log(`Scanning section: ${sec.title}`);
    const data  = await plexGet(`/library/sections/${sec.key}/all?includeGuids=1`);
    const items = data.MediaContainer?.Metadata || [];
    console.log(`  ${items.length} show(s) found.`);

    for (const item of items) {
      const tvdbId = extractTvdbId(item);
      if (!tvdbId) {
        console.warn(`  Skipping "${item.title}" — no TVDB id from Plex.`);
        continue;
      }

      let series;
      try {
        series = await getSeriesExtended(tvdbId);
      } catch (e) {
        console.warn(`  Could not fetch TVDB series ${tvdbId} (${item.title}): ${e.message}`);
        continue;
      }

      const title  = series.name || item.title;
      const poster = series.image || null;

      // "official" = the standard aired/season order. Skip DVD/absolute/alternate orderings
      // and specials (season 0).
      const officialSeasons = (series.seasons || [])
        .filter(s => s.type?.type === 'official' && s.number > 0);

      if (!officialSeasons.length) continue;

      const maxSeason = Math.max(...officialSeasons.map(s => s.number));
      nextState[tvdbId] = { title, maxSeason };

      const prevMax = prevState[tvdbId]?.maxSeason;
      if (prevMax !== undefined && maxSeason > prevMax) {
        newSeasons.push({ tvdbId, title, poster, seasonNumber: maxSeason });
      }

      // Only pull episode-level detail for the latest couple of seasons, so the number of
      // TVDB calls stays bounded regardless of how deep a show's back catalog goes.
      const seasonsToCheck = officialSeasons
        .sort((a, b) => b.number - a.number)
        .slice(0, 2);

      for (const seasonStub of seasonsToCheck) {
        let season;
        try {
          season = await getSeasonExtended(seasonStub.id);
        } catch (e) {
          console.warn(`  Could not fetch season ${seasonStub.number} for "${title}": ${e.message}`);
          continue;
        }

        for (const ep of season.episodes || []) {
          if (!ep.aired) continue;
          const airDate = new Date(ep.aired);
          if (airDate < windowStart || airDate > windowEnd) continue;

          upcoming.push({
            tvdbId,
            title,
            poster,
            seasonNumber: ep.seasonNumber ?? seasonStub.number,
            episodeNumber: ep.number,
            airDate: ep.aired,
          });
        }
      }
    }
  }

  upcoming.sort((a, b) => a.airDate.localeCompare(b.airDate));
  newSeasons.sort((a, b) => a.title.localeCompare(b.title));

  fs.writeFileSync('seasons-state.json', JSON.stringify(nextState, null, 2));

  const output = { upcoming, newSeasons, updatedAt: new Date().toISOString() };
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));

  console.log(`Done. ${upcoming.length} upcoming episode(s), ${newSeasons.length} newly announced season(s).`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
