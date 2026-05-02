import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkbox, confirm, input as promptInput, select } from "@inquirer/prompts";
import fetch from "node-fetch";
import pLimit from "p-limit";
import TurndownService from "turndown";

const MAX_CONCURRENCY = 6;
const DEFAULT_OUTPUT_DIR = "./docs";
const MANIFEST_FILENAME = ".llms2md.json";
const CUSTOM_SOURCE = "__custom_source__";
const CURRENT_DIRECTORY = "__current_directory__";
const CUSTOM_DIRECTORY = "__custom_directory__";
const EXTERNAL_HOSTS_ALLOW = "__external_hosts_allow__";
const EXTERNAL_HOSTS_SKIP = "__external_hosts_skip__";
const MANUAL_SELECTION_BACK = "__manual_selection_back__";
const MANUAL_SELECTION_BACK_BOTTOM = "__manual_selection_back_bottom__";
const SELECTION_ALL = "__selection_all__";
const SELECTION_CANCEL = "__selection_cancel__";
const SELECTION_MANUAL = "__selection_manual__";
const SELECTION_PREVIOUS = "__selection_previous__";
const UPDATE_ACTION_APPLY = "__update_apply__";
const UPDATE_ACTION_CANCEL = "__update_cancel__";
const UPDATE_ACTION_ADDED = "__update_added__";
const UPDATE_ACTION_CHANGED = "__update_changed__";
const UPDATE_ACTION_REMOVED = "__update_removed__";
const SUPPORTED_PROTOCOLS = new Set(["file:", "http:", "https:"]);
const REGISTRY_FILE = new URL("../sources.txt", import.meta.url);
const turndown = new TurndownService({
  codeBlockStyle: "fenced",
  headingStyle: "atx",
});

turndown.remove(["script", "style", "noscript"]);

const color = {
  bold(value) {
    return paint(1, value);
  },
  cyan(value) {
    return paint(36, value);
  },
  dim(value) {
    return paint(2, value);
  },
  green(value) {
    return paint(32, value);
  },
  red(value) {
    return paint(31, value);
  },
  yellow(value) {
    return paint(33, value);
  },
};

async function main() {
  const registry = await loadRegistry();
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printBanner();
    console.log(getUsage());
    return;
  }

  if (options.listSources) {
    printBanner();
    printRegistry(registry);
    return;
  }

  const runOptions = options.input
    ? resolveCliRunOptions(options)
    : await resolveInteractiveRunOptions(registry);

  if (!runOptions) {
    return;
  }

  const result = await runImport(runOptions, registry);

  if (!result.cancelled && result.successCount === 0) {
    process.exitCode = 1;
  }
}

function handleMainError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(argv) {
  let allowExternalHosts = false;
  const positional = [];
  let dryRun = false;
  let flat = false;
  let help = false;
  let listSources = false;

  for (const arg of argv) {
    if (arg === "--allow-external-hosts") {
      allowExternalHosts = true;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--flat") {
      flat = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--list-sources") {
      listSources = true;
      continue;
    }

    positional.push(arg);
  }

  return {
    allowExternalHosts,
    dryRun,
    flat,
    help,
    input: positional[0],
    listSources,
    outputDir: positional[1] ? path.resolve(positional[1]) : undefined,
  };
}

function resolveCliRunOptions(options) {
  return {
    allowExternalHosts: options.allowExternalHosts,
    dryRun: options.dryRun,
    flat: options.flat,
    input: options.input,
    mode: "cli",
    outputDir: options.outputDir || process.cwd(),
  };
}

async function resolveInteractiveRunOptions(registry) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "Interactive mode requires a TTY. Use `llms2md <url|file|slug> <output directory>` or `llms2md --list-sources` instead.",
    );
    process.exitCode = 1;
    return null;
  }

  printBanner();
  console.log(color.dim(`Interactive mode with ${registry.length} curated sources built in.`));
  console.log(color.dim("Use arrow keys to pick a source, or paste any public llms.txt URL/local file."));
  console.log();

  const sourceChoice = await select({
    message: "Which llms.txt source do you want to install?",
    choices: [
      ...registry.map((entry) => ({
        description: entry.url,
        name: `${entry.label} (${entry.slug})`,
        value: entry.slug,
      })),
      {
        description: "Use any public llms.txt URL or a local file path.",
        name: "Custom URL or local file",
        value: CUSTOM_SOURCE,
      },
    ],
    pageSize: Math.min(12, registry.length + 2),
  });

  const registryEntry = registry.find((entry) => entry.slug === sourceChoice) || null;

  const input = sourceChoice === CUSTOM_SOURCE
    ? await promptInput({
      default: "https://example.com/llms.txt",
      message: "Enter an llms.txt URL or local file path",
      validate(value) {
        return value.trim() ? true : "Enter a URL, slug, or local path.";
      },
    })
    : sourceChoice;

  const directoryChoice = await select({
    message: "Where should the Markdown files be written?",
    choices: [
      {
        description: process.cwd(),
        name: "Current directory",
        value: CURRENT_DIRECTORY,
      },
      {
        description: DEFAULT_OUTPUT_DIR,
        name: "Specific directory",
        value: CUSTOM_DIRECTORY,
      },
    ],
  });

  const outputDir = directoryChoice === CURRENT_DIRECTORY
    ? process.cwd()
    : path.resolve(
      await promptInput({
        default: DEFAULT_OUTPUT_DIR,
        message: "Output directory",
        validate(value) {
          return value.trim() ? true : "Enter a directory path.";
        },
      }),
    );

  const flat = await confirm({
    default: false,
    message: "Flatten all output files into a single directory?",
  });

  const options = {
    allowExternalHosts: false,
    dryRun: false,
    flat,
    input,
    mode: "tui",
    outputDir,
  };

  const preparedState = await prepareImportState(options, registry);

  if (preparedState.cancelled) {
    console.log(color.dim("Cancelled."));
    return null;
  }

  const preview = {
    flat,
    input,
    outputDir,
    selectionLabel: preparedState.selectionState.label,
    sourceLabel: preparedState.source.label,
  };

  console.log();
  printRunSummary(preview);
  printPreparedStateNotes(preparedState);

  const shouldContinue = await confirm({
    default: true,
    message: "Start import?",
  });

  if (!shouldContinue) {
    console.log(color.dim("Cancelled."));
    return null;
  }

  return { ...options, preparedState };
}

