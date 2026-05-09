#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { initCmd } from "./commands/init.js";
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
  },
});

await runMain(main);
