// SPDX-License-Identifier: AGPL-3.0-only
/** Copies the checked-in JSON Schema into dist/ so the published package can load it. */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const from = join(root, "schemas", "report.v1.schema.json");
const to = join(root, "dist", "report.v1.schema.json");
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`copied ${from} -> ${to}`);