async function runImport(options, registry) {
  const preparedState = options.preparedState ?? await prepareImportState(options, registry);

  if (preparedState.cancelled) {
    return { cancelled: true, failureCount: 0, successCount: 0 };
  }

  const { blockedEntries, installState, links, selectionState, source, uniqueLinks } = preparedState;
  const selectedEntries = selectionState.entries;

  if (options.mode === "cli") {
    printBanner();
    printRunSummary({
      flat: options.flat,
      input: options.input,
      outputDir: options.outputDir,
      selectionLabel: selectionState.label,
      sourceLabel: source.label,
    });
    printPreparedStateNotes(preparedState);
  }

  if (selectedEntries.length === 0) {
    console.error(`${tag("fail")} No markdown links were found in the provided llms.txt source.`);
    return { failureCount: 0, successCount: 0 };
  }

  const results = await fetchSelectedEntries(selectedEntries, options, source);
  const successfulDocs = results.filter((result) => result.ok);
  const failureCount = results.length - successfulDocs.length;
  const failed = results.filter((result) => !result.ok);
  const plan = await buildInstallPlan(
    options.outputDir,
    successfulDocs,
    installState.manifest,
    source,
    failureCount > 0,
  );

  if (plan.sameSource || options.dryRun) {
    console.log();
    printChangeSummary(plan, failureCount > 0);
  }

  if (options.mode === "tui" && plan.sameSource && plan.totalChanges > 0) {
    const shouldApply = await reviewInstallPlan(plan);
    if (!shouldApply) {
      console.log(color.dim("Cancelled."));
      return { cancelled: true, failureCount, successCount: successfulDocs.length };
    }
  }

  if (options.dryRun) {
    console.log();
    console.log(`${tag("info")} Dry run complete. No files were written.`);
    return { failureCount, successCount: successfulDocs.length };
  }

  if (plan.sameSource && plan.totalChanges === 0 && failureCount === 0) {
    console.log();
    console.log(`${tag("ok")} Already up to date.`);
    return { failureCount: 0, successCount: successfulDocs.length };
  }

  await applyInstallPlan(options.outputDir, successfulDocs, plan);
  await writeInstallManifest(
    options.outputDir,
    createInstallManifest({
      docs: successfulDocs,
      manifest: installState.manifest,
      options,
      plan,
      selectedEntries,
      source,
    }),
  );

  const successCount = successfulDocs.length;

  console.log();
  console.log(
    `${tag(failureCount > 0 ? "warn" : "ok")} Finished with ${successCount} successes and ${failureCount} failures.`,
  );

  if (successCount > 0) {
    console.log(`${tag("ok")} Output directory: ${options.outputDir}`);
  }

  if (failed.length > 0) {
    console.log();
    console.log(color.bold("Failures"));
    for (const result of failed.slice(0, 5)) {
      console.log(`  ${tag("warn")} ${truncateMiddle(result.url, 96)}`);
      console.log(`    ${color.dim(result.reason)}`);
    }
    if (failed.length > 5) {
      console.log(`  ${color.dim(`...and ${failed.length - 5} more`)}`);
    }
  }

  return { failureCount, successCount };
}

async function prepareImportState(options, registry) {
  const resolvedSource = await resolveSource(options.input, registry);
  const llms = await readTextResource(resolvedSource.url);

  if (!llms.ok) {
    throw new Error(`Failed to load llms.txt: ${llms.reason}`);
  }

  const links = extractLinks(llms.body, resolvedSource.url);
  const uniqueLinks = dedupeLinks(links);
  const hostPolicy = await resolveHostPolicy(options, resolvedSource, uniqueLinks);
  const installState = await inspectInstallState(options.outputDir, resolvedSource, options.mode);

  if (installState.cancelled) {
    return { cancelled: true };
  }

  const source = { ...resolvedSource, pathPrefix: installState.pathPrefix };
  const selectionState = await resolveSelectionState(options, source, hostPolicy.allowedEntries, installState.manifest);

  return {
    blockedEntries: hostPolicy.blockedEntries,
    blockedHosts: hostPolicy.blockedHosts,
    cancelled: false,
    installState,
    links,
    selectionState,
    source,
    uniqueLinks,
  };
}

async function resolveHostPolicy(options, source, entries) {
  if (!isRemoteHttpSource(source)) {
    return { allowedEntries: entries, blockedEntries: [], blockedHosts: [] };
  }

  if (options.allowExternalHosts) {
    return { allowedEntries: entries, blockedEntries: [], blockedHosts: [] };
  }

  const sourceHost = source.url.hostname.toLowerCase();
  const allowedEntries = [];
  const blockedEntries = [];

  for (const entry of entries) {
    if (entry.url.hostname.toLowerCase() === sourceHost) {
      allowedEntries.push(entry);
    } else {
      blockedEntries.push(entry);
    }
  }

  const blockedHosts = [...new Set(blockedEntries.map((entry) => entry.url.hostname))].sort();

  if (blockedEntries.length > 0 && options.mode === "tui") {
    const action = await select({
      message: `This source links to ${blockedEntries.length} docs on external host${blockedEntries.length === 1 ? "" : "s"}.`,
      choices: [
        { name: `Skip external hosts and continue (${allowedEntries.length} docs)`, value: EXTERNAL_HOSTS_SKIP },
        { name: `Allow external hosts (${entries.length} docs)`, value: EXTERNAL_HOSTS_ALLOW },
      ],
    });

    if (action === EXTERNAL_HOSTS_ALLOW) {
      return { allowedEntries: entries, blockedEntries: [], blockedHosts: [] };
    }
  }

  return { allowedEntries, blockedEntries, blockedHosts };
}

