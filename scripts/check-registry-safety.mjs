#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import { handleMainError, main } from "../lib/registry-review.js";

export * from "../lib/registry-review.js";

function isDirectExecution(importMetaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) {
    return false;
  }

  return importMetaUrl === pathToFileURL(argv1).href;
}

async function runRegistryReview(importMetaUrl = import.meta.url, argv1 = process.argv[1]) {
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

await runRegistryReview();

export { isDirectExecution, runRegistryReview };
