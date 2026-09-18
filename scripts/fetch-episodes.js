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

const TVDB_BASE = 'https://api4.thetvdb.com/v4';
const BACKWARD_CONTEXT_DAYS = 3; // show a few recently-aired days for scrolling context — no forward cap

const EXCLUDED_SECTIONS = (process.env.EXCLUDED_SECTIONS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

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
// v4 auth is a login step (apikey -> short-lived JWT), not a flat query-param key.
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

async function getSeriesTranslation(tvdbId, lang) {
  try {
    const json = await tvdbGet(`/series/${tvdbId}/translations/${lang}`);
    return json.data;
  } catch (e) {
    return null; // no English translation on file for this series — fall back below
  }
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
  const sections = (libData.MediaContainer?.Directory || [])
    .filter(s => s.type === 'show')
    .filter(s => !EXCLUDED_SECTIONS.includes(s.title.toLowerCase()));
  console.log(`Found ${sections.length} TV section(s).`);

  // Previous run's known season numbers per show — used only to badge a season "New",
  // not to gate whether it's shown (that's what changed: upcoming seasons are now a
  // standing list, not a one-time flash on the day they're first seen).
  let prevState = {};
  try {
    prevState = JSON.parse(fs.readFileSync('seasons-state.json', 'utf8'));
    console.log(`Loaded previous state for ${Object.keys(prevState).length} show(s).`);
  } catch (e) {
    console.log('No previous seasons-state.json found — starting fresh (nothing badged "New" this run).');
  }

  const nextState = {};
  const upcomingEpisodes = [];
  const upcomingSeasons  = [];

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const backwardCutoff = new Date(today);
  backwardCutoff.setDate(backwardCutoff.getDate() - BACKWARD_CONTEXT_DAYS);

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

      const translation = await getSeriesTranslation(tvdbId, 'eng');
      const title  = translation?.name || item.title || series.name;
      const poster = series.image || null;

      // "official" = the standard aired/season order. Skip DVD/absolute/alternate orderings
      // and specials (season 0).
      const officialSeasons = (series.seasons || [])
        .filter(s => s.type?.type === 'official' && s.number > 0)
        .sort((a, b) => b.number - a.number);

      if (!officialSeasons.length) continue;

      nextState[tvdbId] = { title, seenSeasons: officialSeasons.map(s => s.number) };
      const prevSeenSeasons = new Set(prevState[tvdbId]?.seenSeasons || []);

      // Only pull episode-level detail for the latest couple of seasons, so TVDB call
      // volume stays bounded regardless of how deep a show's back catalog goes.
      const seasonsToCheck = officialSeasons.slice(0, 2);

      for (const seasonStub of seasonsToCheck) {
        let season;
        try {
          season = await getSeasonExtended(seasonStub.id);
        } catch (e) {
          console.warn(`  Could not fetch season ${seasonStub.number} for "${title}": ${e.message}`);
          continue;
        }

        const airedEpisodes = (season.episodes || []).filter(ep => ep.aired);

        if (airedEpisodes.length === 0) {
          // TVDB knows this season exists but no episode has an air date yet.
          // `season.year` is TVDB's coarse "expected year" field when a full date isn't
          // set — verify this field name once you're on live data; if it doesn't come
          // through, this just falls back to "Date TBA" on the site rather than erroring.
          upcomingSeasons.push({
            tvdbId,
            title,
            poster,
            seasonNumber: seasonStub.number,
            year: season.year || null,
            isNew: !prevSeenSeasons.has(seasonStub.number),
          });
          continue;
        }

        for (const ep of airedEpisodes) {
          const airDate = new Date(ep.aired);
          if (airDate < backwardCutoff) continue; // no forward cap — list everything TVDB has scheduled
          upcomingEpisodes.push({
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

  upcomingEpisodes.sort((a, b) => a.airDate.localeCompare(b.airDate));
  upcomingSeasons.sort((a, b) => {
    if (a.year && b.year) return a.year.localeCompare(b.year);
    if (a.year) return -1;
    if (b.year) return 1;
    return a.title.localeCompare(b.title);
  });

  fs.writeFileSync('seasons-state.json', JSON.stringify(nextState, null, 2));

  const output = { upcomingEpisodes, upcomingSeasons, updatedAt: new Date().toISOString() };
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));

  console.log(`Done. ${upcomingEpisodes.length} upcoming episode(s), ${upcomingSeasons.length} season(s) awaiting air dates.`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
