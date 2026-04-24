#!/usr/bin/env node

import { realpathSync } from "node:fs";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleMainError, main } from "./lib/cli.js";

export * from "./lib/cli.js";

function isDirectExecution(importMetaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) {
    return false;
  }

  const entryPath = fileURLToPath(importMetaUrl);

  try {
    return realpathSync(argv1) === entryPath;
  } catch {
    return path.resolve(argv1) === entryPath || importMetaUrl === pathToFileURL(argv1).href;
  }
}

async function runCli(importMetaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!isDirectExecution(importMetaUrl, argv1)) {
    return false;
  }

  try {
    await main();
  } catch (error) {
    handleMainError(error);
  }

  return true;
}

await runCli();

export { isDirectExecution, runCli };
