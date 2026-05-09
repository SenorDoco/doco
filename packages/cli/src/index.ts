#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { checkCmd } from "./commands/check.js";
import { findRulesCmd } from "./commands/find-rules.js";
import { hostCmd } from "./commands/host.js";
import { initCmd } from "./commands/init.js";
import { lintCmd } from "./commands/lint.js";
import { queryCmd } from "./commands/query.js";
import { reindexCmd } from "./commands/reindex.js";
import { serveCmd } from "./commands/serve.js";
import { showCmd } from "./commands/show.js";
import { validateCmd } from "./commands/validate.js";

const main = defineCommand({
  meta: {
    name: "evalo",
    version: "0.0.1",
    description: "Evalo CLI — alignment framework and runtime checking system.",
  },
  subCommands: {
    init: initCmd,
    show: showCmd,
    validate: validateCmd,
    reindex: reindexCmd,
    query: queryCmd,
    check: checkCmd,
    lint: lintCmd,
    "find-rules": findRulesCmd,
    serve: serveCmd,
    host: hostCmd,
  },
});

await runMain(main);
