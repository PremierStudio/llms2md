import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgv = [...process.argv];

afterEach(() => {
  vi.resetModules();
  vi.unmock("../lib/cli.js");
  vi.unmock("../lib/registry-review.js");
  process.argv = [...originalArgv];
  process.exitCode = undefined;
});

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "llms2md-entry-test-"));
}

describe("index.js entrypoint", () => {
  it("detects direct execution and runs the CLI", async () => {
    const main = vi.fn().mockResolvedValue(undefined);
    const handleMainError = vi.fn();

    vi.doMock("../lib/cli.js", () => ({
      handleMainError,
      main,
    }));

    const module = await import("../index.js");

    expect(module.isDirectExecution("file:///tmp/index.js", "/tmp/index.js")).toBe(true);
    expect(module.isDirectExecution("file:///tmp/index.js", null)).toBe(false);
    expect(await module.runCli("file:///tmp/index.js", null)).toBe(false);
    expect(await module.runCli("file:///tmp/index.js", "/tmp/index.js")).toBe(true);
    expect(main).toHaveBeenCalledTimes(1);
    expect(handleMainError).not.toHaveBeenCalled();
  });

  it("treats a symlinked bin path as direct execution", async () => {
    const module = await import("../index.js");
    const tempDir = await createTempDir();
    const symlinkPath = path.join(tempDir, "llms2md-bin");
    const realPath = fileURLToPath(new URL("../index.js", import.meta.url));

    await fs.symlink(realPath, symlinkPath);

    expect(module.isDirectExecution(pathToFileURL(realPath).href, symlinkPath)).toBe(true);
  });

  it("handles CLI startup errors and skips when not direct", async () => {
    const main = vi.fn().mockRejectedValue(new Error("boom"));
    const handleMainError = vi.fn();

    vi.doMock("../lib/cli.js", () => ({
      handleMainError,
      main,
    }));

    const module = await import("../index.js");

    expect(await module.runCli("file:///tmp/index.js", "/different.js")).toBe(false);
    expect(await module.runCli("file:///tmp/index.js", "/tmp/index.js")).toBe(true);
    expect(handleMainError).toHaveBeenCalledTimes(1);
  });
});

describe("registry review entrypoint", () => {
  it("detects direct execution and runs the registry review", async () => {
    const main = vi.fn().mockResolvedValue(undefined);
    const handleMainError = vi.fn();

    vi.doMock("../lib/registry-review.js", () => ({
      handleMainError,
      main,
    }));

    const module = await import("../scripts/check-registry-safety.mjs");

    expect(module.isDirectExecution("file:///tmp/review.mjs", "/tmp/review.mjs")).toBe(true);
    expect(module.isDirectExecution("file:///tmp/review.mjs", null)).toBe(false);
    expect(await module.runRegistryReview("file:///tmp/review.mjs", null)).toBe(false);
    expect(await module.runRegistryReview("file:///tmp/review.mjs", "/tmp/review.mjs")).toBe(true);
    expect(main).toHaveBeenCalledTimes(1);
    expect(handleMainError).not.toHaveBeenCalled();
  });

  it("treats a symlinked registry bin path as direct execution", async () => {
    const module = await import("../scripts/check-registry-safety.mjs");
    const tempDir = await createTempDir();
    const symlinkPath = path.join(tempDir, "registry-bin");
    const realPath = fileURLToPath(new URL("../scripts/check-registry-safety.mjs", import.meta.url));

    await fs.symlink(realPath, symlinkPath);

    expect(module.isDirectExecution(pathToFileURL(realPath).href, symlinkPath)).toBe(true);
  });

  it("handles registry review startup errors and skips when not direct", async () => {
    const main = vi.fn().mockRejectedValue(new Error("boom"));
    const handleMainError = vi.fn();

    vi.doMock("../lib/registry-review.js", () => ({
      handleMainError,
      main,
    }));

    const module = await import("../scripts/check-registry-safety.mjs");

    expect(await module.runRegistryReview("file:///tmp/review.mjs", "/different.mjs")).toBe(false);
    expect(await module.runRegistryReview("file:///tmp/review.mjs", "/tmp/review.mjs")).toBe(true);
    expect(handleMainError).toHaveBeenCalledTimes(1);
  });
});
