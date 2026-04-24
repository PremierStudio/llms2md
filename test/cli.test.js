import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@inquirer/prompts", () => ({
  checkbox: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
  select: vi.fn(),
}));

vi.mock("node-fetch", () => ({
  default: vi.fn(),
}));

const cli = await import("../lib/cli.js");
const prompts = await import("@inquirer/prompts");
const fetchModule = await import("node-fetch");

const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalNoColor = process.env.NO_COLOR;
const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;

function setTTY(stdin, stdout) {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdin });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdout });
}

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "llms2md-cli-test-"));
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function mockFetchResponse({ ok = true, status = 200, statusText = "OK", contentType = "text/plain", body = "" }) {
  return {
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? contentType : null;
      },
    },
    ok,
    status,
    statusText,
    text: vi.fn().mockResolvedValue(body),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.argv = [...originalArgv];
  process.exitCode = undefined;
  process.env.NO_COLOR = originalNoColor;
  setTTY(false, false);
});

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = undefined;
  process.env.NO_COLOR = originalNoColor;
});

afterAll(() => {
  if (originalStdoutIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
  }

  if (originalStdinIsTTY) {
    Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
  }

  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  process.env.NO_COLOR = originalNoColor;
});

describe("parseArgs", () => {
  it("parses flags and positional arguments", () => {
    const result = cli.parseArgs(["stripe", "./docs", "--flat", "--dry-run", "--list-sources"]);

    expect(result).toEqual({
      dryRun: true,
      flat: true,
      help: false,
      input: "stripe",
      listSources: true,
      outputDir: path.resolve("./docs"),
    });
  });

  it("parses help aliases", () => {
    expect(cli.parseArgs(["-h"]).help).toBe(true);
    expect(cli.parseArgs(["--help"]).help).toBe(true);
  });
});

