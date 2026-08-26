// Deterministic markdown → block-addressable HTML for plan documents.
//
// Hand-rolled bounded subset (no raw HTML passthrough — everything is
// escaped): ATX headings, paragraphs, fenced code, lists (each TOP-LEVEL list
// item is its own block so reviewers can comment on it), blockquotes, GFM
// pipe tables, horizontal rules, images, links, and inline
// code/bold/italic/strikethrough.
//
// Every block gets a stable id `<index>-<hash8>` where hash8 is FNV-1a over
// the normalized source text. Comments anchor to these ids; across versions a
// comment re-attaches to any block whose hash still matches.

export type BlockKind =
  | "heading"
  | "paragraph"
  | "image"
  | "code"
  | "quote"
  | "table"
  | "hr"
  | "li";

export interface PlanBlock {
  id: string; // "<index>-<hash8>"
  kind: BlockKind;
  text: string; // plain-text excerpt for comment context
  source: string; // raw markdown source of the block
  html: string; // rendered element carrying data-block-id
}

export interface RenderedPlan {
  html: string;
  blocks: PlanBlock[];
}

const EXCERPT_MAX = 240;

// --- Escaping & hashing ---

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function hash8(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function blockHash(source: string): string {
  return hash8(normalize(source));
}

// --- Inline rendering ---

function safeUrl(url: string): string | null {
  return /^(https?:\/\/|mailto:|#|\/)/i.test(url) ? url : null;
}

export function renderInline(src: string): string {
  const codes: string[] = [];
  let out = src.replace(/(`+)([^`][\s\S]*?)\1(?!`)/g, (_m, _ticks, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  out = out.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)/g, (m, alt: string, url: string) => {
    const href = safeUrl(url);
    return href ? `<img src="${href}" alt="${alt}" loading="lazy">` : m;
  });
  out = out.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)/g, (m, label: string, url: string) => {
    const href = safeUrl(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener">${label}</a>` : m;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s([])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[\s([])_([^_\s][^_]*)_/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${escapeHtml(codes[Number(i)]!)}</code>`);
  return out;
}

export function plainText(src: string): string {
  return src
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|~~/g, "")
    .replace(/^ {0,3}#{1,6}\s+/gm, "")
    .replace(/^ {0,3}>\s?/gm, "")
    .replace(/^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/gm, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(src: string): string {
  const text = plainText(src);
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}…` : text;
}

// --- Block parsing ---

const FENCE_RE = /^ {0,3}(```+|~~~+)\s*(\S*)\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^ {0,3}\|?[ \t:|-]+\|?[ \t]*$/;

function isListLine(line: string): boolean {
  return LIST_RE.test(line) && !HR_RE.test(line);
}

function isTableSeparator(line: string): boolean {
  return TABLE_SEP_RE.test(line) && line.includes("-") && line.includes("|");
}

interface Segment {
  kind: BlockKind;
  source: string;
  render: (id: string) => string;
  pre?: string; // e.g. "<ul>" before the first item of a list
  post?: string; // e.g. "</ul>" after the last item
}

function renderQuote(lines: string[], id: string): string {
  const inner = lines.map((line) => line.replace(/^ {0,3}> ?/, ""));
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of [...inner, ""]) {
    if (line.trim()) current.push(line.trim());
    else if (current.length) {
      paragraphs.push(`<p>${renderInline(current.join(" "))}</p>`);
      current = [];
    }
  }
  return `<blockquote data-block-id="${id}">${paragraphs.join("")}</blockquote>`;
}

function tableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function renderTable(lines: string[], id: string): string {
  const header = tableCells(lines[0]!);
  const aligns = tableCells(lines[1]!).map((sep) => {
    const left = sep.startsWith(":");
    const right = sep.endsWith(":");
    if (left && right) return ' style="text-align:center"';
    if (right) return ' style="text-align:right"';
    return "";
  });
  const head = header.map((cell, i) => `<th${aligns[i] ?? ""}>${renderInline(cell)}</th>`).join("");
  const rows = lines.slice(2).map((line) => {
    const cells = tableCells(line).map((cell, i) => `<td${aligns[i] ?? ""}>${renderInline(cell)}</td>`);
    return `<tr>${cells.join("")}</tr>`;
  });
  return `<table data-block-id="${id}"><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function renderListItemLines(itemLines: string[]): string {
  const match = LIST_RE.exec(itemLines[0]!)!;
  const headParts = [match[3]!];
  const nested: string[] = [];
  let inNested = false;
  for (const raw of itemLines.slice(1)) {
    if (!raw.trim()) continue;
    if (isListLine(raw)) {
      inNested = true;
      nested.push(raw);
    } else if (inNested) {
      nested.push(raw);
    } else {
      headParts.push(raw.trim());
    }
  }
  let html = renderInline(headParts.join(" "));
  if (nested.length) html += renderNestedList(nested);
  return html;
}

function renderNestedList(lines: string[]): string {
  const indents = lines.filter(isListLine).map((line) => LIST_RE.exec(line)![1]!.length);
  const min = Math.min(...indents);
  const items: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const match = LIST_RE.exec(line);
    if (match && isListLine(line) && match[1]!.length <= min) {
      current = [line];
      items.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  if (!items.length) return "";
  const ordered = /^\d/.test(LIST_RE.exec(items[0]![0]!)![2]!);
  const body = items.map((item) => `<li>${renderListItemLines(item)}</li>`).join("");
  return ordered ? `<ol>${body}</ol>` : `<ul>${body}</ul>`;
}

function parseSegments(markdown: string): Segment[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const segments: Segment[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]![0]!;
      const lang = fence[2] ?? "";
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^ {0,3}${marker === "~" ? "~~~" : "\`\`\`"}+\\s*$`).test(lines[j]!)) {
        body.push(lines[j]!);
        j++;
      }
      const source = lines.slice(i, Math.min(j + 1, lines.length)).join("\n");
      const code = body.join("\n");
      const langAttr = /^[\w+-]{1,32}$/.test(lang) ? ` class="language-${lang}"` : "";
      segments.push({
        kind: "code",
        source,
        render: (id) => `<pre data-block-id="${id}"><code${langAttr}>${escapeHtml(code)}</code></pre>`,
      });
      i = j + 1;
      continue;
    }

    // Horizontal rule (checked before lists: "- - -" is an hr)
    if (HR_RE.test(line)) {
      segments.push({ kind: "hr", source: line, render: (id) => `<hr data-block-id="${id}">` });
      i++;
      continue;
    }

    // ATX heading
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const content = heading[2] ?? "";
      segments.push({
        kind: "heading",
        source: line,
        render: (id) => `<h${level} data-block-id="${id}">${renderInline(content)}</h${level}>`,
      });
      i++;
      continue;
    }

    // Blockquote
    if (QUOTE_RE.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i]!)) {
        quote.push(lines[i]!);
        i++;
      }
      const source = quote.join("\n");
      segments.push({ kind: "quote", source, render: (id) => renderQuote(quote, id) });
      continue;
    }

    // Table
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const table: string[] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
        table.push(lines[i]!);
        i++;
      }
      const source = table.join("\n");
      segments.push({ kind: "table", source, render: (id) => renderTable(table, id) });
      continue;
    }

    // List: each top-level item is its own block
    const listStart = LIST_RE.exec(line);
    if (listStart && isListLine(line) && listStart[1]!.length <= 3) {
      const region: string[] = [];
      let j = i;
      while (j < lines.length) {
        const current = lines[j]!;
        if (!current.trim()) {
          const next = lines[j + 1];
          if (next !== undefined && (isListLine(next) || /^\s{2,}\S/.test(next))) {
            region.push(current);
            j++;
            continue;
          }
          break;
        }
        if (isListLine(current) || /^\s{2,}\S/.test(current)) {
          region.push(current);
          j++;
          continue;
        }
        break;
      }

      // Top-level items share the indent of the first item; anything deeper
      // is nested content of the item above it.
      const topIndent = listStart[1]!.length;
      const items: string[][] = [];
      let current: string[] | null = null;
      for (const regionLine of region) {
        const match = LIST_RE.exec(regionLine);
        if (match && isListLine(regionLine) && match[1]!.length <= topIndent) {
          current = [regionLine];
          items.push(current);
        } else if (current) {
          current.push(regionLine);
        }
      }
      const firstMarker = LIST_RE.exec(items[0]![0]!)![2]!;
      const ordered = /^\d/.test(firstMarker);
      const start = ordered ? parseInt(firstMarker, 10) : 1;
      const openTag = ordered ? (start !== 1 ? `<ol start="${start}">` : "<ol>") : "<ul>";
      const closeTag = ordered ? "</ol>" : "</ul>";
      items.forEach((item, index) => {
        segments.push({
          kind: "li",
          source: item.join("\n"),
          render: (id) => `<li data-block-id="${id}">${renderListItemLines(item)}</li>`,
          ...(index === 0 ? { pre: openTag } : {}),
          ...(index === items.length - 1 ? { post: closeTag } : {}),
        });
      });
      i = j;
      continue;
    }

    // Paragraph: consume until a blank line or the start of another construct
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i]!;
      if (!current.trim()) break;
      if (FENCE_RE.test(current) || HR_RE.test(current) || HEADING_RE.test(current)) break;
      if (QUOTE_RE.test(current) || isListLine(current)) break;
      paragraph.push(current);
      i++;
    }
    const source = paragraph.join("\n");
    const single = paragraph.length === 1 ? paragraph[0]!.trim() : "";
    const isImage = /^!\[[^\]]*\]\([^)]+\)$/.test(single);
    segments.push({
      kind: isImage ? "image" : "paragraph",
      source,
      render: (id) => `<p data-block-id="${id}">${renderInline(paragraph.map((l) => l.trim()).join(" "))}</p>`,
    });
  }

  return segments;
}

export function renderPlan(markdown: string): RenderedPlan {
  const segments = parseSegments(markdown);
  const blocks: PlanBlock[] = [];
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.pre) parts.push(segment.pre);
    const id = `${blocks.length}-${blockHash(segment.source)}`;
    const html = segment.render(id);
    blocks.push({
      id,
      kind: segment.kind,
      text: segment.kind === "image" ? excerpt(segment.source) || "[image]" : excerpt(segment.source),
      source: segment.source,
      html,
    });
    parts.push(html);
    if (segment.post) parts.push(segment.post);
  }
  return { html: parts.join("\n"), blocks };
}

// --- Diffing ---

export type DiffType = "same" | "added" | "removed" | "changed";

export interface DiffPart {
  type: DiffType;
  kind: BlockKind;
  html: string;
}

function lcsMatrix<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Int32Array {
  const cols = b.length + 1;
  const table = new Int32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = eq(a[i]!, b[j]!)
        ? table[(i + 1) * cols + j + 1]! + 1
        : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  return table;
}

interface Op {
  type: "same" | "del" | "ins";
  a?: number;
  b?: number;
}

function diffOps<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Op[] {
  const table = lcsMatrix(a, b, eq);
  const cols = b.length + 1;
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (eq(a[i]!, b[j]!)) {
      ops.push({ type: "same", a: i++, b: j++ });
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      ops.push({ type: "del", a: i++ });
    } else {
      ops.push({ type: "ins", b: j++ });
    }
  }
  while (i < a.length) ops.push({ type: "del", a: i++ });
  while (j < b.length) ops.push({ type: "ins", b: j++ });
  return ops;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function similarity(x: string, y: string): number {
  const xs = words(x.toLowerCase());
  const yList = words(y.toLowerCase());
  const counts = new Map<string, number>();
  for (const w of yList) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of xs) {
    const count = counts.get(w) ?? 0;
    if (count > 0) {
      shared++;
      counts.set(w, count - 1);
    }
  }
  const total = Math.max(xs.length, yList.length);
  return total ? shared / total : 1;
}

export function diffWordsHtml(oldText: string, newText: string): string {
  const a = words(oldText);
  const b = words(newText);
  const ops = diffOps(a, b, (x, y) => x === y);
  const out: string[] = [];
  let run: { type: Op["type"]; words: string[] } | null = null;
  const flush = () => {
    if (!run) return;
    const text = escapeHtml(run.words.join(" "));
    if (run.type === "same") out.push(text);
    else if (run.type === "del") out.push(`<del>${text}</del>`);
    else out.push(`<ins>${text}</ins>`);
    run = null;
  };
  for (const op of ops) {
    const word = op.type === "del" ? a[op.a!]! : op.type === "ins" ? b[op.b!]! : a[op.a!]!;
    if (!run || run.type !== op.type) {
      flush();
      run = { type: op.type, words: [word] };
    } else {
      run.words.push(word);
    }
  }
  flush();
  return out.join(" ");
}

function partHtml(block: PlanBlock): string {
  // Bare <li> outside a list is invalid; give diff-view items a wrapper.
  return block.kind === "li" ? `<ul class="dli">${block.html}</ul>` : block.html;
}

export function diffPlan(oldMarkdown: string, newMarkdown: string): DiffPart[] {
  const a = renderPlan(oldMarkdown).blocks;
  const b = renderPlan(newMarkdown).blocks;
  const key = (block: PlanBlock) => `${block.kind}:${blockHash(block.source)}`;
  const ops = diffOps(a, b, (x, y) => key(x) === key(y));

  const parts: DiffPart[] = [];
  let index = 0;
  while (index < ops.length) {
    const op = ops[index]!;
    if (op.type === "same") {
      parts.push({ type: "same", kind: b[op.b!]!.kind, html: partHtml(b[op.b!]!) });
      index++;
      continue;
    }
    // Collect a contiguous run of del/ins and pair them in order.
    const dels: PlanBlock[] = [];
    const inss: PlanBlock[] = [];
    while (index < ops.length && ops[index]!.type !== "same") {
      const run = ops[index]!;
      if (run.type === "del") dels.push(a[run.a!]!);
      else inss.push(b[run.b!]!);
      index++;
    }
    const paired = Math.min(dels.length, inss.length);
    for (let k = 0; k < paired; k++) {
      const oldBlock = dels[k]!;
      const newBlock = inss[k]!;
      if (similarity(normalize(oldBlock.source), normalize(newBlock.source)) >= 0.3) {
        parts.push({
          type: "changed",
          kind: newBlock.kind,
          html: `<div class="wdiff">${diffWordsHtml(normalize(oldBlock.source), normalize(newBlock.source))}</div>`,
        });
      } else {
        parts.push({ type: "removed", kind: oldBlock.kind, html: partHtml(oldBlock) });
        parts.push({ type: "added", kind: newBlock.kind, html: partHtml(newBlock) });
      }
    }
    for (const block of dels.slice(paired)) parts.push({ type: "removed", kind: block.kind, html: partHtml(block) });
    for (const block of inss.slice(paired)) parts.push({ type: "added", kind: block.kind, html: partHtml(block) });
  }
  return parts;
}