function printPreparedStateNotes(preparedState) {
  const { blockedEntries, blockedHosts, installState, links, selectionState, uniqueLinks } = preparedState;

  console.log(
    `${tag("info")} Found ${links.length} markdown links, ${uniqueLinks.length} unique URLs, and selected ${selectionState.entries.length} docs.`,
  );

  if (installState.sameSource) {
    console.log(`${tag("info")} Existing managed install detected for this source.`);
  } else if (installState.manifest && installState.pathPrefix) {
    console.log(
      `${tag("info")} This source will be written under ${color.cyan(`${installState.pathPrefix}/`)} to keep managed installs separated.`,
    );
  } else if (installState.hasFiles && !installState.manifest) {
    console.log(`${tag("warn")} Existing unmanaged files detected. Removal tracking is disabled for this run.`);
  }

  if (blockedEntries.length > 0) {
    console.log(
      `${tag("warn")} Skipping ${blockedEntries.length} external-host docs for safety: ${blockedHosts.join(", ")}`,
    );
    console.log(color.dim("Re-run with --allow-external-hosts to include them."));
  }
}

async function inspectInstallState(outputDir, source, mode) {
  await fs.mkdir(outputDir, { recursive: true });

  const manifest = await loadInstallManifest(outputDir);
  const hasFiles = await directoryHasManagedCandidates(outputDir);
  const install = getManagedInstallForSource(manifest, source);
  const sameSource = Boolean(install);
  const pathPrefix = await resolveInstallPathPrefix(outputDir, manifest, source, install);

  if (!manifest && hasFiles && mode === "tui") {
    const shouldContinue = await confirm({
      default: false,
      message: "Directory already contains files and is not managed by llms2md. Continue without removal tracking?",
    });

    if (!shouldContinue) {
      return { cancelled: true, hasFiles, manifest, sameSource };
    }
  }

  return { cancelled: false, hasFiles, install, manifest, pathPrefix, sameSource };
}

async function resolveSelectionState(options, source, entries, manifest) {
  const currentInstall = getManagedInstallForSource(manifest, source);
  const sameSource = Boolean(currentInstall);
  const previousSelectedUrls = Array.isArray(currentInstall?.selectedUrls) ? currentInstall.selectedUrls : [];

  if (options.mode === "cli") {
    if (sameSource && previousSelectedUrls.length > 0) {
      const previousEntries = filterEntriesByUrls(entries, previousSelectedUrls);

      return {
        cancelled: false,
        entries: previousEntries,
        label: `previous selection (${previousEntries.length} docs)`,
      };
    }

    return {
      cancelled: false,
      entries,
      label: `all docs (${entries.length})`,
    };
  }

  while (true) {
    const choice = await select({
      message: "Which docs do you want to install?",
      choices: [
        ...(sameSource && previousSelectedUrls.length > 0
          ? [{ name: `Use previous selection (${previousSelectedUrls.length} docs)`, value: SELECTION_PREVIOUS }]
          : []),
        { name: `Install all docs (${entries.length})`, value: SELECTION_ALL },
        { name: "Choose docs manually", value: SELECTION_MANUAL },
        { name: "Cancel install", value: SELECTION_CANCEL },
      ],
    });

    if (choice === SELECTION_CANCEL) {
      return { cancelled: true, entries: [], label: "cancelled" };
    }

    if (choice === SELECTION_PREVIOUS) {
      const previousEntries = filterEntriesByUrls(entries, previousSelectedUrls);

      return {
        cancelled: false,
        entries: previousEntries,
        label: `previous selection (${previousEntries.length} docs)`,
      };
    }

    if (choice === SELECTION_MANUAL) {
      const selectedEntries = await chooseEntriesManually(entries);

      if (selectedEntries === null) {
        continue;
      }

      return {
        cancelled: false,
        entries: selectedEntries,
        label: `manual selection (${selectedEntries.length} docs)`,
      };
    }

    return {
      cancelled: false,
      entries,
      label: `all docs (${entries.length})`,
    };
  }
}

async function chooseEntriesManually(entries) {
  const selectedUrls = await checkbox({
    message: "Toggle docs on or off, then press enter to continue. Use the Back row at the top or bottom to return.",
    pageSize: Math.min(18, Math.max(8, entries.length)),
    choices: [
      {
        checked: false,
        description: "Return to the previous install options menu.",
        name: "<- Back to previous menu",
        value: MANUAL_SELECTION_BACK,
      },
      ...entries.map((entry) => ({
        checked: true,
        name: entry.title,
        description: formatEntryDescription(entry),
        value: entry.url.href,
      })),
      {
        checked: false,
        description: "Return to the previous install options menu.",
        name: "<- Back to previous menu",
        value: MANUAL_SELECTION_BACK_BOTTOM,
      },
    ],
    validate(value) {
      if (value.includes(MANUAL_SELECTION_BACK) || value.includes(MANUAL_SELECTION_BACK_BOTTOM)) {
        return true;
      }

      return value.length > 0 ? true : "Select at least one doc.";
    },
  });

  if (selectedUrls.includes(MANUAL_SELECTION_BACK) || selectedUrls.includes(MANUAL_SELECTION_BACK_BOTTOM)) {
    return null;
  }

  return filterEntriesByUrls(entries, selectedUrls, false);
}

