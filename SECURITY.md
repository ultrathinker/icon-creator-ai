# Security Policy

## Reporting a vulnerability

Please report security issues through GitHub Private Vulnerability Reporting: open the
**Security** tab of this repository and choose **Report a vulnerability**. Do not open a
public issue for a suspected vulnerability.

## Supported versions

Only the latest release is supported.

## Scope

This plugin holds a provider key and talks to exactly two hosts. Its security boundaries:

- **Key handling.** Keys arrive only through Claude Code's plugin configuration into the
  bundled server's environment (`ICON_AI_*` names only — ambient variables such as
  `GEMINI_API_KEY` are deliberately ignored). Keys are redacted from every error message, log
  line, tool result and written file, and not only the whole value: the first five characters
  of a key and any run of eight characters from inside it are hidden too, because a provider may
  echo just a part of what it was sent. Tests prove this on success and every failure path
  (provider error bodies, exceptions, redirect errors and the key check, for keys of several shapes). Keys are never placed in process
  arguments and never accepted in chat.
- **Egress.** Only `https://generativelanguage.googleapis.com` and `https://openrouter.ai`,
  hard-coded; redirects are refused, there is no base-URL override, response bodies are capped
  at 25 MB, each request times out (~90 s) and the whole run (~10 min). At most 3 requests are
  in flight; a rejected key (401/403, or Google's 400 "API key not valid") stops the run at once.
- **Model names** are strictly validated (letters, digits, `.`, `_`, `-`, `/`, ≤ 80 characters)
  before use.
- **Output paths.** Everything is written inside the folder you named: symbolic links and
  junctions in the chain below it are refused, files are created exclusively (never through a
  planted alias), and nothing is overwritten without `--force`. The pack script reads only regular
  `candidate-<k>` files: one that is a symbolic link, a junction or anything else is refused and
  never opened.
- **Image input.** Candidates are validated from content (magic bytes), dimensions checked from
  the header before decode, formats limited to PNG/JPEG/WebP. PNG (bundled codec, verifies CRCs,
  refuses truncated files) and baseline JPEG (bundled decoder; progressive, CMYK, multi-scan and
  oversized files are refused) are decoded and saved as PNG; a WebP, or a JPEG the decoder refuses,
  is only validated and kept raw with a warning, never decoded. Raw bytes are written unchanged,
  so before writing them the server checks them for the configured key (the whole value, its first five
  characters, any eight-character run); a payload that carries it is discarded and reported, never written.

Relevant reports are about key leakage in any output, writing outside the named folder,
unexpected hosts or requests, or bugs in the bundled PNG or JPEG readers.
