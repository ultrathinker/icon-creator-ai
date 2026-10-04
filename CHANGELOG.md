# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.7]

### Changed

- Contact sheet, on user feedback: the enlarged 16 px picture (added in 0.1.4) is gone, and so is every grey ground.
  Under the previews there is one white strip with the 64, 32 and 16 px renderings: under the checkerboard directly on the
  white, under the dark preview each on a dark tile of exactly its own size (the colour of the dark preview).

## [0.1.6]

### Fixed

- The contact sheet showed the small renderings only under the checkerboard: under the dark tile there was just the enlarged
  16 px picture, so the dark side looked broken (a user report). Under each preview there are now the same two rows on
  its own ground: the 64, 32 and 16 px renderings on a light strip under the checkerboard and on a dark strip under the dark
  tile, and below them the 16 px rendering at four times its size on each ground.

## [0.1.5]

A second independent review (two reviewers read the changes of 0.1.4; every finding was checked against the code or
reproduced before it was fixed; the two reports agreed on four).

### Fixed

- Two processes continuing the same run folder at the same moment could still overwrite each other's candidate or
  `batch-<n>.json` (the file was staged and renamed over the target, and a rename replaces): the staged file is now given
  its name through a hard link, which fails when the name is taken, even against another process; only a volume without hard
  links falls back to check-and-rename. Proved with six processes creating one name at the same instant.
- The run deadline aborted the requests in flight, although the pool's own tests said it lets them finish (their fake worker
  ignored the abort signal, the real one passes it to `fetch`): the deadline now only stops what has not started, and the
  test's worker honours the signal like the real one.
- A later round (`more`, `more like N`, the final in high resolution) fell back to `background: auto` and so lost a
  background the user had asked for (`as-described`), with the user's colour and "pure white" in one prompt: a round in an
  existing run folder keeps the last round's choice unless `background` is given, and says so in `notes`.
- `fades-on-dark` / `fades-on-light` were silent for any soft-edged drawing (the rim was the pixels touching full
  transparency, and a ramp of 1.5 px or more has none): the rim is now the solid pixels within about 1.2 % of the side
  from the transparent surround, found for ramps from 0.5 to 5 px.
- A run record with a `null` or a number where an object belongs crashed the reader (`readRunRecords`, so `pack.mjs`
  and `list_run`) with a raw TypeError; such entries are dropped. `pack.mjs build` and `sheet` now also say, on stderr and
  as `recordProblems` in the JSON, when a damaged `batch-<n>.json` was skipped (a skipped round silently turned
  "as-described" into "strip the background").
- "No candidate was generated" named `run.json` for a continued run; it names the `batch-<n>.json` that holds the details.
- Skill: round 1's `nextSteps` carry the placeholder `<app-slug>` and are no longer called runnable "exactly as given"; how
  to find an earlier run of the same app in a new conversation; the prompt to repeat is the latest round's (it was
  `batches[0]`), also for the final in high resolution; the background carry-over rule; `nothing-visible` is named among the
  warnings that matter. `pack.mjs --help` no longer says the `.icns` needs a 1K master and mentions the 16 px zoom tile.

### Tests

- The cross-process creation test, the soft-edge fixtures (hard-edged discs hid the rim defect), a damaged-records run,
  the carry-over of a background (also: from the last round, explicit choice wins, a run that named none is unchanged).
- Tightened where a mutation survived: the maskable safe zone (a 75 % zone passed), the sharpening strength (three times
  the documented 0.5 passed; it is now bounded above and below by the overshoot across a clean edge).
- 232 offline tests.

### Looked at and left as it is

- A candidate with nothing visible still gets a full (empty) pack and the warning `nothing-visible`; the skill now names it.
- The maskable icon of an opaque tile fits its whole content box inside the safe zone, so a round glyph on a tile ends up
  smaller than the zone allows (about 29 % in one probe): the safe side, kept.
- Pack files are written by stage-and-rename and `--force` replaces them on purpose; only candidates and batch records,
  which cost money, are created exclusively.

## [0.1.4]

An independent review (two reviewers read the whole project; every finding was checked against the code).

### Added

- `list_run`: a read-only merged view of a run folder (rounds, candidates, packs, sheets, the pack name, next numbers), so a
  model no longer reads `run.json` and `batch-<n>.json` by hand.
- `generate_images` `repeat_styles`: with `styles`, every candidate in the requested style(s), round-robin ("more like number 3"
  used to give one sibling plus unrelated styles).
- `pack.mjs build` / `sheet` `--variant <label>`: a rebuild with other settings goes into `pack-<k>-<label>/` and
  `sheet-<label>-<n>.png` beside the old files; `--title`; `sheet --only` and `--variant` series numbering.
- `web/icon-maskable-512.png` (opaque, the drawing inside the 80 % safe-zone circle) and an opaque `web/apple-touch-icon.png`
  with a margin; `site.webmanifest` gains `start_url`, `display`, `background_color`, `theme_color`, `short_name`, `purpose`
  and the maskable entry; `head.html` gains `theme-color`.
