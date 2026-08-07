// Prebuild: run before `wrangler dev`/`deploy` (see package.json).
//  1. Embed setup.sh base64-encoded — Cloudflare's API WAF rejects worker
//     bundles containing raw shell-script text (403 on deploy).
//  2. Mirror src/skill.md into the distributable plugin so the served skill
//     and the Claude Code plugin never drift. A real copy (not a symlink) so
//     the plugin survives cloning on every platform.

const setupIn = new URL("../src/setup.sh", import.meta.url);
const setupOut = new URL("../src/setup-sh.generated.ts", import.meta.url);
const b64 = Buffer.from(await Bun.file(setupIn).text()).toString("base64");
await Bun.write(
  setupOut,
  `// generated from src/setup.sh by scripts/gen-setup.ts — do not edit\nexport default\n  "${b64}";\n`,
);
console.log("wrote src/setup-sh.generated.ts");

const skillIn = new URL("../src/skill.md", import.meta.url);
const skillOut = new URL("../plugins/file-upload/skills/file-upload/SKILL.md", import.meta.url);
await Bun.write(skillOut, await Bun.file(skillIn).text());
console.log("mirrored src/skill.md -> plugins/file-upload/skills/file-upload/SKILL.md");
