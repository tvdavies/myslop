// Regenerates src/setup-sh.generated.ts from src/setup.sh.
// The script is embedded base64-encoded because Cloudflare's API WAF rejects
// worker bundles containing raw shell-script text (403 on deploy).
const src = new URL("../src/setup.sh", import.meta.url);
const out = new URL("../src/setup-sh.generated.ts", import.meta.url);
const b64 = Buffer.from(await Bun.file(src).text()).toString("base64");
await Bun.write(
  out,
  `// generated from src/setup.sh by scripts/gen-setup.ts — do not edit\nexport default\n  "${b64}";\n`,
);
console.log("wrote src/setup-sh.generated.ts");
