# Privacy Policy

This plugin runs on your machine. Only requests to the image provider you configured ever leave
it: one per generated image when you ask for icons (a retry after a transient error, or a second
attempt without the size field, is one more request to the same provider), and, only if you
explicitly ask to check your key, one tiny listing request per configured key that carries no prompt.

- **Network:** the bundled MCP server sends the prompt text (your one-sentence app description,
  wrapped with a fixed recipe and one art-style hint) to the image provider you configured —
  Google (`generativelanguage.googleapis.com`) or OpenRouter (`openrouter.ai`) — together with
  your provider key, over HTTPS. These are the only two hosts, hard-coded; redirects to any
  other host are refused, and there is no endpoint override. The plugin makes no other network
  requests: no telemetry, no analytics, no updates, no downloads. Your provider sees the prompt
  and your key under their own terms and privacy policy.
- **What it reads:** the plugin configuration values Claude Code passes it (your keys, provider,
  model), the run folders it wrote itself, and the candidate images inside them. To add candidates
  to an existing run (`run_dir`) the server reads that folder's `run.json` and its candidate file
  names, and only if `run.json` says this plugin wrote it; `list_run` reads the same files and changes nothing. The pack script reads the run folder
  you name. Nothing else is read — no Claude data, no chat or session
  transcripts, no other files, no ambient environment secrets (keys are read only from the
  plugin's own `ICON_AI_*` variable names, which nothing else sets).
- **Keys:** stored by Claude Code's plugin configuration (the platform credential store for
  sensitive values), passed to the bundled server through its environment mapping, never
  rendered into the chat, never written to `run.json`, any candidate file, the contact sheet or
  a log line — a redaction layer scrubs them from every error and result, and tests prove this
  with sentinel keys on success and failure paths.
- **What it writes:** the output folder you name (`run-<timestamp>/` with candidates and
  `run.json`, then `pack-<k>/` folders and `sheet-<n>.png` inside the run folder). It never
  overwrites an existing file without `--force`, and refuses symbolic links in the output path.
  A run you continue (`run_dir`) only gains files (new candidates, a `batch-<n>.json`, packs and
  sheets); nothing already there is replaced.
- **The image provider:** generated images carry the provider's invisible watermark (SynthID on
  Google). What the provider retains about your request is governed by the provider, not by this
  plugin.
- **Where to report problems:** open an issue at
  https://github.com/ultrathinker/icon-creator-ai/issues.
