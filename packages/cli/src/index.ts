#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { agentCmd } from "./commands/agent.js";
import { activityCmd, historyCmd } from "./commands/audit.js";
import { captureCmd } from "./commands/capture.js";
import { coverageCmd } from "./commands/coverage.js";
import { exportCmd } from "./commands/export.js";
import { importCmd } from "./commands/import.js";
import { hostCmd } from "./commands/host.js";
import { initCmd } from "./commands/init.js";
import { installAgentBootstrapCmd } from "./commands/install-agent-bootstrap.js";
import { installHooksCmd } from "./commands/install-hooks.js";
import { inviteCmd } from "./commands/invite.js";
import { lintCmd } from "./commands/lint.js";
import { patchCmd } from "./commands/patch.js";
import { queryCmd } from "./commands/query.js";
import { reindexCmd } from "./commands/reindex.js";
import { showCmd } from "./commands/show.js";
import { supersedeCmd } from "./commands/supersede.js";
import { validateCmd } from "./commands/validate.js";
import { watchCmd } from "./commands/watch.js";

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
    lint: lintCmd,
    host: hostCmd,
    invite: inviteCmd,
    agent: agentCmd,
    capture: captureCmd,
    patch: patchCmd,
    supersede: supersedeCmd,
    history: historyCmd,
    activity: activityCmd,
    export: exportCmd,
    import: importCmd,
    coverage: coverageCmd,
    "install-hooks": installHooksCmd,
    "install-agent-bootstrap": installAgentBootstrapCmd,
    watch: watchCmd,
  },
});

await runMain(main);
