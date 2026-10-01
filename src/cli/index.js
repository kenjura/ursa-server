/**
 * `ursa-server` CLI. `start` runs the daemon; every other command is a thin
 * client for the control API (docs/CONTROL.md).
 */

const COMMANDS = ["start", "status", "rebuild", "invalidate", "sync", "pause", "resume", "logs"];

/** @param {string[]} argv */
export async function main(argv) {
  const [command] = argv;
  if (!COMMANDS.includes(command)) {
    console.log(`usage: ursa-server <${COMMANDS.join("|")}> [options]`);
    return;
  }
  throw new Error(`ursa-server ${command}: not implemented (see docs/ROADMAP.md)`);
}
