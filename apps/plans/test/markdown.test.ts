import { describe, expect, test } from "bun:test";
import { blockHash, diffPlan, renderPlan } from "../src/markdown";

describe("renderPlan blocks", () => {
  test("splits headings, paragraphs, code and lists into addressable blocks", () => {
    const md = [
      "# Title",
      "",
      "First paragraph with **bold** and `code`.",
      "",
      "- item one",
      "- item two",
      "  - nested under two",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    const { html, blocks } = renderPlan(md);

    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "li", "li", "code"]);
    expect(blocks[0]!.html).toContain("<h1");
    expect(blocks[1]!.html).toContain("<strong>bold</strong>");
    expect(blocks[1]!.html).toContain("<code>code</code>");
    // Top-level list items are separate blocks; the nested item is not.
    expect(blocks[3]!.html).toContain("nested under two");
    expect(blocks[3]!.html).toContain("<ul>");
    expect(html).toMatch(/<ul>\s*<li data-block-id="2-/);
    // Code fence contents intact
    expect(blocks[4]!.html).toContain("const x = 1;");
    expect(blocks[4]!.html).toContain('class="language-ts"');
    // Every block id appears in the document html
    for (const block of blocks) expect(html).toContain(`data-block-id="${block.id}"`);
  });

  test("block ids are index + content hash, stable under unrelated edits", () => {
    const a = renderPlan("para one\n\npara two");
    const b = renderPlan("new intro\n\npara one\n\npara two");
    const hashOf = (id: string) => id.split("-")[1];
    // "para one" keeps its content hash even though its index moved
    expect(hashOf(a.blocks[0]!.id)).toBe(hashOf(b.blocks[1]!.id));
    expect(a.blocks[0]!.id).toBe(`0-${blockHash("para one")}`);
  });

  test("escapes raw HTML and neutralises unsafe link schemes", () => {
    const { html } = renderPlan(
      "<script>alert(1)</script>\n\n[click](javascript:alert(1)) and [ok](https://example.com)",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('<a href="https://example.com"');
  });

  test("renders images, quotes, tables and rules", () => {
    const md = [
      "![diagram](https://files.myslop.app/x/arch.svg)",
      "",
      "> quoted wisdom",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "---",
    ].join("\n");
    const { blocks } = renderPlan(md);
    expect(blocks.map((b) => b.kind)).toEqual(["image", "quote", "table", "hr"]);
    expect(blocks[0]!.html).toContain('<img src="https://files.myslop.app/x/arch.svg"');
    expect(blocks[1]!.html).toContain("<blockquote");
    expect(blocks[2]!.html).toContain("<th>a</th>");
    expect(blocks[2]!.html).toContain("<td>2</td>");
  });

  test("excerpts strip markdown syntax", () => {
    const { blocks } = renderPlan("## The **big** [idea](https://x.dev)");
    expect(blocks[0]!.text).toBe("The big idea");
  });
});

describe("diffPlan", () => {
  const v1 = [
    "# Plan",
    "",
    "We will use Postgres for storage.",
    "",
    "- step one",
    "- step two",
  ].join("\n");
  const v2 = [
    "# Plan",
    "",
    "We will use SQLite for storage.",
    "",
    "- step one",
    "- step two",
    "- step three",
  ].join("\n");

  test("classifies same, changed and added blocks", () => {
    const parts = diffPlan(v1, v2);
    expect(parts.map((p) => p.type)).toEqual(["same", "changed", "same", "same", "added"]);
    const changed = parts[1]!;
    expect(changed.html).toContain("<del>Postgres</del>");
    expect(changed.html).toContain("<ins>SQLite</ins>");
    const added = parts[4]!;
    expect(added.html).toContain("step three");
    // li parts are wrapped so they render validly outside a list
    expect(added.html).toContain('<ul class="dli">');
  });

  test("reports removals and treats dissimilar replacements as remove+add", () => {
    const parts = diffPlan("alpha beta gamma delta", "completely unrelated words here");
    expect(parts.map((p) => p.type).sort()).toEqual(["added", "removed"]);
  });

  test("identical documents diff as all-same", () => {
    expect(diffPlan(v1, v1).every((p) => p.type === "same")).toBe(true);
  });
});