describe("core helpers", () => {
  it("normalizes href values", () => {
    expect(cli.normalizeHref(" <./docs> ")).toBe("./docs");
    expect(cli.normalizeHref("./docs \"Title\"")).toBe("./docs");
  });

  it("extracts links, skips invalid links, and removes hashes", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const baseUrl = new URL("https://example.com/llms.txt");
    const links = cli.extractLinks(
      [
        "Text only",
        "[Good](./guide#intro)",
        "[Empty](   )",
        "[Unsupported](mailto:test@example.com)",
        "[Broken](http://[)",
      ].join("\n"),
      baseUrl,
    );

    expect(links).toHaveLength(1);
    expect(links[0].url.href).toBe("https://example.com/guide");
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("deduplicates links by absolute URL", () => {
    const links = [
      { title: "One", url: new URL("https://example.com/a") },
      { title: "Two", url: new URL("https://example.com/a") },
      { title: "Three", url: new URL("https://example.com/b") },
    ];

    expect(cli.dedupeLinks(links)).toHaveLength(2);
  });

  it("builds candidate URLs for root and nested paths", () => {
    expect(cli.buildCandidateUrls(new URL("https://example.com/")).map((url) => url.href)).toEqual([
      "https://example.com/",
      "https://example.com/index.md",
    ]);

    expect(cli.buildCandidateUrls(new URL("https://example.com/guide/auth")).map((url) => url.href)).toEqual([
      "https://example.com/guide/auth",
      "https://example.com/guide/auth.md",
      "https://example.com/guide/auth/index.md",
      "https://example.com/guide/auth.html.md",
    ]);
  });

  it("creates output paths for flat, remote, and local layouts", () => {
    const remoteEntry = { title: "Auth Guide", url: new URL("https://example.com/guide/auth") };
    const localEntry = { title: "Auth Guide", url: pathToFileURL("/tmp/project/pages/guide/auth.md") };

    expect(cli.buildOutputPath(remoteEntry, true, null)).toBe("auth-guide.md");
    expect(cli.buildOutputPath(remoteEntry, false, null)).toBe(path.join("guide", "auth.md"));
    expect(cli.buildOutputPath(localEntry, false, "/tmp/project")).toBe(path.join("pages", "guide", "auth.md"));
  });

  it("handles remote and local output segment edge cases", () => {
    expect(cli.buildRemoteOutputSegments(new URL("https://example.com/"), "Home")).toEqual(["index.md"]);
    expect(cli.buildRemoteOutputSegments(new URL("https://example.com/guide/"), "Guide")).toEqual([
      "guide",
      "index.md",
    ]);
    expect(cli.buildRemoteOutputSegments(new URL("https://example.com/%20/file"), "File")).toEqual([
      "section",
      "file.md",
    ]);
    expect(cli.buildRemoteOutputSegments(new URL("https://example.com/%20"), "Fallback")).toEqual(["fallback.md"]);
    expect(cli.buildRemoteOutputSegments(new URL("https://example.com/%20"), "")).toEqual(["index.md"]);
    expect(cli.buildRemoteOutputSegments(new URL("https://example.com/%20/"), "Folder")).toEqual([
      "section",
      "index.md",
    ]);
    expect(cli.buildLocalOutputSegments(pathToFileURL("/tmp/project/docs/file.md"), "File", null)).toEqual([
      "tmp",
      "project",
      "docs",
      "file.md",
    ]);
    expect(cli.buildLocalOutputSegments(pathToFileURL("/outside/docs/file.md"), "File", "/tmp/project")).toEqual([
      "file.md",
    ]);
    expect(cli.buildLocalOutputSegments(pathToFileURL("/tmp/project/%20/file.md"), "File", "/tmp/project")).toEqual([
      "section",
      "file.md",
    ]);
    expect(cli.buildLocalOutputSegments(pathToFileURL("/tmp/project/%20"), "", "/tmp/project")).toEqual([
      "document.md",
    ]);
    expect(cli.buildLocalOutputSegments(pathToFileURL("/tmp/project/%20/"), "", "/tmp/project")).toEqual([
      "section",
      "index.md",
    ]);
    expect(cli.buildLocalOutputSegments(pathToFileURL("/tmp/project/docs/"), "Folder", "/tmp/project")).toEqual([
      "docs",
      "index.md",
    ]);
  });

  it("builds flat names and URL slugs", () => {
    expect(cli.buildFlatName({ title: "", url: new URL("https://example.com/guide/auth") })).toBe(
      "example.com-guide-auth",
    );
    expect(cli.urlSlug(new URL("file:///tmp"))).toBe("tmp");
    expect(cli.urlSlug(new URL("file:///"))).toBe("index");
    expect(cli.urlSlug(new URL("https://example.com/"))).toBe("example.com");
  });

  it("creates unique output paths", () => {
    const used = new Set();
    expect(cli.uniqueRelativePath("docs/readme.md", used)).toBe(path.normalize("docs/readme.md"));
    expect(cli.uniqueRelativePath("docs/readme.md", used)).toBe(path.normalize("docs/readme-2.md"));
  });

  it("sanitizes values and strips known extensions", () => {
    expect(cli.sanitizeSegment("Héllo World!.md")).toBe("hello-world-.md");
    expect(cli.stripDocumentExtension("guide.html.md")).toBe("guide");
    expect(cli.trimTrailingSlash("/docs///")).toBe("/docs");
    expect(cli.trimTrailingSlash("/")).toBe("/");
  });

  it("clones URLs and updates pathnames", () => {
    const original = new URL("https://example.com/a?x=1");
    const clone = cli.cloneUrl(original);
    const updated = cli.withPathname(original, "/b");

    expect(clone.href).toBe(original.href);
    expect(updated.href).toBe("https://example.com/b?x=1");
  });

  it("ensures trailing newlines and formats progress", () => {
    expect(cli.ensureTrailingNewline("hello")).toBe("hello\n");
    expect(cli.ensureTrailingNewline("hello\n")).toBe("hello\n");
    expect(cli.progressLabel(3, 12)).toBe("[ 3/12]");
    expect(cli.truncateMiddle("short", 10)).toBe("short");
    expect(cli.truncateMiddle("abcdefghijklmnopqrstuvwxyz", 12)).toContain("...");
  });

  it("creates tags and usage text", () => {
    expect(cli.tag("ok")).toContain("[ok]");
    expect(cli.tag("warn")).toContain("[!]");
    expect(cli.tag("fail")).toContain("[x]");
    expect(cli.tag("work")).toContain("[>]");
    expect(cli.tag("info")).toContain("[i]");
    expect(cli.getUsage()).toContain("npx llms2md stripe");
  });

  it("handles color enablement", () => {
    expect(cli.isColorEnabled({ isTTY: true }, { NO_COLOR: "0" })).toBe(true);
    expect(cli.isColorEnabled({ isTTY: false }, { NO_COLOR: "0" })).toBe(false);
    expect(cli.isColorEnabled({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);

    setTTY(true, true);
    process.env.NO_COLOR = "0";
    expect(cli.paint(32, "hello")).toContain("\u001B[32m");
    process.env.NO_COLOR = "1";
    expect(cli.paint(32, "hello")).toBe("hello");
  });

  it("prints banner, run summary, and registry", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    cli.printBanner();
    cli.printRunSummary({ flat: false, outputDir: "/tmp/docs", selectionLabel: "all docs", sourceLabel: "Stripe" });
    cli.printRegistry([
      { label: "B Source", slug: "b", url: "https://b.test/llms.txt" },
      { label: "A Source", slug: "aa", url: "https://a.test/llms.txt" },
    ]);

    expect(logSpy).toHaveBeenCalled();
  });
});

describe("source resolution and registry loading", () => {
  it("loads and sorts the registry while warning on malformed lines", async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, "sources.txt");
    await writeFile(
      filePath,
      [
        "# comment",
        "b|B Source|https://b.test/llms.txt",
        "invalid line",
        "a|A Source|https://a.test/llms.txt",
      ].join("\n"),
    );

    const readSpy = vi.spyOn(fs, "readFile");
    readSpy.mockResolvedValueOnce(await fs.readFile(filePath, "utf8"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const entries = await cli.loadRegistry();

    expect(entries.map((entry) => entry.slug)).toEqual(["a", "b"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    readSpy.mockRestore();
  });

  it("finds registry entries and resolves sources", async () => {
    const registry = [{ label: "Stripe Docs", slug: "stripe", url: "https://docs.stripe.com/llms.txt" }];
    const fileSource = await cli.resolveSource("./package.json", registry);
    const remoteSource = await cli.resolveSource("https://example.com/llms.txt", registry);
    const registrySource = await cli.resolveSource("stripe", registry);

    expect(cli.findRegistryEntry("stripe", registry)?.slug).toBe("stripe");
    expect(cli.findRegistryEntry("stripe docs", registry)?.slug).toBe("stripe");
    expect(cli.findRegistryEntry("./stripe", registry)).toBeNull();
    expect(cli.findRegistryEntry("unknown", registry)).toBeNull();
    expect(remoteSource.url.href).toBe("https://example.com/llms.txt");
    expect(registrySource.label).toContain("stripe");
    expect(fileSource.url.protocol).toBe("file:");
  });

  it("parses URLs safely", () => {
    expect(cli.tryParseUrl("https://example.com").href).toBe("https://example.com/");
    expect(cli.tryParseUrl("not a url")).toBeNull();
  });

  it("loads and writes install manifests", async () => {
    const tempDir = await createTempDir();
    const manifest = {
      managedFiles: ["docs/page.md"],
      selectedUrls: ["https://example.com/page"],
      source: { label: "Example", url: "https://example.com/llms.txt" },
      version: 1,
    };

    expect(cli.getManifestPath(tempDir)).toBe(path.join(tempDir, cli.MANIFEST_FILENAME));
    expect(await cli.loadInstallManifest(tempDir)).toBeNull();

    await cli.writeInstallManifest(tempDir, manifest);

    expect(await cli.loadInstallManifest(tempDir)).toEqual(manifest);
  });

  it("detects managed install state and existing files", async () => {
    const tempDir = await createTempDir();
    const source = { label: "Example", url: new URL("https://example.com/llms.txt") };
    const manifest = {
      managedFiles: ["docs/page.md"],
      selectedUrls: ["https://example.com/page"],
      source: { label: "Example", url: source.url.href },
      version: 1,
    };

    await writeFile(path.join(tempDir, "docs", "page.md"), "# Page\n");
    expect(await cli.directoryHasManagedCandidates(tempDir)).toBe(true);
    expect(cli.isManagedInstallForSource(manifest, source)).toBe(true);
    expect(cli.isManagedInstallForSource(null, source)).toBe(false);

    await cli.writeInstallManifest(tempDir, manifest);
    const state = await cli.inspectInstallState(tempDir, source, "cli");
    expect(state.sameSource).toBe(true);

    const otherState = await cli.inspectInstallState(
      path.join(tempDir, "other"),
      source,
      "cli",
    );
    expect(otherState.hasFiles).toBe(false);

    expect(await cli.readManagedContents(tempDir, ["docs/page.md", "missing.md"])).toEqual(
      new Map([["docs/page.md", "# Page\n"]]),
    );
  });

  it("rejects conflicting managed installs and can cancel unmanaged tui state", async () => {
    const tempDir = await createTempDir();
    const source = { label: "Example", url: new URL("https://example.com/llms.txt") };
    await cli.writeInstallManifest(tempDir, {
      managedFiles: ["docs/page.md"],
      selectedUrls: [],
      source: { label: "Other", url: "https://other.example.com/llms.txt" },
      version: 1,
    });

    await expect(cli.inspectInstallState(tempDir, source, "cli")).rejects.toThrow("already managed");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const tuiConflict = await cli.inspectInstallState(tempDir, source, "tui");
    expect(tuiConflict.cancelled).toBe(true);
    expect(logSpy).toHaveBeenCalled();

    const unmanagedDir = await createTempDir();
    await writeFile(path.join(unmanagedDir, "notes.md"), "# Notes\n");
    vi.mocked(prompts.confirm).mockResolvedValueOnce(false);
    const cancelled = await cli.inspectInstallState(unmanagedDir, source, "tui");
    expect(cancelled.cancelled).toBe(true);

    await cli.writeInstallManifest(path.join(tempDir, "fallback"), {
      managedFiles: [],
      selectedUrls: [],
      source: {},
      version: 1,
    });
    await expect(cli.inspectInstallState(path.join(tempDir, "fallback"), source, "cli")).rejects.toThrow(
      "another llms2md install",
    );
  });

  it("resolves selection state for cli and tui flows", async () => {
    const source = { label: "Example", url: new URL("https://example.com/llms.txt") };
    const entries = [
      { title: "One", url: new URL("https://example.com/one") },
      { title: "Two", url: new URL("https://example.com/two") },
    ];
    const manifest = {
      selectedUrls: ["https://example.com/two"],
      source: { label: "Example", url: source.url.href },
    };

    const cliState = await cli.resolveSelectionState({ mode: "cli" }, source, entries, manifest);
    expect(cliState.entries).toHaveLength(1);
    expect(cliState.label).toContain("previous selection");

    vi.mocked(prompts.select).mockResolvedValueOnce(cli.SELECTION_MANUAL);
    vi.mocked(prompts.checkbox).mockResolvedValueOnce(["https://example.com/one"]);
    const tuiState = await cli.resolveSelectionState({ mode: "tui" }, source, entries, manifest);
    expect(tuiState.entries).toHaveLength(1);
    expect(tuiState.label).toContain("manual selection");

    vi.mocked(prompts.select).mockResolvedValueOnce(cli.SELECTION_PREVIOUS);
    const previousState = await cli.resolveSelectionState({ mode: "tui" }, source, entries, manifest);
    expect(previousState.entries).toHaveLength(1);
    expect(previousState.label).toContain("previous selection");

    vi.mocked(prompts.select).mockResolvedValueOnce(cli.SELECTION_ALL);
    const allState = await cli.resolveSelectionState({ mode: "tui" }, source, entries, manifest);
    expect(allState.entries).toHaveLength(2);

    vi.mocked(prompts.select)
      .mockResolvedValueOnce(cli.SELECTION_MANUAL)
      .mockResolvedValueOnce(cli.SELECTION_ALL);
    vi.mocked(prompts.checkbox).mockResolvedValueOnce([cli.MANUAL_SELECTION_BACK]);
    const backToMenuState = await cli.resolveSelectionState({ mode: "tui" }, source, entries, manifest);
    expect(backToMenuState.entries).toHaveLength(2);

    vi.mocked(prompts.select).mockResolvedValueOnce(cli.SELECTION_CANCEL);
    const cancelState = await cli.resolveSelectionState({ mode: "tui" }, source, entries, manifest);
    expect(cancelState.cancelled).toBe(true);

    expect(cli.filterEntriesByUrls(entries, ["https://example.com/two"])).toEqual([entries[1]]);
    expect(cli.filterEntriesByUrls(entries, [])).toEqual(entries);
    expect(cli.formatEntryDescription(entries[0])).toContain("one");
    expect(cli.formatEntryDescription({ url: new URL("https://example.com") })).toContain("/");
    expect(cli.formatEntryDescription({ url: { protocol: "https:", pathname: "" } })).toContain("/");
    expect(cli.formatEntryDescription({ url: pathToFileURL("/tmp/local/file.md") })).toContain("/tmp/local/file.md");
  });
});

describe("resource loading and conversion", () => {
  it("reads local text resources and handles missing files", async () => {
    const tempDir = await createTempDir();
    const markdownPath = path.join(tempDir, "guide.md");
    await writeFile(markdownPath, "# Guide\n");

    const success = await cli.readLocalText(pathToFileURL(markdownPath));
    const failure = await cli.readLocalText(pathToFileURL(path.join(tempDir, "missing.md")));
    const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce("string failure");
    const stringFailure = await cli.readLocalText(pathToFileURL(markdownPath));

    expect(success.ok).toBe(true);
    expect(success.contentType).toBe("text/markdown");
    expect(failure.ok).toBe(false);
    expect(stringFailure.reason).toBe("string failure");
    readSpy.mockRestore();
  });

  it("reads remote text resources and handles HTTP failure and fetch errors", async () => {
    fetchModule.default.mockResolvedValueOnce(
      mockFetchResponse({ body: "# Guide", contentType: "text/markdown" }),
    );
    fetchModule.default.mockResolvedValueOnce(
      mockFetchResponse({ body: "plain", contentType: "" }),
    );
    fetchModule.default.mockResolvedValueOnce(
      mockFetchResponse({ ok: false, status: 404, statusText: "Not Found" }),
    );
    fetchModule.default.mockRejectedValueOnce(new Error("boom"));
    fetchModule.default.mockRejectedValueOnce("string failure");

    const ok = await cli.readRemoteText(new URL("https://example.com/guide.md"));
    const emptyType = await cli.readRemoteText(new URL("https://example.com/plain.txt"));
    const notFound = await cli.readRemoteText(new URL("https://example.com/404.md"));
    const failed = await cli.readRemoteText(new URL("https://example.com/error.md"));
    const stringFailed = await cli.readRemoteText(new URL("https://example.com/error-2.md"));

    expect(ok.ok).toBe(true);
    expect(emptyType.contentType).toBe("");
    expect(notFound.reason).toContain("HTTP 404");
    expect(failed.reason).toBe("boom");
    expect(stringFailed.reason).toBe("string failure");
  });

  it("dispatches text reads by protocol", async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, "doc.txt");
    await writeFile(filePath, "Plain text");

    fetchModule.default.mockResolvedValueOnce(mockFetchResponse({ body: "remote" }));

    expect((await cli.readTextResource(pathToFileURL(filePath))).ok).toBe(true);
    expect((await cli.readTextResource(new URL("https://example.com/doc"))).ok).toBe(true);
    expect((await cli.readTextResource(new URL("ftp://example.com/doc"))).reason).toContain("unsupported protocol");
  });

  it("fetches with fallbacks and reports complete failure", async () => {
    const tempDir = await createTempDir();
    await writeFile(path.join(tempDir, "guide.md"), "# Guide\n");

    const success = await cli.fetchWithFallbacks(pathToFileURL(path.join(tempDir, "guide")));
    const failure = await cli.fetchWithFallbacks(pathToFileURL(path.join(tempDir, "missing")));

    expect(success.ok).toBe(true);
    expect(success.url.pathname.endsWith("guide.md")).toBe(true);
    expect(failure.ok).toBe(false);
    expect(failure.reason).toContain("missing");
  });

  it("guesses content types", () => {
    expect(cli.guessLocalContentType(new URL("file:///tmp/doc.html"))).toBe("text/html");
    expect(cli.guessLocalContentType(new URL("file:///tmp/doc.mdx"))).toBe("text/markdown");
    expect(cli.guessLocalContentType(new URL("file:///tmp/doc.bin"))).toBe("text/plain");
  });

  it("detects html and markdown content and converts correctly", () => {
    const htmlUrl = new URL("https://example.com/page");
    const markdownUrl = new URL("https://example.com/page.md");
    const binaryUrl = new URL("https://example.com/file.bin");
    const htmlPathUrl = new URL("https://example.com/file.html");

    expect(cli.isHtml("<html><body>Hi</body></html>", "text/html", htmlUrl)).toBe(true);
    expect(cli.isHtml("<main>Hi</main>", "application/octet-stream", htmlUrl)).toBe(true);
    expect(cli.isHtml("plain", "application/octet-stream", htmlPathUrl)).toBe(true);
    expect(cli.isMarkdown("# Title", "text/plain", markdownUrl)).toBe(true);
    expect(cli.isMarkdown("hello", "application/octet-stream", new URL("https://example.com/file.mdx"))).toBe(true);
    expect(cli.isMarkdown("- item", "application/octet-stream", new URL("https://example.com/notes"))).toBe(true);
    expect(cli.isMarkdown("PK\u0003\u0004", "application/octet-stream", binaryUrl)).toBe(false);
    expect(cli.toMarkdown("", "text/plain", markdownUrl)).toBe("");
    expect(cli.toMarkdown("# Title\n", "text/plain", markdownUrl)).toBe("# Title");
    expect(cli.toMarkdown("<h1>Hello</h1>", "text/html", htmlUrl)).toBe("# Hello");
    expect(cli.toMarkdown("PK\u0003\u0004", "application/octet-stream", binaryUrl)).toBeNull();
  });
});

describe("interactive flow", () => {
  it("returns null when no TTY is available", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cli.resolveInteractiveRunOptions([]);

    expect(result).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("returns null when only one TTY stream is available", async () => {
    setTTY(true, false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await cli.resolveInteractiveRunOptions([]);

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("handles a curated source flow", async () => {
    setTTY(true, true);
    vi.mocked(prompts.select)
      .mockResolvedValueOnce("stripe")
      .mockResolvedValueOnce(cli.CURRENT_DIRECTORY);
    vi.mocked(prompts.confirm)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/current");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await cli.resolveInteractiveRunOptions([
      { label: "Stripe Docs", slug: "stripe", url: "https://docs.stripe.com/llms.txt" },
    ]);

    expect(result).toEqual({
      dryRun: false,
      flat: false,
      input: "stripe",
      mode: "tui",
      outputDir: "/tmp/current",
    });

    cwdSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("handles custom source flow and cancellation", async () => {
    setTTY(true, true);
    vi.mocked(prompts.select)
      .mockResolvedValueOnce(cli.CUSTOM_SOURCE)
      .mockResolvedValueOnce(cli.CUSTOM_DIRECTORY);
    vi.mocked(prompts.input)
      .mockResolvedValueOnce("https://example.com/llms.txt")
      .mockResolvedValueOnce("./custom-docs");
    vi.mocked(prompts.confirm)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await cli.resolveInteractiveRunOptions([]);

    expect(result).toBeNull();
    expect(prompts.input.mock.calls[0][0].validate("   ")).toBe("Enter a URL, slug, or local path.");
    expect(prompts.input.mock.calls[0][0].validate("https://example.com/llms.txt")).toBe(true);
    expect(prompts.input.mock.calls[1][0].validate("   ")).toBe("Enter a directory path.");
    expect(prompts.input.mock.calls[1][0].validate("./docs")).toBe(true);
    expect(logSpy).toHaveBeenCalled();
  });

  it("chooses docs manually and supports review actions", async () => {
    const entries = [
      { title: "One", url: new URL("https://example.com/one") },
      { title: "Two", url: new URL("https://example.com/two") },
    ];

    vi.mocked(prompts.checkbox).mockResolvedValueOnce(["https://example.com/two"]);
    expect(await cli.chooseEntriesManually(entries)).toEqual([entries[1]]);
    expect(prompts.checkbox.mock.calls[0][0].choices[0].value).toBe(cli.MANUAL_SELECTION_BACK);
    expect(prompts.checkbox.mock.calls[0][0].validate([])).toBe("Select at least one doc.");
    expect(prompts.checkbox.mock.calls[0][0].validate([cli.MANUAL_SELECTION_BACK])).toBe(true);
    expect(prompts.checkbox.mock.calls[0][0].validate(["x"])).toBe(true);

    vi.mocked(prompts.checkbox).mockResolvedValueOnce([cli.MANUAL_SELECTION_BACK]);
    expect(await cli.chooseEntriesManually(entries)).toBeNull();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(prompts.select)
      .mockResolvedValueOnce(cli.UPDATE_ACTION_CHANGED)
      .mockResolvedValueOnce(cli.UPDATE_ACTION_ADDED)
      .mockResolvedValueOnce(cli.UPDATE_ACTION_REMOVED)
      .mockResolvedValueOnce(cli.UPDATE_ACTION_APPLY);

    expect(
      await cli.reviewInstallPlan({
        added: ["added.md"],
        changed: ["changed.md"],
        removed: ["removed.md"],
        totalChanges: 3,
      }),
    ).toBe(true);
    expect(logSpy).toHaveBeenCalled();

    vi.mocked(prompts.select).mockResolvedValueOnce(cli.UPDATE_ACTION_CANCEL);
    expect(
      await cli.reviewInstallPlan({ added: [], changed: [], removed: [], totalChanges: 0 }),
    ).toBe(false);
  });
});

describe("import execution", () => {
  it("imports local docs successfully and reports failures when present", async () => {
    const tempDir = await createTempDir();
    const inputPath = path.join(tempDir, "llms.txt");
    const outputDir = path.join(tempDir, "docs");

    await writeFile(
      inputPath,
      [
        "[Guide](./pages/guide)",
        "[Missing](./pages/missing)",
        "[Binary](https://example.com/file.bin)",
      ].join("\n"),
    );
    await writeFile(path.join(tempDir, "pages", "guide.md"), "# Guide\n");

    fetchModule.default.mockResolvedValueOnce(
      mockFetchResponse({ contentType: "application/octet-stream", body: "PK\u0003\u0004" }),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await cli.runImport(
      { dryRun: false, flat: false, input: inputPath, mode: "cli", outputDir },
      [],
    );

    expect(result).toEqual({ failureCount: 2, successCount: 1 });
    expect(await fs.readFile(path.join(outputDir, "pages", "guide.md"), "utf8")).toContain("# Guide");
    expect(await cli.loadInstallManifest(outputDir)).not.toBeNull();
    expect(logSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("imports successfully in tui mode without printing the cli banner path", async () => {
    const tempDir = await createTempDir();
    const inputPath = path.join(tempDir, "llms.txt");
    const outputDir = path.join(tempDir, "docs");

    await writeFile(inputPath, "[Guide](./pages/guide)\n");
    await writeFile(path.join(tempDir, "pages", "guide.md"), "# Guide\n");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await cli.runImport(
      { dryRun: false, flat: false, input: inputPath, mode: "tui", outputDir },
      [],
    );

    expect(result).toEqual({ failureCount: 0, successCount: 1 });
    expect(logSpy).toHaveBeenCalled();
  });

  it("returns cancelled when managed install inspection cancels the run", async () => {
    const tempDir = await createTempDir();
    const inputPath = path.join(tempDir, "llms.txt");
    const outputDir = path.join(tempDir, "docs");
    await writeFile(inputPath, "[Guide](./pages/guide)\n");
    await writeFile(path.join(tempDir, "pages", "guide.md"), "# Guide\n");
    await cli.writeInstallManifest(outputDir, {
      generatedAt: new Date().toISOString(),
      layout: "nested",
      managedFiles: ["pages/guide.md"],
      selectedUrls: [],
      source: { label: "Other", url: "https://other.example.com/llms.txt" },
      version: 1,
    });

    const result = await cli.runImport(
      { dryRun: false, flat: false, input: inputPath, mode: "tui", outputDir },
      [],
    );

    expect(result).toEqual({ cancelled: true, failureCount: 0, successCount: 0 });
  });

  it("supports tui update review cancel and already-up-to-date flow", async () => {
    const tempDir = await createTempDir();
    const inputPath = path.join(tempDir, "llms.txt");
    const outputDir = path.join(tempDir, "docs");
    await writeFile(inputPath, "[Guide](./pages/guide)\n");
    await writeFile(path.join(tempDir, "pages", "guide.md"), "# Guide\n");
    await cli.writeInstallManifest(outputDir, {
      generatedAt: new Date().toISOString(),
      layout: "nested",
      managedFiles: ["pages/guide.md"],
      selectedUrls: [pathToFileURL(path.join(tempDir, "pages", "guide")).href],
      source: { label: inputPath, url: pathToFileURL(inputPath).href },
      version: 1,
    });
    await writeFile(path.join(outputDir, "pages", "guide.md"), "# Old Guide\n");

    vi.mocked(prompts.select)
      .mockResolvedValueOnce(cli.SELECTION_PREVIOUS)
      .mockResolvedValueOnce(cli.UPDATE_ACTION_CANCEL);
    const cancelResult = await cli.runImport(
      { dryRun: false, flat: false, input: inputPath, mode: "tui", outputDir },
      [],
    );
    expect(cancelResult).toEqual({ cancelled: true, failureCount: 0, successCount: 1 });

    await writeFile(path.join(outputDir, "pages", "guide.md"), "# Guide\n");
    vi.mocked(prompts.select).mockResolvedValueOnce(cli.SELECTION_PREVIOUS);
    const sameResult = await cli.runImport(
      { dryRun: false, flat: false, input: inputPath, mode: "tui", outputDir },
      [],
    );
    expect(sameResult).toEqual({ failureCount: 0, successCount: 1 });
  });

  it("throws when the llms source cannot be loaded", async () => {
    await expect(
      cli.runImport({ dryRun: false, flat: false, input: "/missing/llms.txt", mode: "cli", outputDir: "/tmp/out" }, []),
    ).rejects.toThrow("Failed to load llms.txt");
  });

  it("returns zero successes when no links are found", async () => {
    const tempDir = await createTempDir();
    const inputPath = path.join(tempDir, "llms.txt");
    await writeFile(inputPath, "plain text only\n");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cli.runImport(
      { dryRun: false, flat: true, input: inputPath, mode: "cli", outputDir: path.join(tempDir, "docs") },
      [],
    );

    expect(result).toEqual({ failureCount: 0, successCount: 0 });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("summarizes when more than five failures occur", async () => {
    const tempDir = await createTempDir();
    const inputPath = path.join(tempDir, "llms.txt");
    const outputDir = path.join(tempDir, "docs");

    await writeFile(
      inputPath,
      Array.from({ length: 6 }, (_, index) => `[Missing ${index}](./missing-${index})`).join("\n"),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await cli.runImport(
      { dryRun: false, flat: false, input: inputPath, mode: "cli", outputDir },
      [],
    );

    expect(result).toEqual({ failureCount: 6, successCount: 0 });
    expect(logSpy.mock.calls.flat().join(" ")).toContain("...and 1 more");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("processes a single link successfully", async () => {
    const tempDir = await createTempDir();
    const usedPaths = new Set();
    const outputDir = path.join(tempDir, "docs");
    await writeFile(path.join(tempDir, "page.md"), "# Page\n");

    const result = await cli.processLink(
      { title: "Page", url: pathToFileURL(path.join(tempDir, "page")) },
      1,
      1,
      { dryRun: false, flat: true, mode: "cli", outputDir },
      { localRootDir: tempDir },
      usedPaths,
    );

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(outputDir, "page.md"), "utf8")).toContain("# Page");
  });

  it("processes a link successfully without a fallback URL", async () => {
    const tempDir = await createTempDir();
    const usedPaths = new Set();
    const outputDir = path.join(tempDir, "docs");
    const exactPath = path.join(tempDir, "page.md");
    await writeFile(exactPath, "# Page\n");

    const result = await cli.processLink(
      { title: "Page", url: pathToFileURL(exactPath) },
      1,
      1,
      { dryRun: false, flat: true, mode: "cli", outputDir },
      { localRootDir: tempDir },
      usedPaths,
    );

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(outputDir, "page.md"), "utf8")).toContain("# Page");
  });

  it("builds and applies update plans for managed installs", async () => {
    const tempDir = await createTempDir();
    const outputDir = path.join(tempDir, "docs");
    await writeFile(path.join(outputDir, "keep.md"), "same\n");
    await writeFile(path.join(outputDir, "change.md"), "old\n");
    await writeFile(path.join(outputDir, "remove.md"), "gone\n");

    const plan = await cli.buildInstallPlan(
      outputDir,
      [
        { content: "same\n", label: "[1/2]", ok: true, path: "keep.md", url: "https://example.com/keep", via: "" },
        { content: "new\n", label: "[2/2]", ok: true, path: "change.md", url: "https://example.com/change", via: "" },
      ],
      {
        managedFiles: ["keep.md", "change.md", "remove.md"],
        source: { url: "https://example.com/llms.txt" },
      },
      { url: new URL("https://example.com/llms.txt") },
      false,
    );

    expect(plan.added).toEqual([]);
    expect(plan.changed).toEqual(["change.md"]);
    expect(plan.removed).toEqual(["remove.md"]);
    expect(plan.unchanged).toEqual(["keep.md"]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    cli.printChangeSummary(plan, true);
    cli.printPathList("Changed", plan.changed);
    cli.printPathList("Many", Array.from({ length: 30 }, (_, index) => `item-${index}`));
    expect(cli.formatVia("https://example.com/guide.md")).toContain("via");
    expect(cli.formatVia("")).toBe("");

    await cli.applyInstallPlan(outputDir, plan.docs, plan);
    expect(await fs.readFile(path.join(outputDir, "change.md"), "utf8")).toBe("new\n");
    await expect(fs.readFile(path.join(outputDir, "remove.md"), "utf8")).rejects.toThrow();
    expect(logSpy).toHaveBeenCalled();

    const manifest = cli.createInstallManifest({
      docs: plan.docs,
      manifest: { managedFiles: ["keep.md", "change.md", "remove.md"] },
      options: { flat: false },
      plan,
      selectedEntries: [{ url: new URL("https://example.com/keep") }],
      source: { label: "Example", url: new URL("https://example.com/llms.txt") },
    });

    expect(manifest.managedFiles).toEqual(["change.md", "keep.md"]);

    const partialManifest = cli.createInstallManifest({
      docs: plan.docs,
      manifest: { managedFiles: ["keep.md", "change.md", "remove.md"] },
      options: { flat: false },
      plan: { ...plan, hasFailures: true },
      selectedEntries: [{ url: new URL("https://example.com/keep") }],
      source: { label: "Example", url: new URL("https://example.com/llms.txt") },
    });

    expect(partialManifest.managedFiles).toContain("remove.md");
    expect(partialManifest.layout).toBe("nested");

    const flatManifest = cli.createInstallManifest({
      docs: plan.docs,
      manifest: null,
      options: { flat: true },
      plan,
      selectedEntries: [{ url: new URL("https://example.com/keep") }],
      source: { label: "Example", url: new URL("https://example.com/llms.txt") },
    });

    expect(flatManifest.layout).toBe("flat");
  });

  it("supports dry-run updates and previous selection reuse", async () => {
    const tempDir = await createTempDir();
    const inputPath = path.join(tempDir, "llms.txt");
    const outputDir = path.join(tempDir, "docs");

    await writeFile(inputPath, "[Guide](./pages/guide)\n[Other](./pages/other)\n");
    await writeFile(path.join(tempDir, "pages", "guide.md"), "# Guide\n");
    await writeFile(path.join(tempDir, "pages", "other.md"), "# Other\n");
    await cli.writeInstallManifest(outputDir, {
      generatedAt: new Date().toISOString(),
      layout: "nested",
      managedFiles: ["pages/guide.md"],
      selectedUrls: [pathToFileURL(path.join(tempDir, "pages", "guide")).href],
      source: { label: inputPath, url: pathToFileURL(inputPath).href },
      version: 1,
    });
    await writeFile(path.join(outputDir, "pages", "guide.md"), "# Guide\n");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await cli.runImport(
      { dryRun: true, flat: false, input: inputPath, mode: "cli", outputDir },
      [],
    );

    expect(result).toEqual({ failureCount: 0, successCount: 1 });
    expect(logSpy.mock.calls.flat().join(" ")).toContain("Dry run complete");
  });

  it("resolves entry fetch failures and processLink passthrough failures", async () => {
    const tempDir = await createTempDir();
    const entry = { title: "Missing", url: pathToFileURL(path.join(tempDir, "missing")) };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resolved = await cli.resolveEntryFetch(entry, 1, 1, { flat: false }, { localRootDir: tempDir }, new Set());
    expect(resolved.ok).toBe(false);

    const processed = await cli.processLink(entry, 1, 1, { flat: false, outputDir: tempDir }, { localRootDir: tempDir }, new Set());
    expect(processed.ok).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("handles directory helper fallbacks", async () => {
    const tempDir = await createTempDir();
    expect(await cli.directoryHasManagedCandidates(path.join(tempDir, "missing-dir"))).toBe(false);

    const outputDir = path.join(tempDir, "docs");
    await writeFile(path.join(outputDir, "nested", "page.md"), "# Page\n");
    await cli.pruneEmptyDirectories(outputDir, path.join(outputDir, "nested"));
    expect(await fs.readFile(path.join(outputDir, "nested", "page.md"), "utf8")).toContain("# Page");

    await fs.rm(path.join(outputDir, "nested", "page.md"), { force: true });
    await cli.pruneEmptyDirectories(outputDir, path.join(outputDir, "nested"));
    await expect(fs.readdir(path.join(outputDir, "nested"))).rejects.toThrow();

    const readdirSpy = vi.spyOn(fs, "readdir").mockRejectedValueOnce(new Error("boom"));
    await cli.pruneEmptyDirectories(outputDir, path.join(outputDir, "missing"));
    readdirSpy.mockRestore();
  });
});

describe("main and error handling", () => {
  it("handles help and list source paths", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    process.argv = ["node", "cli", "--help"];
    await cli.main();

    process.argv = ["node", "cli", "--list-sources"];
    await cli.main();

    expect(logSpy).toHaveBeenCalled();
  });

  it("returns early from main when interactive mode is unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = ["node", "cli"];

    await cli.main();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("handles non-interactive main flow and marks exit code on zero success", async () => {
    const tempDir = await createTempDir();
    const inputPath = path.join(tempDir, "llms.txt");
    await writeFile(inputPath, "no links here\n");

    process.argv = ["node", "cli", inputPath];
    await cli.main();

    expect(process.exitCode).toBe(1);
  });

  it("handles main errors explicitly", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cli.handleMainError(new Error("boom"));
    cli.handleMainError("oops");

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
  });
});
