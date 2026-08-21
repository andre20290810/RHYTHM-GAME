// Loads the song catalog and per-song manifests. The engine never hardcodes
// a song id, title, audio path, background path or chart path - everything
// comes from songs/index.json + each song's manifest.json. Adding a new
// song means adding a new folder + one line in songs/index.json; no engine
// code changes.
const BASE = "songs/";

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`データの取得に失敗しました (network error): ${url}`);
  }
  if (!res.ok) {
    throw new Error(`データの取得に失敗しました (HTTP ${res.status}): ${url}`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`データの解析に失敗しました (invalid JSON): ${url}`);
  }
}

export async function loadCatalog() {
  return fetchJson(`${BASE}index.json`); // [{ id, manifest }]
}

const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export async function loadManifest(entry) {
  const manifest = await fetchJson(`${BASE}${entry.manifest}`);
  const dir = entry.manifest.substring(0, entry.manifest.lastIndexOf("/") + 1);
  let backgroundUrl = null;
  if (manifest.background && manifest.background.type === "video") {
    const src = manifest.background.src;
    // A background video may be hosted externally (e.g. a CDN/object store)
    // instead of living in this repo - used as-is when it's already an
    // absolute URL, otherwise resolved relative to the song's folder.
    backgroundUrl = ABSOLUTE_URL_RE.test(src) ? src : `${BASE}${dir}${src}`;
  }
  // The difficulty-select screen's jacket art. Unlike audio/background,
  // this is a path from the SITE ROOT (e.g. "assets/images/jackets/...")
  // rather than the song's own folder, since jacket art commonly lives in
  // the shared assets/ tree instead of being duplicated per song - each
  // song's manifest just points at whichever image is its own (see
  // manifest.jacket). Used as-is, whether it's a root-relative path or
  // (for a future song) an absolute URL - no BASE/dir prefix applied.
  const jacketUrl = manifest.jacket || null;

  // Per-song gameplay-background display tuning (fit/position/scale) - an
  // optional { fit, position, scale } object nested under manifest.background
  // (see songs/nijiiro-eden-2/manifest.json for the first real use: its R2
  // video's own baked-in "虹色のエデン" title text sits close enough to the
  // left/right edges that the shared `cover` treatment every other song uses
  // crops it). Defaults below are exactly today's global CSS values (cover /
  // center center / no extra scale), so any song whose manifest doesn't set
  // these renders byte-for-byte as before - this is additive per-song data,
  // never a song-name branch in js/main.js or css/style.css.
  const bg = manifest.background || {};
  const backgroundFit = bg.fit || "cover";
  const backgroundPosition = bg.position || "center center";
  const backgroundScale = typeof bg.scale === "number" ? bg.scale : 1;
  // With object-fit:cover on a box exactly 100% of the viewport, WHICH axis
  // gets cropped is decided entirely by how the box's own aspect ratio
  // compares to the video's: crop is on left/right when boxAspect (w/h) is
  // SMALLER than the video's own aspect, and on top/bottom when boxAspect
  // is LARGER. heightPercent shrinks the video element's own height (still
  // width:100%, vertically re-centered - see main.js) below 100%, which
  // raises the box's effective aspect ratio (390 / (844*heightPercent/100)
  // grows as heightPercent shrinks) - shifting cover's crop away from
  // left/right and onto top/bottom, at the cost of a top/bottom letterbox
  // band (filled by #bg-layer's own background-color, same as `contain`
  // already does). 100 (full height, today's behavior for every song
  // without this field) never changes anything for songs that don't set it.
  const backgroundHeightPercent = typeof bg.heightPercent === "number" ? bg.heightPercent : 100;

  return {
    ...manifest,
    _dir: `${BASE}${dir}`,
    audioUrl: `${BASE}${dir}${manifest.audio}`,
    backgroundUrl,
    jacketUrl,
    backgroundFit,
    backgroundPosition,
    backgroundScale,
    backgroundHeightPercent,
  };
}

export async function loadChart(manifest, difficulty) {
  const rel = manifest.difficulties[difficulty];
  if (!rel) throw new Error(`No chart for difficulty ${difficulty}`);
  return fetchJson(`${manifest._dir}${rel}`); // { difficulty, bpm, duration_sec, notes: [...] }
}
