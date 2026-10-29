#!/usr/bin/env node
// Makes a private access code for each manager, and the one line to paste into Railway.
//
//   node scripts/make-access-codes.mjs "Alex Smith" "Pat Jones"          names as arguments, or one per line on standard input
//   node scripts/make-access-codes.mjs --keep "$ACCESS_CODES" "New Name"   adds a person and leaves everyone already in the list with their own code
//
// The names come from the list of managers in Radar (list-managers.sql). Nothing is saved anywhere: copy what it prints.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** A name the server accepts: letters, digits, spaces, dots, dashes and underscores, up to 40 characters. */
export function cleanName(raw) {
  const name = String(raw ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  return { name, changed: name !== String(raw ?? '').trim() };
}

/** Existing "name:code" pairs from the ACCESS_CODES setting. */
export function parsePairs(line) {
  return String(line ?? '').split(',').map(s => s.trim()).filter(Boolean).map(p => { const i = p.indexOf(':'); if (i < 1) throw new Error(`"${p.slice(0, 20)}" is not name:code`); return { name: p.slice(0, i).trim(), code: p.slice(i + 1).trim() }; });
}

export function makeAccessCodes(names, { keep = [], bytes = 18 } = {}) {
  const entries = keep.map(k => ({ ...k, kept: true, changed: false }));
  const seen = new Set(entries.map(e => e.name.toLowerCase()));
  const problems = [];
  for (const raw of names) {
    const { name, changed } = cleanName(raw);
    if (!name) { if (String(raw).trim()) problems.push(`"${raw}" has no usable letters or digits, so it was skipped`); continue; }
    if (seen.has(name.toLowerCase())) { problems.push(`"${name}" is already in the list, so it was skipped (nothing changes for them)`); continue; }
    seen.add(name.toLowerCase());
    if (changed) problems.push(`"${String(raw).trim()}" was written as "${name}" (the server only allows plain letters, digits, spaces, dots, dashes and underscores)`);
    entries.push({ name, code: randomBytes(bytes).toString('base64url'), kept: false, changed });
  }
  return { entries, line: entries.map(e => `${e.name}:${e.code}`).join(','), problems };
}

// ---- the command line ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  let keep = [];
  const k = args.indexOf('--keep');
  if (k >= 0) { keep = parsePairs(args[k + 1]); args.splice(k, 2); }
  let names = args;
  if (names.length === 0 && !process.stdin.isTTY) { let t = ''; for await (const c of process.stdin) t += c; names = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
  if (names.length === 0 && keep.length === 0) { console.error('Give at least one name:\n  node scripts/make-access-codes.mjs "Alex Smith" "Pat Jones"'); process.exit(1); }
  const r = makeAccessCodes(names, { keep });
  for (const p of r.problems) console.error('Note: ' + p);
  console.log('\nPaste this into Railway as the ACCESS_CODES variable (one line):\n');
  console.log('ACCESS_CODES=' + r.line);
  const fresh = r.entries.filter(e => !e.kept);
  if (fresh.length) {
    console.log('\nSend each person ONLY their own code, privately (not in a group chat), with the connector address https://<your-domain>/mcp:\n');
    for (const e of fresh) console.log(`  ${e.name}: ${e.code}`);
  }
  if (r.entries.some(e => e.kept)) console.log('\n(People already in the list keep the codes they have.)');
  console.log('\nThese codes are shown once and are not saved anywhere.\n');
}