function formatEntryDescription(entry) {
  if (entry.url.protocol === "http:" || entry.url.protocol === "https:") {
    return truncateMiddle(entry.url.pathname || "/", 72);
  }

  return truncateMiddle(fileURLToPath(entry.url), 72);
}

function filterEntriesByUrls(entries, selectedUrls, fallbackToAll = true) {
  const selected = new Set(selectedUrls);
  const filtered = entries.filter((entry) => selected.has(entry.url.href));
  return filtered.length > 0 || !fallbackToAll ? filtered : entries;
}

async function fetchSelectedEntries(entries, options, source) {
  const usedPaths = new Set();
  const limit = pLimit(MAX_CONCURRENCY);

  return Promise.all(
    entries.map((entry, index) =>
      limit(async () => {
        const result = await resolveEntryFetch(entry, index + 1, entries.length, options, source, usedPaths);

        if (result.ok) {
          console.log(`${tag("ok")} ${result.label} Prepared ${result.path}${formatVia(result.via)}`);
        }

        return result;
      }),
    ),
  );
}

async function resolveEntryFetch(entry, index, total, options, source, usedPaths) {
  const label = progressLabel(index, total);
  console.log(`${tag("work")} ${label} Fetching ${truncateMiddle(entry.url.href, 92)}`);

  const fetched = await fetchWithFallbacks(entry.url);

  if (!fetched.ok) {
    console.warn(`${tag("warn")} ${label} Failed ${truncateMiddle(entry.url.href, 92)}`);
    return {
      ok: false,
      reason: fetched.reason,
      url: entry.url.href,
    };
  }

  const markdown = toMarkdown(fetched.body, fetched.contentType, fetched.url);

  if (!markdown) {
    console.warn(`${tag("warn")} ${label} Failed ${truncateMiddle(entry.url.href, 92)}`);
    return {
      ok: false,
      reason: `unsupported content received from ${fetched.url.href}`,
      url: entry.url.href,
    };
  }

  return {
    content: ensureTrailingNewline(markdown),
    label,
    ok: true,
    path: uniqueRelativePath(buildOutputPath(entry, options.flat, source.localRootDir, source.pathPrefix), usedPaths),
    url: entry.url.href,
    via: fetched.url.href === entry.url.href ? "" : fetched.url.href,
  };
}

async function buildInstallPlan(outputDir, docs, manifest, source, hasFailures) {
  const currentInstall = getManagedInstallForSource(manifest, source);
  const sameSource = Boolean(currentInstall);
  const previousManagedFiles = Array.isArray(currentInstall?.managedFiles) ? currentInstall.managedFiles : [];
  const existingManagedContents = await readManagedContents(outputDir, previousManagedFiles);
  const nextDocsByPath = new Map(docs.map((doc) => [doc.path, doc.content]));
  const added = [];
  const changed = [];
  const unchanged = [];
  const removed = [];

  for (const [relativePath, content] of nextDocsByPath) {
    if (!existingManagedContents.has(relativePath)) {
      added.push(relativePath);
      continue;
    }

    if (existingManagedContents.get(relativePath) === content) {
      unchanged.push(relativePath);
      continue;
    }

    changed.push(relativePath);
  }

  if (sameSource && !hasFailures) {
    for (const relativePath of previousManagedFiles) {
      if (!nextDocsByPath.has(relativePath)) {
        removed.push(relativePath);
      }
    }
  }

  return {
    added: added.sort(),
    changed: changed.sort(),
    docs,
    hasFailures,
    manifest,
    removed: removed.sort(),
    sameSource,
    totalChanges: added.length + changed.length + removed.length,
    unchanged: unchanged.sort(),
  };
}

async function readManagedContents(outputDir, managedFiles) {
  const contents = new Map();

  for (const relativePath of managedFiles) {
    const absolutePath = path.join(outputDir, relativePath);

    try {
      contents.set(relativePath, await fs.readFile(absolutePath, "utf8"));
    } catch {
      continue;
    }
  }

  return contents;
}

async function reviewInstallPlan(plan) {
  while (true) {
    const action = await select({
      message: "Update review",
      choices: [
        { name: `Apply update (${plan.totalChanges} changes)`, value: UPDATE_ACTION_APPLY },
        {
          name: `Review changed files (${plan.changed.length})`,
          value: UPDATE_ACTION_CHANGED,
          disabled: plan.changed.length === 0,
        },
        {
          name: `Review added files (${plan.added.length})`,
          value: UPDATE_ACTION_ADDED,
          disabled: plan.added.length === 0,
        },
        {
          name: `Review removed files (${plan.removed.length})`,
          value: UPDATE_ACTION_REMOVED,
          disabled: plan.removed.length === 0,
        },
        { name: "Cancel", value: UPDATE_ACTION_CANCEL },
      ],
    });

    if (action === UPDATE_ACTION_APPLY) {
      return true;
    }

    if (action === UPDATE_ACTION_CANCEL) {
      return false;
    }

    if (action === UPDATE_ACTION_ADDED) {
      printPathList("Added files", plan.added);
      continue;
    }

    if (action === UPDATE_ACTION_REMOVED) {
      printPathList("Removed files", plan.removed);
      continue;
    }

    printPathList("Changed files", plan.changed);
  }
}

function printChangeSummary(plan, hasFailures) {
  console.log(color.bold("Update summary"));
  console.log(`  ${color.dim("added    ")} ${plan.added.length}`);
  console.log(`  ${color.dim("changed  ")} ${plan.changed.length}`);
  console.log(`  ${color.dim("removed  ")} ${plan.removed.length}`);
  console.log(`  ${color.dim("unchanged")} ${plan.unchanged.length}`);

  if (hasFailures) {
    console.log(`  ${color.dim("note     ")} removals are paused because some docs failed to fetch`);
  }
}

