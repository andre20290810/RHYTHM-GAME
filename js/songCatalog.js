// Loads the song catalog and per-song manifests. The engine never hardcodes
// a song id, title, audio path, background path or chart path - everything
// comes from songs/index.json + each song's manifest.json. Adding a new
// song means adding a new folder + one line in songs/index.json; no engine
// code changes.
const BASE = "songs/";

export async function loadCatalog() {
  const res = await fetch(`${BASE}index.json`);
  const list = await res.json();
  return list; // [{ id, manifest }]
}

export async function loadManifest(entry) {
  const res = await fetch(`${BASE}${entry.manifest}`);
  const manifest = await res.json();
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
  const res = await fetch(`${manifest._dir}${rel}`);
  const chart = await res.json();
  return chart; // { difficulty, bpm, duration_sec, notes: [{time, lane, type, duration?}] }
}
