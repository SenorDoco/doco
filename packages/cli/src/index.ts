#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { installAgentBootstrapCmd } from "./commands/install-agent-bootstrap.js";
import { loginCmd } from "./commands/login.js";

const main = defineCommand({
  meta: {
    name: "doco",
    version: "0.1.1",
    description: "Doco CLI — connect a repo to its Doco and install the agent bootstrap.",
  },
  subCommands: {
    login: loginCmd,
    "install-agent-bootstrap": installAgentBootstrapCmd,
  },
});

await runMain(main);
