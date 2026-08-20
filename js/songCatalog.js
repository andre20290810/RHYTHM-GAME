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

  return {
    ...manifest,
    _dir: `${BASE}${dir}`,
    audioUrl: `${BASE}${dir}${manifest.audio}`,
    backgroundUrl,
    jacketUrl,
  };
}

export async function loadChart(manifest, difficulty) {
  const rel = manifest.difficulties[difficulty];
  if (!rel) throw new Error(`No chart for difficulty ${difficulty}`);
  return fetchJson(`${manifest._dir}${rel}`); // { difficulty, bpm, duration_sec, notes: [...] }
}
