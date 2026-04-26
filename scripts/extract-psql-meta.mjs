#!/usr/bin/env node
// Parse `psql -c '\?'` output into JSON for the editor's backslash autocomplete.
// Usage:
//   docker run --rm -d --name pg-tmp -e POSTGRES_PASSWORD=tmp postgres:18
//   docker exec pg-tmp bash -c 'until pg_isready -U postgres >/dev/null 2>&1; do sleep .5; done; psql -U postgres -c "\\?"' > /tmp/psql-help.txt
//   node scripts/extract-psql-meta.mjs /tmp/psql-help.txt > server/psql-meta.json

import fs from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: extract-psql-meta.mjs <psql-help.txt>');
  process.exit(1);
}
const text = fs.readFileSync(path, 'utf8');
const lines = text.split('\n');

const out = [];
let category = '';
const DESC_COL = 25; // psql aligns descriptions starting at column 25 in `\?` output

let pending = null; // entry awaiting its description (next continuation line)

const flushPending = () => {
  if (pending) {
    out.push(pending);
    pending = null;
  }
};

for (const raw of lines) {
  if (!raw.trim()) {
    flushPending();
    continue;
  }
  // Skip the parenthetical helper line under "Informational" etc.
  if (raw.startsWith('  (')) continue;

  // Section header — no leading space.
  if (!raw.startsWith(' ')) {
    flushPending();
    category = raw.trim();
    continue;
  }

  // Continuation of a previous command's args/description (indented at DESC_COL).
  if (raw.startsWith(' '.repeat(DESC_COL)) && !raw.trim().startsWith('\\')) {
    const txt = raw.slice(DESC_COL).trim();
    if (pending) {
      // If pending has no description yet, this is its description.
      if (!pending.desc) pending.desc = txt;
      else pending.desc += ' ' + txt;
    }
    continue;
  }

  // Indented command line: `  \cmd args  description` or `  \cmd args` (desc on next line).
  if (raw.startsWith('  \\')) {
    flushPending();
    const body = raw.slice(2); // drop leading 2 spaces
    const m = body.match(/^(\S+)\s*(.*)$/);
    if (!m) continue;
    const cmd = m[1];
    const rest = m[2]; // already trimmed-left

    // Strategy: try to split args/desc on a run of 2+ spaces first (psql pads to col 25
    // when args fit). If that fails (args overflow past col 25, leaving only 1 space
    // before description), fall back to a token-by-token heuristic: args tokens look like
    // brackets, ALL_CAPS placeholders, pipes, or commas; the first lowercase word starts
    // the description.
    let args = '';
    let desc = '';

    const gap = rest.match(/^(.*?\S)\s{2,}(\S.*)$/);
    if (gap) {
      args = gap[1].trim();
      desc = gap[2].trim();
    } else {
      // Token split heuristic
      const tokens = rest.split(/\s+/).filter(Boolean);
      const isArgToken = (t) =>
        /^[\[\(<{]/.test(t) ||                 // starts with bracket/paren
        /[\]\)>}]$/.test(t) ||                 // ends with bracket/paren (e.g. arg of multi-token spec)
        /^[A-Z][A-Z0-9_]*\.{0,3}$/.test(t) ||  // ALL_CAPS placeholder, optional ellipsis
        /^[A-Z][A-Z0-9_]*\|/.test(t) ||        // CHOICE|...
        /\|[A-Z]/.test(t) ||                   // ...|CHOICE
        /^\.\.\.$/.test(t) ||                  // ...
        /^,$/.test(t) ||
        /^=$/.test(t);
      let i = 0;
      while (i < tokens.length && isArgToken(tokens[i])) i++;
      args = tokens.slice(0, i).join(' ');
      desc = tokens.slice(i).join(' ');
    }

    pending = { cmd, args, desc, category };
    continue;
  }
}
flushPending();

// Compress consecutive whitespace in descriptions and trim trailing punctuation noise.
for (const e of out) {
  if (e.desc) e.desc = e.desc.replace(/\s+/g, ' ').trim();
  if (e.args) e.args = e.args.replace(/\s+/g, ' ').trim();
  // Some psql commands embed flag-suffix specs in the cmd column (e.g. `\d[Sx+]`).
  // For autocomplete, expose the typed prefix (the part the user actually types) in
  // a `prefix` field, while keeping `cmd` as the canonical signature for display.
  const flagMatch = e.cmd.match(/^(\\[a-zA-Z?!]+)(\[[^\]]*\])?$/);
  e.prefix = flagMatch ? flagMatch[1] : e.cmd;
}

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