- The macOS `.icns` of a 512 px master (all slices but 1024 px, which is named in `omitted`); below 256 px still none.
- Warnings `fades-on-dark` and `fades-on-light` (WCAG contrast of the drawing's edge below 2:1); the contact sheet shows the
  16 px rendering again at four times its size.
- A light sharpening (unsharp mask 0.5, colour only, alpha untouched) of the 16..48 px renderings and of the sheet's small
  tiles (`--no-sharpen`), measured by eye on real candidates.

### Fixed

- The MCP server started through a symbolic link or junction (a symlinked config folder, `--plugin-dir` through a link)
  exited silently: the direct-run check compared a link spelling with a real path.
- `background: "as-described"` was ignored by the pack stage (a requested flat colour was stripped as "the background"):
  `build` and `sheet` read the per-candidate background from the run records and keep it.
- The pack name was lost between rounds (round 2 wrote `app.ico` beside `chess-clock.ico`) and the next steps carried a
  relative script path: the name of the existing packs is reused and the path is absolute.
- A build over existing packs now refuses before writing anything and names `--only`, `--variant` and `--force`; the skill no
  longer suggests `--force` for a rebuild.
- Two continuations of one run at the same time lost the second one's billed images (a name taken meanwhile aborted the write):
  numbers are taken at write time and skipped when taken; a failed write is recorded for that candidate, not fatal.
- A network failure showed only "fetch failed": the cause (`ENOTFOUND`, a refused redirect, ...) is kept, and a refused redirect
  is no longer retried as a network error.
- Google 429 answers: the `RetryInfo` delay is honoured, a daily quota stops the batch instead of retrying every candidate.
- A PNG could inflate to far more than its header declares (a decompression bomb): the inflate is capped.
- A 1 px line or antenna was invisible to the crop box (and a lone 1 px line gave "nothing visible"): a pixel counts when a
  neighbour is ink too, so thin lines count and isolated specks still do not.
- Retry waits get jitter so refused slots do not retry in the same instant; `~` paths are refused for `out_dir`/`run_dir`.
- Skill: the key check comes before the question, the question has four options (the tool adds "Other"), a headless run
  falls back to 4, absolute `out_dir`, same subject = same folder, more specific wording about backgrounds, long descriptions,
  warnings before a recommendation, "make N the final" versus "in higher resolution", the final is count 1.

### Tests

- ICO and ICNS bytes are checked against the format specs by an independent reader (a writer and its own parser agreeing
  proved nothing); an anti-aliased fixture guards the edge cleaning; the redaction layers of the tool result and of the files
  are each proved; batch numbering is by the highest number, not by count; the vacuous deadline assertion is real; a server
  started through a link, parallel continuations, a decompression bomb and the retry hints are covered.
- The suite leaves no temporary folders behind (they are created through one helper and removed when the test process ends).

## [0.1.3]

### Changed

- A continued run (`run_dir`) never modifies or replaces an existing file. 0.1.2 rewrote `run.json` and, through
  `pack.mjs sheet --force`, the first round's `sheet-1.png`; now the new round is recorded in `batch-<n>.json`
  (read together with `run.json`; a damaged or foreign batch file refuses the continuation), the new candidates get packs
  through `pack.mjs build --only`, and `pack.mjs sheet --only <numbers>` writes them to NEW sheet files numbered after the
  existing ones (`sheet-2.png`, ...), so the first round's sheet stays as it was. `--only` now works for `sheet` too.

### Fixed

- A subject that touches the image edge or a corner no longer makes a flat background "uncertain" (it was judged by the four
  corners alone, so a head running off one corner kept its white background): the whole border decides, a flat colour
  needs at least 60 % of it with the rest clearly something else, and a flat but noisy colour whose corners differ by more
  than the tolerance now counts as flat. A gradient or a half-and-half border is still not a flat background.

## [0.1.2]

### Added

- `generate_images` takes `run_dir`: the candidates are added to an existing run folder of this plugin instead of a new one,
  numbered on from the highest candidate there (5, 6, 7, ...), with art styles the earlier batches did not use (an explicitly
  requested style is honoured). `run.json` now has one entry per batch (`batches`) and every candidate names its batch; a
  flat `run.json` from 0.1.0/0.1.1 is converted on the first continuation. The folder must be a real directory whose `run.json`
  this plugin wrote (no link anywhere in the path, no link as `run.json`); `out_dir` and `run_dir` together are refused.
- `generate_images` takes `background`: `auto` (default), `white`, `black` or `as-described`. The model is asked for one pure flat
  white background (pure black for the neon and sticker styles), edge to edge, so removing it leaves a transparent logo, instead
  of "one solid colour", which produced saturated backgrounds (magenta, green) that removal handled badly. `as-described` asks for
  no background, for a user sentence that names the one they want. Each candidate records the background it was asked for.
- `pack.mjs build --only <numbers>` (such as `5-12` or `1,3,5-8`) builds just those packs.

### Changed

- The contact sheet shows the icon edge to edge: the 144 px previews fill their tile and the 64/32/16 px renderings sit on tiles of
  their own size, instead of a margin of the sheet's own around every icon (which made a 16 px icon look padded).

## [0.1.1]

### Changed

- The master is now cropped to the subject and refitted so that the subject fills 96 % of the square's longer side
  (`pack.mjs build` and `sheet` take `--fill <50-100>`), instead of keeping the empty margin of the generated image, which
  left the picture a few pixels wide at 16 px. A subject on a transparent background is cropped to its visible
  pixels; an opaque tile with a picture inside is cropped to the picture and stays one opaque colour (`--keep-tile`
  keeps it as drawn, with a `tile-recropped` warning otherwise); a picture that already fills the frame with a varying
  background is left alone. `--no-crop` restores the previous centred, uncropped fit.
- The crop resamples the generated pixels (bicubic, in premultiplied alpha, typically 1.3x for a 512-px draft): the
  facts record `fit.crop` (mode, source box, window, enlargement), and an enlargement above 1.6x raises an `enlarged`
  warning that the largest sizes will look soft. Sizes above the master are still omitted and listed, never made.
- The `background-uncertain` warning now mentions `--tolerance` for noisy saturated backgrounds.

## [0.1.0]

### Added

- First version: 1–16 AI icon candidates per run through the user's own Google (Gemini Interactions
  API) or OpenRouter key — at most 3 requests in flight, staggered, each candidate with a different
  curated art style, drafts at the model's smallest size; retries on network errors, 429 and 5xx
  with `Retry-After` honoured; a rejected key or exhausted credits stops the run at once.
