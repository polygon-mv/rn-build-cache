#!/usr/bin/env node
import { main } from "../dist/cli.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`[rn-build-cache] failed: ${error?.stack ?? error}\n`);
    process.exit(1);
  },
);
