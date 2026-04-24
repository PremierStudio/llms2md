import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const review = await import("../lib/registry-review.js");

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;
const originalFetch = globalThis.fetch;

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "llms2md-review-test-"));
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function mockHeaders(values) {
  return {
    get(name) {
      return values[name.toLowerCase()] ?? null;
    },
  };
}

beforeEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = undefined;
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = undefined;
  globalThis.fetch = originalFetch;
});

describe("argument parsing and registry helpers", () => {
  it("parses review CLI arguments", () => {
    expect(
      review.parseArgs(["--registry", "sources.txt", "--json-out", "out.json", "--markdown-out", "out.md"]),
    ).toEqual({
      jsonOut: "out.json",
      markdownOut: "out.md",
      registry: "sources.txt",
    });
  });

  it("loads registry entries and finds duplicates", async () => {
    const tempDir = await createTempDir();
    const registryPath = path.join(tempDir, "sources.txt");
    await writeFile(
      registryPath,
      [
        "# comment",
        "a|A|https://a.test/llms.txt",
        "a|A 2|https://b.test/llms.txt",
        "b|B|https://a.test/llms.txt",
      ].join("\n"),
    );

    const entries = await review.loadRegistry(registryPath);
    const duplicates = review.findDuplicates(entries);

    expect(entries).toHaveLength(3);
    expect(duplicates.duplicateSlugs.has("a")).toBe(true);
    expect(duplicates.duplicateUrls.has("https://a.test/llms.txt")).toBe(true);
  });

  it("keeps incomplete registry rows as empty values", async () => {
    const tempDir = await createTempDir();
    const registryPath = path.join(tempDir, "sources.txt");
    await writeFile(registryPath, ["a||", "|Label|https://example.com/llms.txt"].join("\n"));

    const entries = await review.loadRegistry(registryPath);
    expect(entries).toEqual([
      { label: "", slug: "a", url: "" },
      { label: "Label", slug: "", url: "https://example.com/llms.txt" },
    ]);
  });

  it("detects private hostnames and text-like content", () => {
    expect(review.isPrivateHostname("localhost")).toBe(true);
    expect(review.isPrivateHostname("192.168.1.1")).toBe(true);
    expect(review.isPrivateHostname("169.254.1.10")).toBe(true);
    expect(review.isPrivateHostname("172.16.0.10")).toBe(true);
    expect(review.isPrivateHostname("fe80::1")).toBe(true);
    expect(review.isPrivateHostname("example.com")).toBe(false);
    expect(review.isTextLike("text/plain")).toBe(true);
    expect(review.isTextLike("application/markdown+json")).toBe(true);
    expect(review.isTextLike("application/octet-stream")).toBe(false);
  });

  it("counts verdicts and renders markdown reports", () => {
    const counts = review.countVerdicts([
      { verdict: "safe" },
      { verdict: "safe" },
      { verdict: "unsafe" },
      { verdict: "needs-review" },
    ]);

    const report = review.renderMarkdownReport({
      counts,
      results: [
        {
          finalUrl: "https://b.test/llms.txt",
          issues: [],
          notes: ["Fetched 10 bytes."],
          slug: "a",
          statusCode: 200,
          url: "https://a.test/llms.txt",
          verdict: "safe",
          warnings: ["Contains | pipe"],
        },
      ],
    });

    expect(counts).toEqual({ "needs-review": 1, safe: 2, unsafe: 1 });
    expect(report).toContain(review.REPORT_MARKER);
    expect(report).toContain("Final URL for a");
    expect(review.escapeTable("a|b\nc")).toBe("a\\|b c");
    expect(
      review.renderMarkdownReport({
        counts: { "needs-review": 0, safe: 1, unsafe: 0 },
        results: [{ finalUrl: "", issues: [], notes: [], slug: "b", statusCode: 0, url: "u", verdict: "safe", warnings: [] }],
      }),
    ).toContain("Looks good.");
  });
});

