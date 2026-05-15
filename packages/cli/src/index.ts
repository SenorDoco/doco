#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { activityCmd, historyCmd } from "./commands/audit.js";
import { captureCmd } from "./commands/capture.js";
import { exportCmd } from "./commands/export.js";
import { hostCmd } from "./commands/host.js";
import { importCmd } from "./commands/import.js";
import { initCmd } from "./commands/init.js";
import { installAgentBootstrapCmd } from "./commands/install-agent-bootstrap.js";
import { lintCmd } from "./commands/lint.js";
import { loginCmd } from "./commands/login.js";
import { patchCmd } from "./commands/patch.js";
import { queryCmd } from "./commands/query.js";
import { reindexCmd } from "./commands/reindex.js";
import { scopeCmd } from "./commands/scope.js";
import { showCmd } from "./commands/show.js";
import { supersedeCmd } from "./commands/supersede.js";
import { validateCmd } from "./commands/validate.js";

const main = defineCommand({
  meta: {
    name: "doco",
    version: "0.0.1",
    description: "Doco CLI — alignment framework and runtime checking system.",
  },
  subCommands: {
    init: initCmd,
    login: loginCmd,
    show: showCmd,
    validate: validateCmd,
    reindex: reindexCmd,
    query: queryCmd,
    lint: lintCmd,
    host: hostCmd,
    capture: captureCmd,
    patch: patchCmd,
    scope: scopeCmd,
    supersede: supersedeCmd,
    history: historyCmd,
    activity: activityCmd,
    export: exportCmd,
    import: importCmd,
    "install-agent-bootstrap": installAgentBootstrapCmd,
  },
});

await runMain(main);
