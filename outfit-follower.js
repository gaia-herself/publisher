// outfit-follower.js
// Step 1: read the server clock, and in the morning phase switch this account to its own
// saved F1 / F2 / F3 outfit (makeup included). Safe to run repeatedly.
// Set env OUTFIT_DRY_RUN=1 to log what it WOULD do without changing anything.

const BASE = 'https://v3.g.ladypopular.com';
const DEFAULT_NAMES = ['f1', 'f2', 'f3'];
const EVENING_FROM_HOUR = 12;               // server time: 12:00 onwards = evening phase
const DRY_RUN = process.env.OUTFIT_DRY_RUN === '1';

const HEADERS = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'x-requested-with': 'XMLHttpRequest',
  referer: `${BASE}/wardrobe.php?wardrobetype=lady&archive=0&category_id%5B0%5D=9`
};

// ---------------------------------------------------------------- server clock
async function getServerSeconds(page) {
  const res = await page.request.get(`${BASE}/vip_shop.php?tab=dollars`, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      referer: `${BASE}/welcome.php`
    }
  });
  if (!res.ok()) throw new Error(`vip_shop.php returned HTTP ${res.status()}`);
  const html = await res.text();

  // 1) the page's own server clock: var currentTime = new Date('November 23, 2026 09:59:18')
  let fromClock = null;
  const m = html.match(/var currentTime = new Date\('([^']+)'\)/);
  if (m) {
    const t = m[1].match(/(\d{1,2}):(\d{2}):(\d{2})\s*$/);
    if (t) fromClock = { raw: m[1], seconds: +t[1] * 3600 + +t[2] * 60 + +t[3] };
  }

  // 2) backup: seconds left until the daily reset (server midnight)
  let fromCountdown = null;
  const c = html.match(/"reset_daily_quests_time_left":\s*"?(\d+)"?/);
  if (c && +c[1] <= 86400) fromCountdown = { left: +c[1], seconds: (86400 - +c[1]) % 86400 };

  console.log(
    `🕒 Clock: ${fromClock ? fromClock.raw : 'not found'} | ` +
    `reset countdown: ${fromCountdown ? fromCountdown.left + 's left' : 'not found'}`
  );
  if (fromClock && fromCountdown && Math.abs(fromClock.seconds - fromCountdown.seconds) > 180) {
    console.log('⚠️ The server clock and the reset countdown disagree by more than 3 minutes.');
  }
  if (fromClock) return fromClock.seconds;
  if (fromCountdown) return fromCountdown.seconds;
  return null;
}

// ---------------------------------------------------------------- saved outfits
async function loadAllOutfits(page) {
  const all = [];
  let offset = 0;
  for (let i = 0; i < 20; i++) {
    const res = await page.request.post(`${BASE}/ajax/wardrobe/lady.php`, {
      headers: HEADERS,
      form: { action: 'loadOutfits', offset: String(offset) }
    });
    if (!res.ok()) throw new Error(`loadOutfits returned HTTP ${res.status()}`);
    const json = await res.json();
    if (json?.status !== 1 || !Array.isArray(json.outfits)) {
      throw new Error(`loadOutfits failed: ${JSON.stringify(json).slice(0, 300)}`);
    }
    all.push(...json.outfits);
    if (!json.has_more || json.outfits.length === 0) break;
    offset = Number.isFinite(Number(json.offset)) ? Number(json.offset) : offset + json.outfits.length;
  }
  return all;
}

async function revertToDefault(page) {
  const outfits = await loadAllOutfits(page);
  console.log(`📂 ${outfits.length} saved outfit(s): ${outfits.map(o => o.name).join(', ')}`);

  const defaults = outfits.filter(o =>
    DEFAULT_NAMES.includes(String(o.lowercase_name ?? o.name ?? '').trim().toLowerCase())
  );
  if (defaults.length === 0) {
    console.log('⚠️ No saved outfit named F1, F2 or F3 on this account. Leaving the look as it is.');
    return;
  }
  if (defaults.length > 1) {
    console.log(`⚠️ More than one default outfit found (${defaults.map(o => o.name).join(', ')}). Leaving the look as it is.`);
    return;
  }

  const target = defaults[0];
  console.log(`🎯 Default outfit: "${target.name}" (id ${target.id})`);
  if (DRY_RUN) {
    console.log('🧪 DRY RUN: would switch to it now. Nothing changed.');
    return;
  }

  const res = await page.request.post(`${BASE}/ajax/wardrobe/lady.php`, {
    headers: HEADERS,
    form: {
      action: 'changeOutfit',
      outfitId: String(target.id),
      wardrobetype: 'wardrobe',
      contenttype: '',
      contentid: '',
      page: '1',
      apply_appearance: 'true'
    }
  });
  if (!res.ok()) throw new Error(`changeOutfit returned HTTP ${res.status()}`);
  const json = await res.json();
  if (json?.status !== 1) throw new Error(`changeOutfit failed: ${JSON.stringify(json).slice(0, 300)}`);
  console.log(`✅ Switched to "${target.name}".`);
}

// ---------------------------------------------------------------- entry point
module.exports = async function runOutfitFollower(page) {
  console.log(DRY_RUN ? '👗 Outfit follower (DRY RUN)' : '👗 Outfit follower');

  const seconds = await getServerSeconds(page);
  if (seconds === null) {
    console.log('❌ Could not read the server time. Doing nothing; the look stays as it is.');
    return;
  }
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  console.log(`🕒 Server time: ${hh}:${mm}`);

  if (seconds >= EVENING_FROM_HOUR * 3600) {
    console.log('🌆 Evening phase (after noon, before midnight): dress-up is not built yet, nothing to do.');
    return;
  }

  console.log('🌅 Morning phase (after midnight, before noon): reverting to the default outfit.');
  await revertToDefault(page);
};