describe("entry inspection", () => {
  it("marks malformed entries as unsafe without fetching", async () => {
    const result = await review.inspectEntry(
      { label: "", slug: "", url: "" },
      { duplicateSlugs: new Set(), duplicateUrls: new Set() },
    );

    expect(result.verdict).toBe("unsafe");
    expect(result.issues).toContain("Registry line must contain slug, label, and URL.");
  });

  it("marks insecure or private URLs as unsafe", async () => {
    const result = await review.inspectEntry(
      { label: "Local", slug: "local", url: "http://localhost/llms.txt" },
      { duplicateSlugs: new Set(), duplicateUrls: new Set() },
    );

    expect(result.verdict).toBe("unsafe");
    expect(result.issues).toContain("Registry URLs must use HTTPS.");
    expect(result.issues).toContain("Registry URLs must point to a public hostname.");
  });

  it("marks credentialed URLs as unsafe", async () => {
    const result = await review.inspectEntry(
      { label: "Private", slug: "private", url: "https://user:pass@example.com/llms.txt" },
      { duplicateSlugs: new Set(), duplicateUrls: new Set() },
    );

    expect(result.verdict).toBe("unsafe");
    expect(result.issues).toContain("Registry URLs must not include credentials.");
  });

  it("flags duplicate entries and content warnings", async () => {
    globalThis.fetch.mockResolvedValue({
      headers: mockHeaders({ "content-length": `${1024 * 1024 + 5}`, "content-type": "text/html" }),
      ok: true,
      redirect: "follow",
      status: 200,
      text: vi.fn().mockResolvedValue("<html><body>No links</body></html>"),
      url: "https://cdn.example.com/llms.txt",
    });

    const result = await review.inspectEntry(
      { label: "Example", slug: "dup", url: "https://example.com/other" },
      {
        duplicateSlugs: new Set(["dup"]),
        duplicateUrls: new Set(["https://example.com/other"]),
      },
    );

    expect(result.verdict).toBe("unsafe");
    expect(result.issues).toContain("Duplicate slug.");
    expect(result.warnings).toContain("Duplicate URL already exists in the registry.");
    expect(result.warnings).toContain("URL does not end with llms.txt.");
  });

  it("marks successful fetches as safe", async () => {
    globalThis.fetch.mockResolvedValue({
      headers: mockHeaders({ "content-length": "42", "content-type": "text/plain" }),
      ok: true,
      redirect: "follow",
      status: 200,
      text: vi.fn().mockResolvedValue("[Guide](https://example.com/guide)"),
      url: "https://example.com/llms.txt",
    });

    const result = await review.inspectEntry(
      { label: "Example", slug: "example", url: "https://example.com/llms.txt" },
      { duplicateSlugs: new Set(), duplicateUrls: new Set() },
    );

    expect(result.verdict).toBe("safe");
    expect(result.notes[0]).toContain("42 bytes");
  });

  it("marks redirects, html, and missing links as needing review", async () => {
    globalThis.fetch.mockResolvedValue({
      headers: mockHeaders({ "content-length": `${1024 * 1024 + 1}`, "content-type": "text/plain" }),
      ok: true,
      redirect: "follow",
      status: 200,
      text: vi.fn().mockResolvedValue("<html><body>No links</body></html>"),
      url: "https://other.example.com/llms.txt",
    });

    const result = await review.inspectEntry(
      { label: "Example", slug: "example", url: "https://example.com/llms.txt" },
      { duplicateSlugs: new Set(), duplicateUrls: new Set() },
    );

    expect(result.verdict).toBe("needs-review");
    expect(result.warnings).toContain("Request redirected to a different hostname.");
    expect(result.warnings).toContain("Response is larger than 1 MB.");
    expect(result.warnings).toContain("Endpoint returned HTML instead of plain text/markdown.");
    expect(result.warnings).toContain("Response did not contain any markdown links.");
  });

  it("marks unexpected content types and fetch failures as unsafe", async () => {
    globalThis.fetch
      .mockResolvedValueOnce({
        headers: mockHeaders({ "content-type": "application/octet-stream" }),
        ok: true,
        redirect: "follow",
        status: 200,
        text: vi.fn().mockResolvedValue("[Guide](https://example.com/guide)"),
        url: "https://example.com/llms.txt",
      })
      .mockResolvedValueOnce({
        headers: mockHeaders({}),
        ok: false,
        redirect: "follow",
        status: 503,
        text: vi.fn(),
        url: "https://example.com/llms.txt",
      })
      .mockRejectedValueOnce(new Error("network down"));

    const unexpectedType = await review.inspectEntry(
      { label: "Example", slug: "one", url: "https://example.com/llms.txt" },
      { duplicateSlugs: new Set(), duplicateUrls: new Set() },
    );
    const httpFailure = await review.inspectEntry(
      { label: "Example", slug: "two", url: "https://example.com/llms.txt" },
      { duplicateSlugs: new Set(), duplicateUrls: new Set() },
    );
    const networkFailure = await review.inspectEntry(
      { label: "Example", slug: "three", url: "https://example.com/llms.txt" },
      { duplicateSlugs: new Set(), duplicateUrls: new Set() },
    );

    expect(unexpectedType.issues[0]).toContain("Unexpected content type");
    expect(httpFailure.issues[0]).toContain("Fetch failed with HTTP 503");
    expect(networkFailure.issues[0]).toBe("network down");

    globalThis.fetch.mockRejectedValueOnce("string failure");
    const stringFailure = await review.inspectEntry(
      { label: "Example", slug: "four", url: "https://example.com/llms.txt" },
      { duplicateSlugs: new Set(), duplicateUrls: new Set() },
    );

    expect(stringFailure.issues[0]).toBe("string failure");

    globalThis.fetch.mockResolvedValueOnce({
      headers: mockHeaders({}),
      ok: true,
      redirect: "follow",
      status: 200,
      text: vi.fn().mockResolvedValue("[Guide](https://example.com/guide)"),
      url: "https://example.com/llms.txt",
    });
    const unknownType = await review.inspectEntry(
      { label: "Example", slug: "five", url: "https://example.com/llms.txt" },
      { duplicateSlugs: new Set(), duplicateUrls: new Set() },
    );

    expect(unknownType.issues[0]).toContain("unknown");
  });
});