function printPathList(title, items) {
  console.log();
  console.log(color.bold(title));

  for (const item of items.slice(0, 25)) {
    console.log(`  ${item}`);
  }

  if (items.length > 25) {
    console.log(color.dim(`  ...and ${items.length - 25} more`));
  }

  console.log();
}

async function applyInstallPlan(outputDir, docs, plan) {
  for (const doc of docs) {
    const outputPath = path.join(outputDir, doc.path);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, doc.content, "utf8");
    console.log(`${tag("ok")} ${doc.label} Saved ${doc.path}${formatVia(doc.via)}`);
  }

  for (const relativePath of plan.removed) {
    const outputPath = path.join(outputDir, relativePath);
    await fs.rm(outputPath, { force: true });
    await pruneEmptyDirectories(outputDir, path.dirname(outputPath));
    console.log(`${tag("ok")} Removed ${relativePath}`);
  }
}

function createInstallManifest({ docs, manifest, options, plan, selectedEntries, source }) {
  const existingInstalls = getManifestInstalls(manifest);
  const previousInstall = getManagedInstallForSource(manifest, source);
  const previousManaged = Array.isArray(previousInstall?.managedFiles) ? previousInstall.managedFiles : [];
  const nextManaged = plan.hasFailures
    ? [...new Set([...previousManaged, ...docs.map((doc) => doc.path)])].sort()
    : docs.map((doc) => doc.path).sort();

  const nextInstall = {
    layout: options.flat ? "flat" : "nested",
    managedFiles: nextManaged,
    pathPrefix: source.pathPrefix || "",
    selectedUrls: selectedEntries.map((entry) => entry.url.href),
    source: {
      label: source.label,
      url: source.url.href,
    },
  };

  let replaced = false;
  const installs = existingInstalls.map((install) => {
    if (install?.source?.url === source.url.href) {
      replaced = true;
      return nextInstall;
    }

    return normalizeInstallRecordForWrite(install);
  });

  if (!replaced) {
    installs.push(nextInstall);
  }

  return {
    generatedAt: new Date().toISOString(),
    installs,
    version: 2,
  };
}

async function loadInstallManifest(outputDir) {
  try {
    return JSON.parse(await fs.readFile(getManifestPath(outputDir), "utf8"));
  } catch {
    return null;
  }
}

