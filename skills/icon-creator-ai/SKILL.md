---
name: icon-creator-ai
description: Generate app-icon candidates with an image model (the user's own Google or OpenRouter key), turn every candidate into a finished cross-platform icon pack, and review all candidates on a contact sheet at 64/32/16 px. Use when the user wants AI-generated icons, several icon variants to choose from, or a high-resolution final of a candidate.
---

# Icon Creator AI

You drive an image model through the bundled MCP server (`icon-creator-ai`), then finish everything
locally with the bundled `pack.mjs`. The whole flow is: one question, one subject sentence, one
`generate_images` call, one build, one contact sheet, your recommendation.

## Hard rules

- **Never ask for or accept an API key in the chat.** Keys live in the plugin configuration only
  (see "No key configured" below). If a user pastes a key anyway, tell them to rotate it and
  configure it through `/plugin` instead.
- **Exactly one question, ever**: how many icons. Skip it when the user already named a number.
  No provider question, no approval question, no resolution question.
- The image model's output is never edited by hand. Background removal, resizing and packing are
  what the scripts do; your judgement belongs in the recommendation, not in pixel edits.
- Nothing is uploaded anywhere. The only network traffic is the prompt text to the provider the
  user configured (Google or OpenRouter, their key), and it is sent by the MCP server, not by you.
- Use `${CLAUDE_PLUGIN_ROOT}` in every script path you write yourself, never a personal one. The `nextSteps` of a tool result
  carry the plugin's own script by absolute path and may be run exactly as given; in round 1 the one thing left for you to
  fill in is `<app-slug>` (step 6).
- **Never touch what already exists.** A later round of candidates (for the same subject) only
  ADDS files: new candidates in the same run folder, new packs, a new sheet file. Never overwrite
  or rebuild an earlier candidate, pack or sheet, and never pass `--force` for such a round.

## Step 1 — the subject (only if the user did not describe the app)

If the request did not say what the app is (for example a bare `/icons`), do NOT ask: a second
question would break the one-question rule. Read what the project says about itself instead (the
README title and first paragraph, the package manifest's `name` and `description`, or the folder
name) and state your assumption in one line, for example: "Assuming the app is: a chess clock for
correspondence chess. Run `/icons <your own sentence>` to change it." Then go on to step 2.

If the project tells you nothing usable (an empty folder, no README, no manifest), stop with one
line and no question: "Tell me what the app is in one sentence, for example
`/icons a chess clock for correspondence chess`." That is a statement of how to call the command;
do not ask the count either, it comes next time.

## Step 2 — check the setup once

Call the MCP tool `check_setup` (no arguments) BEFORE you ask anything, so a user with no key is
told so first instead of answering a question and then being stopped. Look at
`providers.google.configured` and `providers.openrouter.configured`, and `resolved` (which provider
and model will be used).

**No key configured** — stop after explaining, in at most six lines:

> No API key is configured yet. Open `/plugin` → Installed Plugins → Icon Creator AI →
> Configure options and paste a Google AI Studio key (https://aistudio.google.com/apikey) or an
> OpenRouter key (https://openrouter.ai/settings/keys) into the matching field, then save and say
> "go" again. Keys are stored by Claude Code, never typed in the chat. Note: sensitive plugin
> values currently may not survive a Claude Code restart (known issue #62442) — if I later report
> no key again, re-enter it the same way.

Only if the user explicitly doubts their key, call `check_setup` with `verify: true` (one tiny
free request per configured provider).

## Step 3 — the count (only if the user did not name one)

Use the AskUserQuestion tool with exactly one question:

- Question: "How many icon candidates should I generate?" If you assumed the subject in step 1,
  say so in the question text ("Assuming the app is: a chess clock. How many icon candidates
  should I generate?"): this is the user's only chance to correct it before money is spent.
- Options: "4 (recommended)", "1", "8", "16" (four options; the tool adds "Other" itself, do not list it).

If the user already said a number (or "a few"/"some" → 4), continue without asking. If the
AskUserQuestion tool is not available (a headless run), do not stop: use 4 and say so in one line.
The count is 1 to 16; the default is 4. More candidates cost more and take longer (at most 3
requests run at the same time). A later round ("eight more") never asks anything.

## Step 4 — write the subject sentence

You write it from the user's words: **one sentence, concrete nouns, what the app does**. Keep the
user's meaning intact; do not add art direction (styles come from the tool), do not add "icon of"
(the wrapper adds it), no longer than 800 characters. Good: "a chess clock for correspondence
chess with two analog dials". Bad: "a cool modern minimalist flat icon for my app, maybe blue".
If the user pastes a long description, keep the one subject the icon should SHOW (the most visual
thing: an object, a creature, a symbol), drop the feature list, and never carry style adjectives
(modern, clean, minimalist, flat) into the sentence: styles come from the tool.

**The background is not your business, with one exception.** The tool asks the model for a pure
white background (pure black for the neon and sticker styles) and removes it, so every logo comes
out transparent; never write a background colour into the sentence yourself. Only if the user
explicitly asked for a particular background keep their words in the sentence and pass
`background: "as-described"` in step 5. That means a colour ("on a midnight-blue background"), a
gradient, a scene or place ("in a forest"), a tile or card behind the logo, or a plain "dark/light
background". It does not mean "transparent" or "no background" (the default already gives that).
Such a candidate keeps its background all the way through the packs (the build reads that from the
run records). Do not ask the user about backgrounds.

## Step 5 — generate

Pick the output folder: a folder inside the user's project, normally `icon-ai/` under the current
working directory. Pass it as an ABSOLUTE path (the server does not expand `~` and resolves a
relative path from its own working directory). The tool creates the folder and the
`run-<timestamp>` subfolder itself and never overwrites anything.

**One run folder per subject.** If this conversation (or `icon-ai/`) already holds a run for the
same app, do not start a new one: use the follow-ups below. In a new conversation, look inside `icon-ai/` for its
`run-*` folders and call `list_run` on the likely one (the prompt of each round names the subject).

Call `generate_images` with:

- `prompt`: your subject sentence,
- `count`: the chosen number,
- `size`: `"draft"` (512 px, cheap and fast — always draft for a first round),
- `out_dir`: the folder you chose (for a NEW subject; further rounds use `run_dir`, see "Follow-ups"),
- `background`: leave it out, except `"as-described"` when the user named a background (step 4). A later round in the same
  folder keeps the earlier round's choice by itself; pass `"auto"` only to go back to white or black.

Each candidate gets a different art style automatically. If you want particular styles (the user
said "pixel art and neon only"), call `list_styles` first and pass their ids as `styles`.

Read the result: `candidates` (with file names), `failures` (named, with reasons), `usage`
(tokens and, on OpenRouter, cost — report what is there, invent no prices; a `null` field means the provider did not report it, so say "not reported" and never write 0), `notes`, `runDir`, `nextSteps`.
Partial success is normal — report what failed matter-of-factly.

## Step 6 — build the packs and the contact sheet

Run the two commands of `nextSteps` from the result (they carry this plugin's own script by
absolute path, the right `--name` for later rounds and, for a later round, `--only` with the new
numbers). For the first round they are, with the placeholders filled in:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pack.mjs" build --run "<runDir>" --name "<app-slug>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/pack.mjs" sheet --run "<runDir>"
```

`<app-slug>`: letters, digits, `.`, `_`, `-` only (from the app's name, e.g. `chess-clock`);
`--title "Chess Clock"` sets the human title used in the web manifest and the `.desktop` entry.

**Never overwrite.** `build` and `sheet` refuse to touch what exists. For a later round
`build --only <new numbers>` makes just the new packs and `sheet --only <new numbers>` writes the
new candidates to NEW sheet files (`sheet-2.png`, ..., eight per page, numbered after the sheets
that exist); the earlier sheets stay exactly as they were. If the user wants a different look of
the SAME candidates (more or less room, no sharpening), do not use `--force`: add
`--variant <label>` (for example `fill90`) to both commands. That writes `pack-<k>-<label>/` and
`sheet-<label>-<n>.png` beside the old files. Tell the user the new names.

Each candidate is cropped to its subject, which fills 96 % of the square, so the picture stays
readable at 32 and 16 px (the generated image always has a wide empty margin); `--fill <50-100>`
changes that. The crop enlarges the generated pixels (about 1.3x on a draft), which adds no
detail: say so if the user judges sharpness on a draft, and offer a `large` run. The 16 to 48 px
renderings get a light sharpening (`--no-sharpen` turns it off).
`build` writes `pack-<k>/` per candidate: the Windows `.ico`, the macOS `.icns` (on a 512 px draft
without the 1024 px slice, which it names), the Linux hicolor tree, web favicons, the PWA icons
and the master PNG. `web/apple-touch-icon.png` (opaque, with a margin, as iOS needs) and
`web/icon-maskable-512.png` (the picture inside the safe zone, as Android needs) are separate
renderings, not the master smaller: say so if asked why they have margins. `sheet` writes
`sheet-<n>.png`, eight candidates per sheet, each on a checkerboard and on a dark tile, with the
true-size 64, 32 and 16 px renderings under them. Both print a JSON summary;
quote the per-candidate warnings that matter (background not removed — `--tolerance 60` helps
when a flat but noisy colour was kept —, `fades-on-dark` / `fades-on-light`, a tile cropped to its
picture, a large enlargement, opaque corners, tiny master, `nothing-visible` = an empty icon, say so and offer a new round), not every number. A candidate that
appears under `skipped` (a file the provider returned in a format this plugin cannot decode, a
damaged PNG, or a candidate that is a link rather than a regular file) has no pack and no place on
the sheet; name it and say why, the raw file is still in the run folder. Candidate numbers on the
sheet are the `<k>` of `candidate-<k>` and `pack-<k>`, so a skipped number leaves a gap, never a
shift.

## Step 7 — look and recommend

Read each NEW `sheet-<n>.png` image (all of them after a first round, only the new sheet files
after a later one). Judge, in this order:

1. **16 and 32 px legibility** (the small row of each block; the enlarged 16 px tile shows what
   the pixels really are): is the silhouette still readable, or is it a blob? This is the ranking
   criterion.
2. Silhouette clarity at 128 px on the checkerboard (light background) and the dark tile: does it
   survive both? The build's `fades-on-dark` / `fades-on-light` warnings say objectively when an
   outline melts into one of them.
3. Background removal: does the icon keep a rectangle background (a "background-uncertain"
   warning means the model returned a non-flat background)? A candidate whose warnings say
   `background-uncertain` or `opaque-corners` is a filled tile, not a transparent logo: say so
   before you recommend it, and do not make it your top pick unless the user wants a tile.
   `tile-recropped` means the picture was cropped out of a tile and now fills a full square of the
   tile's colour; name that too.

Then tell the user, in this shape:

- your top two or three by candidate **number**, each with one sentence of *why* (tied to what
  you saw at 16/32 px),
- where everything is: the run folder, the `pack-<k>/` folders and the sheet file names,
- the warnings that matter and any failures by style name,
- usage and cost as returned (or "the provider did not report usage"),
- the follow-ups they can ask for: "more like number 3", "eight more", "make number 2 the final in
  higher resolution",
- one line that the candidates sit in the project's `icon-ai/` folder, which is not ignored by git
  unless the project's `.gitignore` says so.

Always end with this honest-limits paragraph (adapt the first clause only if a candidate was
chosen):

> Honest limits: results vary from run to run; generated images carry the provider's invisible
> watermark (SynthID on Google); a logo from an image model may resemble existing marks and may
> not be protected by copyright; the provider's own terms apply to your account and key.

## Follow-ups

Call `list_run` with the run folder first: it returns every round (with its prompt), every
candidate (number, style, background, file), the packs and sheets that exist, the pack name used so
far and the next free numbers. Use it instead of opening `run.json` and the `batch-<n>.json` files
yourself (later rounds live in those). Every follow-up keeps the `background` of the latest round by itself; when the
candidate you build on came from a round with another `background` (`list_run` shows it per candidate), pass that one.

**Same subject means the same run folder.** A rewording or refinement of the same app ("more
menacing", "add a dragon") continues the same folder with the new prompt; only a different app
starts a new run folder with `out_dir`.

- **"More" / "eight more" / "another round"**: call `generate_images` again with the same `prompt`
  (from `list_run`: the prompt of the latest round in `batches`, unless the user reworded it), the requested `count`, and `run_dir` set to the existing
  `runDir` (no `out_dir`). The new candidates are numbered on (5, 6, 7, ...) in the same folder and
  take styles not used there yet. Then run the two commands from `nextSteps` and tell the user which
  numbers are new and which sheet file shows them (the first round's sheet stays exactly as it was).
  Never start a new run folder for the same subject; the user finds the numbering confusing.
- **"More like number N"**: take that candidate's style id from `list_run` (`candidates[].style`),
  then `generate_images` with `styles: ["<that id>"]`, `repeat_styles: true` (every candidate in that
  style instead of other styles), `run_dir` the same run folder, `count` 3–4, still `size: "draft"`.
  Build (`--only`) and sheet again, compare against the earlier numbers ("these are siblings of
  number 3"). If the user names the candidate by anything but its number (a colour, a feature),
  look at the sheet and `list_run` and pick; if you truly cannot tell, say which two you mean.
- **"Make number N the final"** with no mention of resolution: nothing to generate. `pack-N/`
  already holds the finished set; tell the user where it is and that a 1K version (full set with
  every `.icns` slice) is one more request away.
- **"Make the final in higher resolution"**: tell the user plainly that this is a NEW generation in
  the chosen style (numbered on), not number N enlarged, then call `generate_images` with
  the prompt of that candidate's round (`list_run`), `styles: ["<chosen id>"]`, `count` 1, `size: "large"` (1K) and `run_dir` the same run folder.
  Then build it (`--only <its number>`): a 1K master produces the full set including every `.icns`
  slice and `icon-1024.png`. Count 2 only if the user asks for a choice.
- **Different provider/model**: the user sets it in the plugin configuration (`provider`,
  `model`); you never change endpoints yourself.

## When to stop

- No key configured → Step 2 stops you.
- Every candidate failed → report the failure reasons verbatim (they name the HTTP status and
  what the provider said), point at the run folder's records (`list_run`), suggest what matches
  the error (quota, credits, safety refusal, rate limit) and stop. Do not silently retry the whole
  run. A daily-quota or credits error stops the batch at once by design.
- The user asks for something image models must not do here (photos, video, audio, text
  rendering) → say this tool makes square app-icon candidates only.
