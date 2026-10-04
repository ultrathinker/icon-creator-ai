# Icon Creator AI

[![CI](https://github.com/ultrathinker/icon-creator-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/ultrathinker/icon-creator-ai/actions/workflows/ci.yml)

Ask an image model for many app-icon candidates at once, then get a finished cross-platform icon
pack from every candidate — plus a contact sheet that shows how each one looks at 64, 32 and
16 px, so you can pick what actually survives being small.

You describe the app in one sentence. The plugin sends that sentence to an image model (the
"Nano Banana" family), up to 16 requests, never more than 3 at a time, each with a different art
style from a curated list (flat glyph, glossy 3D, pixel art, neon, clay, low poly, …), at the
model's smallest size — cheap drafts. Immediately, with no approval step, every candidate becomes
a full icon set: Windows `.ico`, macOS `.icns`, the Linux hicolor tree, web favicons and PWA icons
(including an opaque apple-touch icon and a maskable one) and the master PNG. Claude looks at the
contact sheet, tells you which two or three work best at small sizes and why, and where
everything is. Follow-ups: "eight more" (same folder, numbered on, a new sheet file, nothing that
exists is touched), "more like number 3", "make the final in higher resolution" (a 1K run, which
also adds the 1024-px `.icns` slice).

- **Requirements:** Claude Code and Node 18 or newer. No npm packages — nothing to install.
- **A key you own:** Google AI Studio or OpenRouter. The plugin never runs without a key and
  never uses one it did not watch you configure.
- **Costs:** you pay your provider for what it generates (image output is usually billed per
  image; see your provider's pricing page). The plugin reports the usage the provider returns —
  it invents no prices. Drafts use the smallest size the model supports to keep runs cheap.

## Setup

1. Install the plugin (from this repository):
   `/plugin marketplace add ultrathinker/icon-creator-ai`, then install **Icon Creator AI** from
   it and enable it.
2. Get a key — one of:
   - Google AI Studio: <https://aistudio.google.com/apikey> (the Gemini image models),
   - OpenRouter: <https://openrouter.ai/settings/keys> (the same models behind OpenRouter).
3. `/plugin` → Installed Plugins → **Icon Creator AI** → **Configure options**. Paste the key
   into `Google API key` or `OpenRouter API key`. Both may be set; `Provider` picks `auto`
   (Google when its key is set, else OpenRouter), `google`, or `openrouter`. `Model` overrides
   the default (`gemini-3.1-flash-image` on Google, `google/gemini-3.1-flash-image` on
   OpenRouter) — leave it empty unless you know you want another model.
4. Say "make icons for my app" (or use `/icons`). If nothing is configured, the plugin explains
   the same steps and stops; it never asks for a key in the chat.

**Known caveat (keys):** sensitive plugin values are stored by Claude Code outside
`settings.json`, and there is an open-era bug where they sometimes do not persist across Claude
Code restarts ([claude-code#62442](https://github.com/anthropics/claude-code/issues/62442),
closed not-planned). The working path we could verify on this machine: re-open Configure options
after a restart and enter the key again — it works immediately for that session, and the plugin's
`check_setup` tool tells you (and Claude) whether a key is currently visible. A non-sensitive
value would persist in `settings.json`, but a key belongs in secure storage, so this plugin ships
the sensitive form only.

## How it works

- `mcp/server.mjs` — a dependency-free MCP server (stdio JSON-RPC) holding your key. Tools:
  `check_setup` (which providers have a key — booleans only; optional one-tiny-request verify),
  `list_styles`, `list_run` (a read-only merged view of a run folder: rounds, candidates, packs,
  sheets, pack name, next numbers), `generate_images` (prompt, count 1–16, size draft/large,
  out_dir or run_dir, background, styles, repeat_styles). It enforces
  the limits (max 3 parallel requests, max 2 retries per request on network errors / 429 / 5xx
  with `Retry-After` honoured, ~90 s per request, ~10 min per run, stop-at-once on a rejected key
  or exhausted credits), validates and normalises every returned image to PNG, and writes
  `<out_dir>/run-<timestamp>/candidate-<k>.png` plus a `run.json` (one entry per batch: prompt,
  styles, provider, usage, failures — no secrets). "Eight more" is a second call with `run_dir`
  set to that same run folder: the new candidates are numbered on from the highest number there
  (5, 6, 7, …) and take art styles the earlier batches did not use. **A continued run only ever
  adds files:** the new round is recorded in a new `batch-<n>.json`, and `run.json`, every
  earlier candidate, pack and sheet stay byte for byte as they were. An older flat `run.json` of
  this plugin works too. `run_dir` must be a real folder (no link in the path) whose `run.json`
  this plugin wrote; anything else is refused. Two continuations at the same time, even from two
  processes, both keep their images (a number taken meanwhile is skipped). `styles` plus `repeat_styles: true` is "more like
  number 3": every candidate in that style. `~` paths are refused (the server does not expand them).
- The background: the model is asked for one pure white (`#FFFFFF`) background, or pure black
  (`#000000`) for the two styles that would merge into white (neon, sticker), edge to edge, so
  that removing it leaves a transparent logo. A model left to pick "one solid colour" chose
  saturated ones (magenta, green) that removal handles badly. `background: "white"` or `"black"`
  forces one; `"as-described"` asks for no background at all, for the case where the user's own
  sentence names the background they want (that icon then keeps it); a later round in the same
  run folder keeps the last round's choice unless `background` is given again.
- `scripts/pack.mjs build --run <run folder>` — turns every candidate into a pack
  (`pack-<k>/`): the flat background is removed by flood fill from the edges (enclosed light
  areas survive), the master is cropped to the subject so that it fills 96 % of the square's
  longer side (`--fill <50-100>` changes that; a generated image has a wide empty margin that
  would swallow the picture at 32 and 16 px), and every size is a pure shrink of that master:
  the master is never upscaled to a larger size, so sizes above it are omitted and listed (a
  512-px draft master gives an `.icns` without its 1024-px slice and no `icon-1024.png`; ask for a
  `large` final for those). The 16 to 48 px renderings get a light sharpening (`--no-sharpen`
  turns it off; checked by eye on real candidates: 0.5 crisps eyes and edges, 1.0 starts to halo).
  The crop enlarges the generated pixels, typically
  1.3x (models draw the subject at about 70 % of the frame whatever the prompt asks), which adds
  no detail: the warnings say so when it is more than 1.6x, and a `large` run keeps the result
  sharp. An opaque tile with a picture inside it is cropped to the picture (the icon becomes a
  full-square tile of that colour; `--keep-tile` keeps the tile as drawn); `--no-crop` keeps the
  generated margins. A candidate whose prompt described its own background (`as-described` in the
  run records) is not stripped of it. Besides the master-based files the pack has two renderings
  of its own, because the master fills the square edge to edge and these two must not:
  `web/apple-touch-icon.png` is opaque (iOS paints transparency black) with a margin, and
  `web/icon-maskable-512.png` is opaque with the whole drawing inside the 80 % safe-zone circle
  (a 512-px master or larger). The colour behind them is the tile's colour, or white behind a dark
  subject and a dark neutral behind a light one; `site.webmanifest` carries it (with `start_url`,
  `display`, the maskable entry) and `head.html` a `theme-color`.
  The build also says when an outline melts into a dark or a light background
  (`fades-on-dark`, `fades-on-light`: the WCAG contrast of the drawing's edge below 2:1).
  Names and titles: `--name` is the file name inside the packs (a later round reuses the name of
  the earlier packs, so `app.ico` never appears beside `chess-clock.ico`), `--title` the human
  title. A build over existing packs refuses before writing anything and names the safe ways:
  `--only <numbers>` for later candidates, `--variant <label>` for a rebuild with other settings
  (writes `pack-<k>-<label>/` and `sheet-<label>-<n>.png` beside the old ones), `--force` only on purpose.
- `scripts/pack.mjs sheet --run <run folder>` — one contact sheet per eight candidates: each on
  a transparency checkerboard and a dark tile, plus its 64/32/16 px renderings, numbered with a
  built-in bitmap font. The icon fills its tile edge to edge (the 144 px previews) and the small
  renderings sit on tiles of exactly their own size: the sheet adds no margin of its own, so it
  shows an icon the way the real file looks. For a continued run, `build --only 5-12` makes just
  the new packs and `sheet --only 5-12` writes the new candidates to NEW sheet files numbered
  after the existing ones (`sheet-2.png`, eight per page): the first round's `sheet-1.png` is
  never rewritten. Without `--only`, the sheets of every candidate start at `sheet-1.png` again
  and need `--force` to replace an existing file. Under the previews one white strip holds the
  true-size 64, 32 and 16 px renderings: directly on the white under the checkerboard, each on a
  dark tile of exactly its own size under the dark preview.
- `skills/icon-creator-ai/SKILL.md` — drives the flow: one question (the count), the subject
  sentence, `check_setup`, `generate_images`, build, sheet, look, recommend, honest limits.

Only two hosts are ever contacted, hard-coded, HTTPS only: `generativelanguage.googleapis.com`
and `openrouter.ai`. Redirects to other hosts are refused; there is no endpoint override. Only
the prompt text and the request shape leave the machine; keys never appear in errors, files,
logs or the chat (a redaction layer proves this in tests with sentinel keys).

## Privacy

The prompt text (your one app sentence, wrapped with the fixed recipe and a style hint) is sent
to the provider you configured, with your key. Nothing else leaves the machine: no telemetry, no
analytics, no other requests. Keys are stored by Claude Code's plugin configuration (credential
store), read by the bundled server only from its own env mapping, and never written to any file
this plugin produces. See [PRIVACY.md](PRIVACY.md).

## Limits, honestly

- Results vary run to run; generated images carry the provider's invisible watermark (SynthID on
  Google). A logo from an image model may resemble existing marks and may not be protected by
  copyright. The provider's own terms apply to your account.
- Draft runs are 512 px (the smallest the model supports). The 1024-px master, `icon-1024.png` and
  the `.icns` slice of 1024 px need a `large` (1K) run — the plugin omits and lists those instead
  of making them from a smaller master. The crop to the subject does enlarge the generated pixels
  slightly, so a 512-px draft master is a little soft at 512 and 256 px; a `large` run is sharp.
  "Make number 3 the final in higher resolution" is a NEW generation in that style, not number 3
  enlarged (an image model has no way to enlarge one picture faithfully here).
- Google's default image model answers JPEG only (checked live; other models were not tried), so the plugin ships a small decoder for
  baseline JPEG (the common kind) and saves every candidate as PNG. A progressive JPEG, a WebP or
  any other format a provider might return is kept raw with a warning and is not packed (decoding
  those needs extra software this plugin deliberately does not bundle). JPEG compression leaves
  faint noise around hard edges.
- Background removal works on flat backgrounds, also when the subject touches the image edge or a
  corner (the whole border decides: at least 60 % of it one colour, the rest clearly not
  background); a candidate with a photo or gradient background
  keeps its background and is flagged (a saturated flat colour that the JPEG compression made
  slightly noisy can be flagged too: `--tolerance 60` removes it in that case; a kept background
  is then cropped to the subject as a full-square picture). A soft shadow that a model adds anyway (the recipe asks
  for none) can survive as a thin dark edge: regenerate that candidate or choose another style.
  A glow (neon) fades into its black background, which is removed by colour, so a faint dark rim or a
  black interior can remain on a checkerboard; the dark tile of the sheet shows what it looks like on dark.
- Node's `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set (Node 24 and newer); behind a
  proxy the error now carries its cause (for example `ENOTFOUND`) so it can be diagnosed.
- At most 3 requests in flight, always. A 16-candidate run is 16 billed images plus retries.

## What was verified how

- **Verified by running** (Windows 11, Node 24, `node --test tests/*.test.mjs`, 233 offline
  tests at 0.1.7): the PNG/ICO/ICNS writers and parsers, the JPEG decoder (compared pixel by pixel with
  libjpeg through Pillow: 4:4:4, 4:2:2, 4:2:0, grayscale, restart markers, sizes that are not a
  multiple of 8), background removal and resizing on synthetic candidates,
  pack layout and omissions, contact-sheet composition (also inspected by eye), the MCP protocol
  over real stdio, provider request/response shapes against fake fetch implementations, the
  concurrency cap, retry/deadline/batch-stop behaviour, and sentinel-key redaction on success
  and every failure path. Packs were additionally cross-checked with Pillow (development-time
  only; not a runtime dependency).
- **Verified live (2026-10-03, with the author's own test keys):** for Google (Interactions API on the
  stable `/v1` path, `gemini-3.1-flash-image`) and for OpenRouter (`POST /api/v1/images`, the same model): the key
  check, one draft image (512 px) and one large image (1K), each through the real server over
  stdio, then `pack.mjs build` and `sheet`, including the Windows `.ico` and, at 1K, the macOS
  `.icns`. This is how the JPEG-only answer of Google was found: a request for PNG is refused with
  HTTP 400. The shapes live in one module each (`mcp/lib/provider-*.mjs`). The opt-in live tests
  (`ICON_AI_LIVE_GOOGLE_KEY`/`ICON_AI_LIVE_OPENROUTER_KEY`, see `tests/live/`) repeat all of it with
  your own key and bill your account.
- **Not verified live:** other models than the default, the 2K and 4K sizes (not offered), rate-limit
  and safety-block answers of the real services (checked against fake responses only), and three
  parallel requests under a provider's real quota.
- **Verified on other systems (2026-10-04, 0.1.7, offline suite only, from a `git archive` copy):** the 233
  offline tests also pass on macOS (Apple silicon, Node 26.4) and on Linux (x86_64, Node 22.22), the six-process
  exclusive-create test included. The live
  runs, the Pillow cross-checks of the produced files and the contact-sheet inspection were done on Windows only.
- **Verified live (2026-10-04, 0.1.1 to 0.1.3, Google only):** the pure white / pure black background recipe
  (14 candidates in 10 styles: every background removed), two rounds in one run folder, and the size the model
  actually draws the subject at (about 70 % of the frame, whatever the prompt asks).
- **Verified live (2026-10-04, 0.1.4, Google only, one smoke run through the real server code):** a first round,
  `repeat_styles`, a round with `as-described`, `list_run`, the next steps exactly as the tool returned them, and the
  platform files of the packs. 0.1.5 to 0.1.7 were used by the author in real sessions (several draft rounds and contact
  sheets) but not re-run through the scripted live checks; the background carry-over, the cross-process exclusive
  create, the deadline and the soft-edge rim are covered by offline tests only, and `--variant` has not been run live.
- **Verified by design only:** Node 18 (the CI matrix runs it on all three systems once the repository
  is public) and the live provider paths on macOS and Linux.

## Development

    node --test tests/*.test.mjs

No dependencies, no build step. Tests use synthetic data only. See
[CONTRIBUTING.md](CONTRIBUTING.md); security reports follow [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