describe("main and error handling", () => {
  it("writes review outputs and leaves exit code unset when safe", async () => {
    const tempDir = await createTempDir();
    const registryPath = path.join(tempDir, "sources.txt");
    const jsonOut = path.join(tempDir, "review.json");
    const markdownOut = path.join(tempDir, "review.md");
    await writeFile(registryPath, "safe|Safe|https://example.com/llms.txt\n");

    globalThis.fetch.mockResolvedValue({
      headers: mockHeaders({ "content-length": "12", "content-type": "text/plain" }),
      ok: true,
      redirect: "follow",
      status: 200,
      text: vi.fn().mockResolvedValue("[Guide](https://example.com/guide)"),
      url: "https://example.com/llms.txt",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = [
      "node",
      "review",
      "--registry",
      registryPath,
      "--json-out",
      jsonOut,
      "--markdown-out",
      markdownOut,
    ];

    await review.main();

    expect(process.exitCode).toBeUndefined();
    expect(await fs.readFile(jsonOut, "utf8")).toContain("\"safe\": 1");
    expect(await fs.readFile(markdownOut, "utf8")).toContain("## llms2md Registry Review");
    expect(logSpy).toHaveBeenCalled();
  });

  it("uses the default registry path when none is provided", async () => {
    globalThis.fetch.mockResolvedValue({
      headers: mockHeaders({ "content-length": "12", "content-type": "text/plain" }),
      ok: true,
      redirect: "follow",
      status: 200,
      text: vi.fn().mockResolvedValue("[Guide](https://example.com/guide)"),
      url: "https://example.com/llms.txt",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "review"];

    await review.main();

    expect(logSpy).toHaveBeenCalled();
  });

  it("marks exit code when unsafe results exist", async () => {
    const tempDir = await createTempDir();
    const registryPath = path.join(tempDir, "sources.txt");
    await writeFile(registryPath, "bad|Bad|http://localhost/llms.txt\n");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "review", "--registry", registryPath];

    await review.main();

    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalled();
  });

  it("handles review main errors", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    review.handleMainError(new Error("boom"));
    review.handleMainError("oops");

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
  });
});
