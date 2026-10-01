// Point node_modules/@kenjura/ursa at a local Ursa checkout (default ../ursa,
// or $URSA_PATH) to develop both together. `pnpm install` undoes it.
import { rmSync, symlinkSync, existsSync } from "fs";
import { resolve } from "path";

const target = resolve(process.env.URSA_PATH ?? "../ursa");
if (!existsSync(resolve(target, "package.json"))) {
  console.error(`No Ursa checkout at ${target} (set URSA_PATH)`);
  process.exit(1);
}
const link = resolve("node_modules/@kenjura/ursa");
rmSync(link, { recursive: true, force: true });
symlinkSync(target, link, "dir");
console.log(`@kenjura/ursa → ${target} (run \`pnpm install\` to go back to the published version)`);
