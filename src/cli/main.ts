#!/usr/bin/env node
import { runCommand } from "./lite-command.js";

const result = await runCommand(process.argv.slice(2));
if (result.output !== "") {
  process.stdout.write(`${result.output}\n`);
}
process.exitCode = result.exitCode;
