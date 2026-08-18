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

export async function loadManifest(entry) {
  const manifest = await fetchJson(`${BASE}${entry.manifest}`);
  const dir = entry.manifest.substring(0, entry.manifest.lastIndexOf("/") + 1);
  return {
    ...manifest,
    _dir: `${BASE}${dir}`,
    audioUrl: `${BASE}${dir}${manifest.audio}`,
    backgroundUrl:
      manifest.background && manifest.background.type === "video"
        ? `${BASE}${dir}${manifest.background.src}`
        : null,
  };
}

export async function loadChart(manifest, difficulty) {
  const rel = manifest.difficulties[difficulty];
  if (!rel) throw new Error(`No chart for difficulty ${difficulty}`);
  return fetchJson(`${manifest._dir}${rel}`); // { difficulty, bpm, duration_sec, notes: [...] }
}
