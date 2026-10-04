# Contributing

Thanks for looking. This plugin is small on purpose: a skill, a command, one dependency-free Node
MCP server and one dependency-free Node script. Please keep it that way: no runtime packages, no
new hosts, nothing that writes outside the folder the user names.

## Development setup

Node 18 or newer. There is nothing to install.

    node --test tests/*.test.mjs

Tests use synthetic data only and never touch the network (providers are fakes with an injected
`fetch`). The opt-in live test in `tests/live/` is skipped unless you export
`ICON_AI_LIVE_GOOGLE_KEY` or `ICON_AI_LIVE_OPENROUTER_KEY` — run it only with your own key and
expect it to bill your account for a few draft images.

## Pull requests

- One logical change per pull request, with a test that fails without it.
- Keep `README.md`, `PRIVACY.md`, `SECURITY.md` and the skill text true: if behaviour changes,
  the words change in the same pull request.
- Do not add binary files other than small PNG fixtures; keep every file under 256 KiB.
- Run `claude plugin validate .` if you have Claude Code installed.

## Reporting problems

Bugs and ideas: open an issue. Security problems: see `SECURITY.md` and do not open a public issue.
