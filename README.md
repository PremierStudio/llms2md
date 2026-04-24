# llms2md

Turn any `llms.txt` into a clean local Markdown docs tree.

[![CI](https://img.shields.io/github/actions/workflow/status/PremierStudio/llms2md/ci.yml?branch=main&label=ci)](https://github.com/PremierStudio/llms2md/actions/workflows/ci.yml)
[![Registry Review](https://img.shields.io/github/actions/workflow/status/PremierStudio/llms2md/registry-pr-review.yml?branch=main&label=registry%20review)](https://github.com/PremierStudio/llms2md/actions/workflows/registry-pr-review.yml)
[![Node >=20.12](https://img.shields.io/badge/node-%3E%3D20.12-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Coverage 100%](https://img.shields.io/badge/coverage-100%25-00C853)](./coverage/)
[![License MIT](https://img.shields.io/github/license/PremierStudio/llms2md)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/PremierStudio/llms2md?style=social)](https://github.com/PremierStudio/llms2md)

`llms2md` is a fast, minimal CLI for pulling down an `llms.txt`, resolving every linked doc, and writing the result out as a usable Markdown repository on disk.

It is built for two kinds of use:

- direct CLI execution when you already know the source you want
- an interactive TUI when you want to browse curated sources or paste a custom URL

## Why It Exists

`llms.txt` files are becoming the easiest way for docs sites to expose an LLM-friendly entrypoint, but they are still awkward to consume locally.

`llms2md` fixes that.

- Give it a public `llms.txt` URL, a local file, or a curated registry slug.
- It fetches the linked docs with sensible fallback rules.
- It converts HTML to Markdown when needed.
- It writes everything into a clean local docs tree you can grep, index, commit, or feed to another tool.

## Highlights

- zero-arg interactive TUI
- direct CLI mode for scripting
- remote URLs and local files
- curated built-in source registry
- relative URL resolution
- `.md`, `/index.md`, and `.html.md` fallback fetching
- HTML to Markdown conversion with Turndown
- nested or flat output modes
- URL deduplication
- partial-failure tolerant downloads
- automated registry safety review for contributed sources
- fully tested with 100% statement, line, function, and branch coverage in the included coverage config

## Install

Global install:

```bash
npm install -g llms2md
```

Run with `npx`:

```bash
npx llms2md
```

Run from source before publish:

```bash
git clone https://github.com/PremierStudio/llms2md.git
cd llms2md
npm install
npm link
llms2md
```

## Quick Start

Launch the interactive picker:

```bash
npx llms2md
```

Pull a built-in curated source into the current directory:

```bash
npx llms2md stripe
```

Pull a built-in curated source into a specific directory:

```bash
npx llms2md github ./docs
```

Pull any external `llms.txt` URL:

```bash
npx llms2md https://docs.usebruno.com/llms.txt ./docs
```

Flatten all output files into one directory:

```bash
npx llms2md https://docs.usebruno.com/llms.txt ./docs-flat --flat
```

Use a local file:

```bash
npx llms2md ./llms.txt ./docs
```

List built-in curated sources:

```bash
npx llms2md --list-sources
```

## CLI Modes

### Interactive TUI

Run `llms2md` with no arguments to open an arrow-key flow that lets you:

- choose a curated source
- paste any public `llms.txt` URL
- point at a local file
- choose current directory or a custom output directory
- choose flat or nested output

### Direct CLI

Use direct mode when you already know what you want:

```bash
llms2md <llms.txt url|file|registry slug> [output directory] [--flat]
```

Examples:

```bash
llms2md stripe
llms2md nextjs ./docs
llms2md https://supabase.com/llms.txt ./vendor/supabase-docs
llms2md ./llms.txt ./docs --flat
```

## How It Works

1. Loads a remote or local `llms.txt`
2. Extracts Markdown links in the form `[title](url)`
3. Resolves relative links against the `llms.txt` base URL
4. Deduplicates absolute URLs before fetching
5. Tries each target in this order:

```text
original URL
${url}.md
${url}/index.md
${url}.html.md
```

6. Saves Markdown directly when Markdown is returned
7. Converts HTML to Markdown when HTML is returned
8. Writes everything as `.md` files into either:

- a nested path-preserving structure
- a flat output directory when `--flat` is used

## Output Behavior

Default mode preserves URL structure:

```text
/guide/auth -> ./docs/guide/auth.md
```

Flat mode writes everything at the root:

```text
./docs-flat/auth-guide.md
./docs-flat/reference.md
./docs-flat/api-auth.md
```

## Built-In Curated Sources

The built-in source list lives in `sources.txt` and currently includes:

| Slug | Source | URL |
| --- | --- | --- |
| `bruno` | Bruno Docs | `https://docs.usebruno.com/llms.txt` |
| `claude` | Claude Docs | `https://platform.claude.com/llms.txt` |
| `cloudflare` | Cloudflare Docs | `https://developers.cloudflare.com/llms.txt` |
| `github` | GitHub Docs | `https://docs.github.com/llms.txt` |
| `nextjs` | Next.js Docs | `https://nextjs.org/llms.txt` |
| `stripe` | Stripe Docs | `https://docs.stripe.com/llms.txt` |
| `supabase` | Supabase Docs | `https://supabase.com/llms.txt` |
| `vite` | Vite Docs | `https://vite.dev/llms.txt` |

## Contributing New Sources

New public `llms.txt` URLs are welcome.

Registry entries use this format:

```text
slug|Label|https://example.com/llms.txt
```

If you want to add one:

1. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md)
2. Add or update a line in `sources.txt`
3. Open a pull request

If you do not want to open a PR, use the included GitHub issue template and submit:

- the docs or product name
- the direct public `llms.txt` URL
- why it belongs in the curated list

## Automated Registry Review

This repo includes a registry safety workflow for open-source contributions.

When a pull request changes `sources.txt`, the `Codex Registry Review` workflow:

- fetches every submitted URL
- verifies it is public and HTTPS
- rejects obviously unsafe targets such as local/private network addresses
- checks that the response is text-like
- flags suspicious redirects or HTML responses
- posts a review update directly on the PR

This keeps the registry useful without blindly accepting URLs.

## Local Development

Install dependencies:

```bash
npm install
```

Basic syntax check:

```bash
npm run check
```

Run the registry reviewer locally:

```bash
npm run check:registry
```

Run tests:

```bash
npm test
```

Run tests with coverage:

```bash
npm run test:coverage
```

Open the HTML coverage report:

```bash
open coverage/index.html
```

## Testing Status

The package includes:

- CLI/core tests
- registry reviewer tests
- executable entrypoint tests

Current suite status:

- 60 passing tests
- 100% statements
- 100% branches
- 100% functions
- 100% lines

## Repository Layout

```text
.
├── index.js
├── lib/
│   ├── cli.js
│   └── registry-review.js
├── scripts/
│   └── check-registry-safety.mjs
├── sources.txt
├── test/
├── .github/
└── README.md
```

## License

MIT
