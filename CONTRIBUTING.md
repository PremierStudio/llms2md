# Contributing

Thanks for helping grow the `llms2md` source registry.

## Adding a New Curated Source

Curated sources live in `sources.txt`.

Each non-comment line must use this format:

```text
slug|Label|https://example.com/llms.txt
```

## Submission Rules

- Use a short, stable slug.
- Use a human-readable label.
- Use the direct public `llms.txt` URL.
- Use `https://` only.
- Do not submit URLs that require auth, cookies, VPN access, or local network access.
- Prefer official docs or product domains.

## Pull Request Process

1. Add or update a line in `sources.txt`.
2. Open a pull request.
3. The automated registry review workflow will fetch the URL and leave a PR update.
4. If the review flags the URL as unsafe or suspicious, fix the URL or explain why it is still valid.

## Local Checks

Install dependencies and run the basic checks:

```bash
npm install
npm run check
npm run check:registry
```

## Submitting Without a PR

If you just want to suggest a source, open the `Add llms.txt source` GitHub issue template and include:

- the docs or product name,
- the direct `llms.txt` URL,
- why it should be included.
