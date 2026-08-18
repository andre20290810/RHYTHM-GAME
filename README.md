# RHYTHM-GAME

Piano-tile style rhythm game engine (HTML / CSS / vanilla JS). Runs in any
modern browser, tuned for landscape mobile play with keyboard (D/F/J/K) or
multitouch support on phones.

The engine is song-agnostic: nothing under `js/` references a specific
track. Every song lives entirely under `songs/<song-id>/` and is described
by a `manifest.json`.

## Run locally

Any static file server works (the app fetches JSON/audio, so `file://`
won't work due to CORS):

```
python3 -m http.server 8080
# open http://localhost:8080/
```

## Project layout

```
index.html, css/, js/        engine (song-agnostic)
songs/index.json              catalog of available songs
songs/<song-id>/manifest.json title, bpm, audio path, background, chart paths
songs/<song-id>/audio.mp3
songs/<song-id>/charts/*.json EASY / NORMAL / HARD note charts
tools/analyze_audio.py        audio -> analysis.json (BPM, beats, onsets, sections)
tools/generate_chart.py       analysis.json -> EASY/NORMAL/HARD chart JSON
```

## Adding a new song

1. Create `songs/<new-song-id>/audio.mp3`.
2. `python3 tools/analyze_audio.py songs/<new-song-id>/audio.mp3 -o songs/<new-song-id>/analysis.json`
3. `python3 tools/generate_chart.py songs/<new-song-id>/analysis.json -o songs/<new-song-id>/charts`
4. Write `songs/<new-song-id>/manifest.json` (copy an existing one).
5. Add an entry to `songs/index.json`.
6. (Optional) drop a background video next to `audio.mp3` and set
   `"background": {"type": "video", "src": "background.mp4"}` in the
   manifest - no engine code changes needed.

## Chart JSON format

```json
{ "time": 12.420, "lane": 1, "type": "tap" }
{ "time": 18.250, "lane": 2, "type": "hold", "duration": 1.2 }
```

`time` is the absolute playback position in seconds; lanes are `0..3`.

## Tuning

Judge windows, note travel speed and scoring live in `js/constants.js`.