- A pack names every size it could not make (Windows `.ico` entries, Linux hicolor sizes, favicon entries, web icons),
  and writes `site.webmanifest`, `head.html` and the `.desktop` entry only with what exists: they reference only icon files
  the pack really contains, and are left out (and listed) when there is nothing for them to point at, e.g. for a 128 px master.
- Requesting the same art style twice no longer gives two candidates the same style.
- Run usage is aggregated field by field: a token count or cost a provider did not report is `null` (unknown), never 0
  and never a partial sum presented as a total.
- `pack.mjs build` and `sheet` refuse a candidate that is a symbolic link, a junction or not a regular file (reported
  under `skipped`, never opened), so pack input stays inside the run folder.
- Token usage is reported for OpenRouter too (`prompt_tokens` and `completion_tokens` are mapped to input and output
  tokens, alongside the cost the provider returns); a field a provider does not send stays null instead of zero.
- The key redactor also hides the first five characters of a key and any eight-character run taken from inside it, so a
  provider that echoes only part of a key in an error cannot get it into the chat, a file or the log.
- An unknown tool name is answered with a JSON-RPC invalid-params error (`-32602`); only a tool that ran and failed
  returns `isError`.
- `pack.mjs build` and `sheet` skip a candidate they cannot decode (a damaged PNG kept raw, a format that is not
  handled) with the reason and carry on with the usable ones; the sheet labels each candidate with its own
  `candidate-<k>` number, so it always agrees with `pack-<k>` even when a file in between was skipped.
- Raw provider bytes that are kept unchanged (a WebP, a JPEG or PNG the decoder cannot handle) are checked for
  the configured key first; a payload that carries it is discarded and reported instead of written.
- Google runs on the stable `/v1` Interactions endpoint (not `v1beta`), checked live.
- `check_setup` with `verify: true` reports only booleans: nothing a provider answers is copied into the result,
  and every tool result passes the value-based redactor before it leaves the server.
- A bare `/icons` no longer asks a second question: the app is inferred from the project (and the
  assumption is stated), or the user is told how to call the command.
- A built-in baseline JPEG decoder (no packages, compared pixel by pixel with libjpeg): Google's image
  models answer JPEG only, so every candidate is decoded and saved as PNG. Progressive JPEG, WebP and
  CMYK are refused and kept raw with a warning instead of guessed at.
- Live tests (opt-in, your own key) that run the whole path — real server over stdio, `generate_images`,
  `pack.mjs build` and `sheet` — at the draft and the large size for both providers.
- A finished icon pack from every candidate (Windows `.ico`, macOS `.icns` on 1K masters, the Linux
  hicolor tree, web favicons, master PNG) with flat-background removal, transparent-square fitting and
  no silent upscaling — sizes above the master are omitted and listed.
- A numbered contact sheet per eight candidates: each on a checkerboard and a dark tile, plus its
  64/32/16 px renderings.
- A dependency-free MCP server (stdio JSON-RPC) holding the key: `check_setup`, `list_styles`,
  `generate_images`, with sentinel-key redaction on every output path.
- The `icon-creator-ai` skill and the `/icons` command driving the whole flow with exactly one
  question (the count).
