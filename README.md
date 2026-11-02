# Noise Inverted Metronome

A free, browser-based **noise generator with an inverted metronome**: continuous white, pink or brown noise that drops into silence on every beat. Set the tempo, choose how long the silence lasts, and shape the sound with a three-band frequency mixer.

**Live demo:** https://evgenytsitsorin.github.io/BrainSilencer/  
**Repository:** https://github.com/EvgenyTsitsorin/BrainSilencer/

## What is an inverted metronome?

A normal metronome marks each beat with a click. An inverted metronome does the opposite: the sound plays continuously and each beat is a short moment of silence. It can be useful for rhythm and timing practice, for developing an internal pulse, or as a background sound with a gentle rhythmic structure.

## Features

- Four noise profiles: Ultimate (adjustable), White, Pink and Brown
- Three-band frequency mixer (low 40–250 Hz, mid 250–3000 Hz, high 3000–12000 Hz)
- Inverted metronome: 30–240 BPM, 0–1000 ms of silence, short fades to avoid clicks
- Real-time waveform visualizer
- Sound is generated locally with the Web Audio API and an `AudioWorklet`; nothing is recorded or uploaded
- Plain HTML, CSS and JavaScript: no build step, no dependencies

## Run locally

`AudioWorklet` needs a secure context (HTTPS or `localhost`), so opening `index.html` directly from disk (`file://`) will not work. Serve the folder instead:

```bash
python3 -m http.server 8000
# or
npx serve .
```

Then open http://localhost:8000.

## Deploy to GitHub Pages

1. Push this folder to the `BrainSilencer` repository: https://github.com/EvgenyTsitsorin/BrainSilencer/
2. Go to **Settings → Pages**, choose **Deploy from a branch**, select `main` and `/ (root)`, and save.
3. After a minute or two the site is available at https://evgenytsitsorin.github.io/BrainSilencer/

## Project structure

| File | Purpose |
| --- | --- |
| `index.html` | Page markup and SEO tags (meta, Open Graph, Twitter, JSON-LD) |
| `style.css` | Styles |
| `app.js` | UI logic, audio graph setup, visualizer |
| `noise-processor.js` | `AudioWorklet` that generates the noise and applies the metronome gate |
| `favicon.svg`, `og-image.png` | Icon and social preview image |
| `robots.txt`, `sitemap.xml` | Search engine files |

## Browser support

Current versions of Chrome, Edge, Firefox and Safari (anything with `AudioWorklet` support).

## License

MIT
