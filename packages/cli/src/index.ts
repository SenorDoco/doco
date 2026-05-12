#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { agentCmd } from "./commands/agent.js";
import { checkCmd } from "./commands/check.js";
import { findRulesCmd } from "./commands/find-rules.js";
import { hostCmd } from "./commands/host.js";
import { initCmd } from "./commands/init.js";
import { inviteCmd } from "./commands/invite.js";
import { lintCmd } from "./commands/lint.js";
import { queryCmd } from "./commands/query.js";
import { reindexCmd } from "./commands/reindex.js";
import { serveCmd } from "./commands/serve.js";
import { showCmd } from "./commands/show.js";
import { validateCmd } from "./commands/validate.js";

const main = defineCommand({
  meta: {
    name: "doco",
    version: "0.0.1",
    description: "Doco CLI — alignment framework and runtime checking system.",
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
    invite: inviteCmd,
    agent: agentCmd,
  },
});

await runMain(main);