async function writeInstallManifest(outputDir, manifest) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(getManifestPath(outputDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function directoryHasManagedCandidates(outputDir) {
  try {
    const entries = await fs.readdir(outputDir);
    return entries.some((entry) => entry !== MANIFEST_FILENAME);
  } catch {
    return false;
  }
}

function getManifestPath(outputDir) {
  return path.join(outputDir, MANIFEST_FILENAME);
}

function getManifestInstalls(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return [];
  }

  if (Array.isArray(manifest.installs)) {
    return manifest.installs.filter((install) => install && typeof install === "object");
  }

  if (
    "source" in manifest ||
    "managedFiles" in manifest ||
    "selectedUrls" in manifest ||
    "layout" in manifest ||
    "pathPrefix" in manifest
  ) {
    return [manifest];
  }

  return [];
}

function getManagedInstallForSource(manifest, source) {
  return getManifestInstalls(manifest).find((install) => install?.source?.url === source.url.href) || null;
}

function isManagedInstallForSource(manifest, source) {
  return Boolean(getManagedInstallForSource(manifest, source));
}

async function resolveInstallPathPrefix(outputDir, manifest, source, install) {
  if (typeof install?.pathPrefix === "string") {
    return install.pathPrefix;
  }

  if (install) {
    return "";
  }

  const existingInstalls = getManifestInstalls(manifest);

  if (existingInstalls.length === 0) {
    return "";
  }

  const usedPrefixes = new Set(existingInstalls.map((entry) => entry?.pathPrefix).filter(Boolean));
  const basePrefix = defaultInstallPathPrefix(source);
  let candidate = basePrefix;
  let counter = 2;

  while (usedPrefixes.has(candidate) || await outputEntryExists(outputDir, candidate)) {
    candidate = `${basePrefix}-${counter}`;
    counter += 1;
  }

  return candidate;
}

function defaultInstallPathPrefix(source) {
  if (source.slug) {
    return sanitizeSegment(source.slug) || "docs";
  }

  if (isRemoteHttpSource(source)) {
    return sanitizeSegment(source.url.hostname.replace(/\.+/gu, "-")) || "docs";
  }

  const localPath = fileURLToPath(source.url);
  const parsed = path.parse(localPath);
  return sanitizeSegment(parsed.name) || sanitizeSegment(path.basename(parsed.dir)) || "docs";
}

function normalizeInstallRecordForWrite(install) {
  return {
    layout: install?.layout === "flat" ? "flat" : "nested",
    managedFiles: Array.isArray(install?.managedFiles)
      ? [...new Set(install.managedFiles.filter((entry) => typeof entry === "string"))].sort()
      : [],
    pathPrefix: typeof install?.pathPrefix === "string" ? install.pathPrefix : "",
    selectedUrls: Array.isArray(install?.selectedUrls)
      ? [...new Set(install.selectedUrls.filter((entry) => typeof entry === "string"))]
      : [],
    source: install?.source && typeof install.source === "object" ? { ...install.source } : {},
  };
}

async function outputEntryExists(outputDir, relativePath) {
  try {
    await fs.access(path.join(outputDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

function isRemoteHttpSource(source) {
  return source.url.protocol === "http:" || source.url.protocol === "https:";
}

async function pruneEmptyDirectories(outputDir, currentDirectory) {
  let directory = currentDirectory;

  while (directory.startsWith(outputDir) && directory !== outputDir) {
    try {
      const entries = await fs.readdir(directory);

      if (entries.length > 0) {
        return;
      }

      await fs.rmdir(directory);
      directory = path.dirname(directory);
    } catch {
      return;
    }
  }
}

function formatVia(via) {
  return via ? color.dim(` via ${via}`) : "";
}

async function processLink(entry, index, total, options, source, usedPaths) {
  const result = await resolveEntryFetch(entry, index, total, options, source, usedPaths);

  if (!result.ok) {
    return result;
  }

  const outputPath = path.join(options.outputDir, result.path);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, result.content, "utf8");
  console.log(`${tag("ok")} ${result.label} Saved ${result.path}${formatVia(result.via)}`);

  return {
    ok: true,
    path: result.path,
    url: result.url,
  };
}

async function loadRegistry() {
  const text = await fs.readFile(REGISTRY_FILE, "utf8");
  const entries = [];

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const [slug, label, url] = line.split("|").map((part) => part.trim());
    if (!slug || !label || !url) {
      console.warn(`Skipping malformed registry line: ${rawLine}`);
      continue;
    }

    entries.push({ label, slug, url });
  }

  return entries.sort((left, right) => left.label.localeCompare(right.label));
}

function printRegistry(registry) {
  console.log(color.bold(`Curated sources (${registry.length})`));
  console.log();

  const width = registry.reduce((max, entry) => Math.max(max, entry.slug.length), 0);

  for (const entry of registry) {
    console.log(`  ${color.cyan(entry.slug.padEnd(width))}  ${entry.label}`);
    console.log(`  ${" ".repeat(width)}  ${color.dim(entry.url)}`);
  }

  console.log();
  console.log(color.dim("Run `llms2md` with no arguments to launch the interactive picker."));
}

async function resolveSource(input, registry) {
  const registryEntry = findRegistryEntry(input, registry);
  if (registryEntry) {
    const url = new URL(registryEntry.url);

    return {
      label: `${registryEntry.label} (${registryEntry.slug})`,
      localRootDir: url.protocol === "file:" ? path.dirname(fileURLToPath(url)) : null,
      slug: registryEntry.slug,
      url,
    };
  }

  const remote = tryParseUrl(input);

  if (remote && (remote.protocol === "http:" || remote.protocol === "https:")) {
    return {
      label: remote.href,
      localRootDir: null,
      slug: null,
      url: remote,
    };
  }

  const absolutePath = path.resolve(input);
  return {
    label: absolutePath,
    localRootDir: path.dirname(absolutePath),
    slug: null,
    url: pathToFileURL(absolutePath),
  };
}

function findRegistryEntry(input, registry) {
  const normalized = input.trim().toLowerCase();
  const looksLikePath = /[\/]/u.test(input) || input.startsWith(".") || input.startsWith("~") || input.includes(":");

  if (looksLikePath) {
    return null;
  }

  return registry.find(
    (entry) =>
      entry.slug.toLowerCase() === normalized ||
      entry.label.toLowerCase() === normalized,
  ) || null;
}

function tryParseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function extractLinks(llmsText, baseUrl) {
  const links = [];

  for (const line of llmsText.split(/\r?\n/u)) {
    if (!line.includes("](")) {
      continue;
    }

    for (const match of line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu)) {
      const title = match[1].trim();
      const href = normalizeHref(match[2]);

      if (!href) {
        continue;
      }

      let resolved;

      try {
        resolved = new URL(href, baseUrl);
      } catch {
        console.warn(`Skipping invalid link target: ${href}`);
        continue;
      }

      resolved.hash = "";

      if (!SUPPORTED_PROTOCOLS.has(resolved.protocol)) {
        console.warn(`Skipping unsupported link protocol: ${resolved.href}`);
        continue;
      }

      links.push({
        title,
        url: resolved,
      });
    }
  }

  return links;
}

function normalizeHref(rawHref) {
  let href = rawHref.trim();

  if (href.startsWith("<") && href.endsWith(">")) {
    href = href.slice(1, -1).trim();
  }

  const titleMatch = href.match(/^(\S+)\s+["'][^"']+["']$/u);
  if (titleMatch) {
    href = titleMatch[1];
  }

  return href;
}

function dedupeLinks(links) {
  const seen = new Set();
  const unique = [];

  for (const link of links) {
    const key = link.url.href;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(link);
  }

  return unique;
}

function buildCandidateUrls(originalUrl) {
  const candidates = new Map();

  const pushCandidate = (candidate) => {
    candidates.set(candidate.href, candidate);
  };

  pushCandidate(cloneUrl(originalUrl));

  const trimmedPath = trimTrailingSlash(originalUrl.pathname);
  const hasNonRootPath = trimmedPath.length > 1;

  if (hasNonRootPath) {
    pushCandidate(withPathname(originalUrl, `${trimmedPath}.md`));
  }

  const indexPath = originalUrl.pathname.endsWith("/")
    ? `${originalUrl.pathname}index.md`
    : `${originalUrl.pathname}/index.md`;
  pushCandidate(withPathname(originalUrl, indexPath));

  if (hasNonRootPath) {
    pushCandidate(withPathname(originalUrl, `${trimmedPath}.html.md`));
  }

  return [...candidates.values()];
}

async function fetchWithFallbacks(originalUrl) {
  const failures = [];

  for (const candidate of buildCandidateUrls(originalUrl)) {
    const result = await readTextResource(candidate);

    if (!result.ok) {
      failures.push(`${candidate.href} (${result.reason})`);
      continue;
    }

    return {
      body: result.body,
      contentType: result.contentType,
      ok: true,
      url: candidate,
    };
  }

  return {
    ok: false,
    reason: failures.join("; "),
  };
}

async function readTextResource(url) {
  if (url.protocol === "file:") {
    return readLocalText(url);
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    return readRemoteText(url);
  }

  return {
    ok: false,
    reason: `unsupported protocol ${url.protocol}`,
  };
}

async function readLocalText(url) {
  try {
    const body = await fs.readFile(fileURLToPath(url), "utf8");
    return {
      body,
      contentType: guessLocalContentType(url),
      ok: true,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readRemoteText(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "llms2md/1.0.0",
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    return {
      body: await response.text(),
      contentType: response.headers.get("content-type") || "",
      ok: true,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function guessLocalContentType(url) {
  const lowerPath = url.pathname.toLowerCase();

  if (lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")) {
    return "text/html";
  }

  if (lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown") || lowerPath.endsWith(".mdx")) {
    return "text/markdown";
  }

  return "text/plain";
}

function toMarkdown(body, contentType, url) {
  if (!body.trim()) {
    return "";
  }

  if (isHtml(body, contentType, url)) {
    return turndown.turndown(body).trim();
  }

  if (isMarkdown(body, contentType, url)) {
    return body.trimEnd();
  }

  return null;
}

function isHtml(body, contentType, url) {
  const lowerType = contentType.toLowerCase();
  if (lowerType.includes("text/html") || lowerType.includes("application/xhtml+xml")) {
    return true;
  }

  const lowerPath = url.pathname.toLowerCase();
  if (lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")) {
    return true;
  }

  const sample = body.slice(0, 2000).trimStart();
  return /^(<!doctype html|<html[\s>])/iu.test(sample) || /<(head|body|article|main)[\s>]/iu.test(sample);
}

function isMarkdown(body, contentType, url) {
  const lowerType = contentType.toLowerCase();
  if (lowerType.includes("markdown") || lowerType.startsWith("text/plain")) {
    return true;
  }

  const lowerPath = url.pathname.toLowerCase();
  if (
    lowerPath.endsWith(".md") ||
    lowerPath.endsWith(".markdown") ||
    lowerPath.endsWith(".mdx") ||
    lowerPath.endsWith(".html.md")
  ) {
    return true;
  }

  const sample = body.slice(0, 2000);
  return /^#{1,6}\s|^[-*+]\s|^\d+\.\s|^>\s|\[[^\]]+\]\([^\)]+\)/mu.test(sample);
}

function buildOutputPath(entry, flat, localRootDir, pathPrefix = "") {
  const relativePath = flat
    ? `${buildFlatName(entry)}.md`
    : path.join(
      ...(entry.url.protocol === "file:"
        ? buildLocalOutputSegments(entry.url, entry.title, localRootDir)
        : buildRemoteOutputSegments(entry.url, entry.title)),
    );

  return pathPrefix ? path.join(pathPrefix, relativePath) : relativePath;
}

function buildRemoteOutputSegments(url, title) {
  const rawSegments = url.pathname.split("/").filter(Boolean);
  const endsWithSlash = url.pathname.endsWith("/");

  if (rawSegments.length === 0) {
    return ["index.md"];
  }

  const directorySegments = rawSegments.slice(0, -1).map((segment) => sanitizeSegment(segment) || "section");
  const lastSegment = rawSegments[rawSegments.length - 1];
  const stem = sanitizeSegment(stripDocumentExtension(lastSegment));

  if (endsWithSlash) {
    return [...rawSegments.map((segment) => sanitizeSegment(segment) || "section"), "index.md"];
  }

  const fileStem = stem || sanitizeSegment(title) || "index";
  return [...directorySegments, `${fileStem}.md`];
}

function buildLocalOutputSegments(url, title, localRootDir) {
  if (!localRootDir) {
    return buildRemoteOutputSegments(url, title);
  }

  const absolutePath = fileURLToPath(url);
  const relativePath = path.relative(localRootDir, absolutePath);
  const endsWithSlash = url.pathname.endsWith("/");

  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    const normalized = relativePath.split(path.sep).filter(Boolean);

    if (endsWithSlash) {
      return [...normalized.map((segment) => sanitizeSegment(segment) || "section"), "index.md"];
    }

    const directorySegments = normalized
      .slice(0, -1)
      .map((segment) => sanitizeSegment(segment) || "section");
    const basename = normalized[normalized.length - 1];
    const fileStem = sanitizeSegment(stripDocumentExtension(basename)) || sanitizeSegment(title) || "document";
    return [...directorySegments, `${fileStem}.md`];
  }

  return [`${buildFlatName({ title, url })}.md`];
}

function buildFlatName(entry) {
  return sanitizeSegment(entry.title) || sanitizeSegment(urlSlug(entry.url));
}

function urlSlug(url) {
  const parts = [];

  if (url.protocol === "http:" || url.protocol === "https:") {
    parts.push(url.hostname);
  }

  for (const segment of url.pathname.split("/").filter(Boolean)) {
    const clean = sanitizeSegment(stripDocumentExtension(segment));
    if (clean) {
      parts.push(clean);
    }
  }

  if (parts.length === 0) {
    return "index";
  }

  return parts.join("-");
}

function uniqueRelativePath(relativePath, usedPaths) {
  const normalizedPath = path.normalize(relativePath);
  const parsed = path.parse(normalizedPath);
  let candidate = normalizedPath;
  let counter = 2;

  while (usedPaths.has(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${counter}${parsed.ext}`);
    counter += 1;
  }

  usedPaths.add(candidate);
  return candidate;
}

function sanitizeSegment(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/%[0-9a-f]{2}/giu, "-")
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[-._]+|[-._]+$/gu, "")
    .toLowerCase();
}

function stripDocumentExtension(value) {
  return value.replace(/(\.html\.md|\.md|\.markdown|\.mdx|\.html|\.htm)$/iu, "");
}

function trimTrailingSlash(value) {
  if (value === "/") {
    return value;
  }

  return value.replace(/\/+$/u, "");
}

function cloneUrl(url) {
  return new URL(url.href);
}

function withPathname(url, pathname) {
  const next = cloneUrl(url);
  next.pathname = pathname;
  return next;
}

function ensureTrailingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function getUsage() {
  return [
    "Usage:",
    "  npx llms2md",
    "  npx llms2md <llms.txt url|file|registry slug> [output directory] [--flat] [--dry-run]",
    "  npx llms2md --list-sources",
    "",
    "Direct CLI examples:",
    "  npx llms2md stripe",
    "  npx llms2md stripe ./docs",
    "  npx llms2md https://docs.usebruno.com/llms.txt ./docs",
    "  npx llms2md ./llms.txt ./docs --flat",
    "  npx llms2md mcp ./docs --dry-run",
    "",
    "Interactive mode:",
    "  Run `npx llms2md` with no arguments to launch the TUI.",
    "",
    "Registry submissions:",
    "  See README.md and CONTRIBUTING.md for how to add a new public llms.txt source.",
  ].join("\n");
}

function isColorEnabled(stdout = process.stdout, env = process.env) {
  return Boolean(stdout.isTTY) && env.NO_COLOR !== "1";
}

function paint(code, value) {
  if (!isColorEnabled()) {
    return value;
  }

  return `\u001B[${code}m${value}\u001B[0m`;
}

function printBanner() {
  const title = `${color.bold(color.cyan("llms2md"))} ${color.dim("Turn llms.txt into a clean local Markdown docs tree.")}`;
  console.log(title);
  console.log(color.dim("-".repeat(72)));
}

function printRunSummary({ flat, outputDir, selectionLabel, sourceLabel }) {
  console.log(color.bold("Run"));
  console.log(`  ${color.dim("source ")} ${sourceLabel}`);
  console.log(`  ${color.dim("output ")} ${outputDir}`);
  console.log(`  ${color.dim("layout ")} ${flat ? "flat" : "nested"}`);

  if (selectionLabel) {
    console.log(`  ${color.dim("select ")} ${selectionLabel}`);
  }

  console.log();
}

function tag(kind) {
  if (kind === "ok") {
    return color.green("[ok]");
  }

  if (kind === "warn") {
    return color.yellow("[!]");
  }

  if (kind === "fail") {
    return color.red("[x]");
  }

  if (kind === "work") {
    return color.cyan("[>]");
  }

  return color.dim("[i]");
}

function progressLabel(index, total) {
  const width = String(total).length;
  return `[${String(index).padStart(width)}/${total}]`;
}

function truncateMiddle(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  const sideLength = Math.max(8, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, sideLength)}...${value.slice(-sideLength)}`;
}

export {
  CURRENT_DIRECTORY,
  CUSTOM_DIRECTORY,
  CUSTOM_SOURCE,
  DEFAULT_OUTPUT_DIR,
  EXTERNAL_HOSTS_ALLOW,
  EXTERNAL_HOSTS_SKIP,
  MANUAL_SELECTION_BACK,
  MANUAL_SELECTION_BACK_BOTTOM,
  MANIFEST_FILENAME,
  MAX_CONCURRENCY,
  REGISTRY_FILE,
  SELECTION_ALL,
  SELECTION_CANCEL,
  SELECTION_MANUAL,
  SELECTION_PREVIOUS,
  SUPPORTED_PROTOCOLS,
  UPDATE_ACTION_ADDED,
  UPDATE_ACTION_APPLY,
  UPDATE_ACTION_CANCEL,
  UPDATE_ACTION_CHANGED,
  UPDATE_ACTION_REMOVED,
  applyInstallPlan,
  buildCandidateUrls,
  buildFlatName,
  buildInstallPlan,
  buildLocalOutputSegments,
  buildOutputPath,
  buildRemoteOutputSegments,
  chooseEntriesManually,
  cloneUrl,
  color,
  createInstallManifest,
  dedupeLinks,
  defaultInstallPathPrefix,
  directoryHasManagedCandidates,
  ensureTrailingNewline,
  extractLinks,
  fetchWithFallbacks,
  fetchSelectedEntries,
  findRegistryEntry,
  filterEntriesByUrls,
  formatEntryDescription,
  formatVia,
  getManifestPath,
  getUsage,
  guessLocalContentType,
  handleMainError,
  inspectInstallState,
  isColorEnabled,
  isHtml,
  isRemoteHttpSource,
  isManagedInstallForSource,
  isMarkdown,
  loadInstallManifest,
  loadRegistry,
  main,
  normalizeHref,
  normalizeInstallRecordForWrite,
  paint,
  parseArgs,
  prepareImportState,
  printChangeSummary,
  printBanner,
  printPathList,
  printPreparedStateNotes,
  printRegistry,
  printRunSummary,
  processLink,
  progressLabel,
  pruneEmptyDirectories,
  readLocalText,
  readManagedContents,
  readRemoteText,
  readTextResource,
  resolveEntryFetch,
  resolveCliRunOptions,
  resolveHostPolicy,
  resolveInteractiveRunOptions,
  resolveSelectionState,
  resolveSource,
  reviewInstallPlan,
  runImport,
  sanitizeSegment,
  stripDocumentExtension,
  tag,
  toMarkdown,
  trimTrailingSlash,
  truncateMiddle,
  tryParseUrl,
  turndown,
  uniqueRelativePath,
  urlSlug,
  withPathname,
  writeInstallManifest,
};
