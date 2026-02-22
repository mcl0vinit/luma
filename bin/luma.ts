#!/usr/bin/env bun
import { runCli } from "../src/cli";

try {
  await runCli(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
