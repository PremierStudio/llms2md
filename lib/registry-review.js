import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_REGISTRY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../sources.txt",
);
const REPORT_MARKER = "<!-- llms2md-registry-review -->";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registryPath = path.resolve(args.registry || DEFAULT_REGISTRY_PATH);
  const entries = await loadRegistry(registryPath);
  const duplicates = findDuplicates(entries);
  const results = await Promise.all(entries.map((entry) => inspectEntry(entry, duplicates)));
  const counts = countVerdicts(results);
  const report = {
    checkedAt: new Date().toISOString(),
    counts,
    registryPath,
    results,
  };
  const markdown = renderMarkdownReport(report);

  if (args.jsonOut) {
    await fs.writeFile(path.resolve(args.jsonOut), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (args.markdownOut) {
    await fs.writeFile(path.resolve(args.markdownOut), markdown, "utf8");
  }

  console.log(markdown);

  if (counts.unsafe > 0) {
    process.exitCode = 1;
  }
}

function handleMainError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {
    jsonOut: "",
    markdownOut: "",
    registry: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if ((arg === "--registry" || arg === "--json-out" || arg === "--markdown-out") && next) {
      if (arg === "--registry") {
        args.registry = next;
      }

      if (arg === "--json-out") {
        args.jsonOut = next;
      }

      if (arg === "--markdown-out") {
        args.markdownOut = next;
      }

      index += 1;
    }
  }

  return args;
}

async function loadRegistry(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  const entries = [];

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const [slug, label, url] = line.split("|").map((part) => part.trim());

    entries.push({
      label: label || "",
      slug: slug || "",
      url: url || "",
    });
  }

  return entries;
}

function findDuplicates(entries) {
  const duplicateSlugs = new Set();
  const duplicateUrls = new Set();
  const seenSlugs = new Set();
  const seenUrls = new Set();

  for (const entry of entries) {
    const slugKey = entry.slug.toLowerCase();
    const urlKey = entry.url.toLowerCase();

    if (seenSlugs.has(slugKey)) {
      duplicateSlugs.add(slugKey);
    }

    if (seenUrls.has(urlKey)) {
      duplicateUrls.add(urlKey);
    }

    seenSlugs.add(slugKey);
    seenUrls.add(urlKey);
  }

  return { duplicateSlugs, duplicateUrls };
}

async function inspectEntry(entry, duplicates) {
  const issues = [];
  const warnings = [];
  const notes = [];
  let finalUrl = entry.url;
  let statusCode = 0;
  let contentType = "";
  let contentLength = 0;

  if (!entry.slug || !entry.label || !entry.url) {
    issues.push("Registry line must contain slug, label, and URL.");
  }

  if (duplicates.duplicateSlugs.has(entry.slug.toLowerCase())) {
    issues.push("Duplicate slug.");
  }

  if (duplicates.duplicateUrls.has(entry.url.toLowerCase())) {
    warnings.push("Duplicate URL already exists in the registry.");
  }

  let parsedUrl = null;

  try {
    parsedUrl = new URL(entry.url);
  } catch {
    issues.push("URL is not valid.");
  }

  if (parsedUrl) {
    if (parsedUrl.protocol !== "https:") {
      issues.push("Registry URLs must use HTTPS.");
    }

    if (parsedUrl.username || parsedUrl.password) {
      issues.push("Registry URLs must not include credentials.");
    }

    if (isPrivateHostname(parsedUrl.hostname)) {
      issues.push("Registry URLs must point to a public hostname.");
    }

    if (!parsedUrl.pathname.toLowerCase().endsWith("llms.txt")) {
      warnings.push("URL does not end with llms.txt.");
    }
  }

  if (issues.length === 0 && parsedUrl) {
    try {
      const response = await fetch(parsedUrl, {
        headers: {
          "user-agent": "llms2md-registry-review/1.0.0",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });

      finalUrl = response.url;
      statusCode = response.status;
      contentType = response.headers.get("content-type") || "";
      contentLength = Number(response.headers.get("content-length") || "0");

      if (!response.ok) {
        issues.push(`Fetch failed with HTTP ${response.status}.`);
      } else {
        const body = await response.text();
        const effectiveLength = contentLength || body.length;
        const looksHtml = /^(<!doctype html|<html[\s>])/iu.test(body.trimStart());
        const hasLinks = /\[[^\]]+\]\([^\)]+\)/u.test(body);

        notes.push(`Fetched ${effectiveLength.toLocaleString()} bytes.`);

        if (new URL(response.url).hostname !== parsedUrl.hostname) {
          warnings.push("Request redirected to a different hostname.");
        }

        if (!isTextLike(contentType)) {
          issues.push(`Unexpected content type: ${contentType || "unknown"}.`);
        }

        if (effectiveLength > 1024 * 1024) {
          warnings.push("Response is larger than 1 MB.");
        }

        if (looksHtml) {
          warnings.push("Endpoint returned HTML instead of plain text/markdown.");
        }

        if (!hasLinks) {
          warnings.push("Response did not contain any markdown links.");
        }
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  const verdict = issues.length > 0 ? "unsafe" : warnings.length > 0 ? "needs-review" : "safe";

  return {
    contentLength,
    contentType,
    finalUrl,
    issues,
    label: entry.label,
    notes,
    slug: entry.slug,
    statusCode,
    url: entry.url,
    verdict,
    warnings,
  };
}

function isPrivateHostname(hostname) {
  const lower = hostname.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".local") || lower.endsWith(".internal")) {
    return true;
  }

  if (!net.isIP(lower)) {
    return false;
  }

  if (net.isIPv4(lower)) {
    const [a, b] = lower.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

function isTextLike(contentType) {
  const lower = contentType.toLowerCase();
  return (
    lower.startsWith("text/") ||
    lower.includes("markdown") ||
    lower.includes("json") ||
    lower.includes("xml")
  );
}

function countVerdicts(results) {
  return results.reduce(
    (counts, result) => {
      counts[result.verdict] += 1;
      return counts;
    },
    { "needs-review": 0, safe: 0, unsafe: 0 },
  );
}

function renderMarkdownReport(report) {
  const lines = [
    REPORT_MARKER,
    "## llms2md Registry Review",
    "",
    `- Safe: ${report.counts.safe}`,
    `- Needs review: ${report.counts["needs-review"]}`,
    `- Unsafe: ${report.counts.unsafe}`,
    "",
    "| Slug | Verdict | Status | Notes |",
    "| --- | --- | --- | --- |",
  ];

  for (const result of report.results) {
    const status = result.statusCode ? `${result.statusCode}` : "n/a";
    const detail = [...result.issues, ...result.warnings, ...result.notes].join(" ") || "Looks good.";
    lines.push(`| ${result.slug} | ${result.verdict} | ${status} | ${escapeTable(detail)} |`);
  }

  lines.push("");
  lines.push("### Checked URLs");
  lines.push("");

  for (const result of report.results) {
    lines.push(`- ${result.slug}: ${result.url}`);
    if (result.finalUrl && result.finalUrl !== result.url) {
      lines.push(`- Final URL for ${result.slug}: ${result.finalUrl}`);
    }
  }

  lines.push("");
  lines.push("This review is automated and should be treated as a safety pre-check, not a trust guarantee.");

  return `${lines.join("\n")}\n`;
}

function escapeTable(value) {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

export {
  DEFAULT_REGISTRY_PATH,
  REPORT_MARKER,
  countVerdicts,
  escapeTable,
  findDuplicates,
  handleMainError,
  inspectEntry,
  isPrivateHostname,
  isTextLike,
  loadRegistry,
  main,
  parseArgs,
  renderMarkdownReport,
};
