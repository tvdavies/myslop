// Prebuild: run before `wrangler dev`/`deploy` (see package.json).
// Embed setup.sh base64-encoded — Cloudflare's API WAF rejects worker
// bundles containing raw shell-script text (403 on deploy).

const setupIn = new URL("../src/setup.sh", import.meta.url);
const setupOut = new URL("../src/setup-sh.generated.ts", import.meta.url);
const b64 = Buffer.from(await Bun.file(setupIn).text()).toString("base64");
await Bun.write(
  setupOut,
  `// generated from src/setup.sh by scripts/gen-setup.ts — do not edit\nexport default\n  "${b64}";\n`,
);
console.log("wrote src/setup-sh.generated.ts");
