import { ReactNode } from 'react';

// A small, safe renderer for the formatting Claude writes: headings, bold, italic, code, lists, tables, quotes, links.
// It builds React elements directly and never sets raw HTML, so nothing in an answer (or in the data it read) can run.
// Half-written markdown, which is what you see while an answer streams in, simply shows as plain text until it completes.

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*(?=\S)(?:[^*\n]|\*(?!\*))+?\*\*)|(\*(?!\*)(?=\S)[^*\n]+?(?<=\S)\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0, k = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<code key={k++} style={{ background: 'var(--paper, #f3f1ea)', padding: '1px 5px', borderRadius: 3, fontSize: '0.92em' }}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{inline(t.slice(2, -2))}</strong>);
    else if (m[3]) out.push(<em key={k++}>{inline(t.slice(1, -1))}</em>);
    else {
      const [, label, url] = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push(SAFE_LINK.test(url) ? <a key={k++} href={url} target="_blank" rel="noopener noreferrer">{label}</a> : t);   // anything else (javascript:, data:) stays as plain text
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Item = { text: string; indent: number; ordered: boolean };
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const listMatch = (l: string) => l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);

function renderList(items: Item[], key: number): ReactNode {
  // Nested by indentation: a deeper item belongs to the item above it.
  const build = (from: number, indent: number): [ReactNode, number] => {
    const ordered = items[from].ordered;
    const lis: ReactNode[] = [];
    let i = from;
    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) break;
      const li = items[i]; let child: ReactNode = null;
      i++;
      if (i < items.length && items[i].indent > indent) { const [node, next] = build(i, items[i].indent); child = node; i = next; }
      lis.push(<li key={lis.length}>{inline(li.text)}{child}</li>);
    }
    const Tag = ordered ? 'ol' : 'ul';
    return [<Tag key={from} style={{ margin: '4px 0 4px 20px', paddingLeft: 4 }}>{lis}</Tag>, i];
  };
  return <div key={key}>{build(0, items[0].indent)[0]}</div>;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0, key = 0, para: string[] = [];
  const flush = () => { if (para.length) { blocks.push(<p key={key++} style={{ margin: '6px 0' }}>{para.flatMap((l, n) => (n ? [<br key={`b${n}`} />, ...inline(l)] : inline(l)))}</p>); para = []; } };

  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {                                  // a code block, until the closing fence (or the end, while streaming)
      flush(); const code: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; blocks.push(<pre key={key++} style={{ background: 'var(--paper, #f3f1ea)', padding: '8px 10px', borderRadius: 5, overflowX: 'auto', fontSize: 12.5, margin: '6px 0' }}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {   // a table
      flush(); const head = cells(line); i += 2; const rows: string[][] = [];
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key++} style={{ overflowX: 'auto', margin: '6px 0' }}>
          <table className="ov-table"><thead><tr>{head.map((h, n) => <th key={n}>{inline(h)}</th>)}</tr></thead>
            <tbody>{rows.map((r, n) => <tr key={n}>{head.map((_, c) => <td key={c}>{inline(r[c] ?? '')}</td>)}</tr>)}</tbody></table>
        </div>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); const size = [0, 19, 17, 15.5, 14.5][h[1].length]; blocks.push(<div key={key++} style={{ fontWeight: 700, fontSize: size, margin: '10px 0 4px' }}>{inline(h[2])}</div>); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push(<hr key={key++} style={{ border: 'none', borderTop: '1px solid var(--line, #ddd)', margin: '8px 0' }} />); i++; continue; }
    if (/^>\s?/.test(line)) { flush(); const q: string[] = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); blocks.push(<blockquote key={key++} style={{ margin: '6px 0', paddingLeft: 10, borderLeft: '3px solid var(--line, #ccc)', color: 'var(--muted, #666)' }}>{q.map((l, n) => <div key={n}>{inline(l)}</div>)}</blockquote>); continue; }
    if (listMatch(line)) {
      flush(); const items: Item[] = [];
      while (i < lines.length) { const m = listMatch(lines[i]); if (!m) break; items.push({ indent: Math.floor(m[1].replace(/\t/g, '  ').length / 2), ordered: /\d/.test(m[2]), text: m[3] }); i++; }
      const base = Math.min(...items.map(x => x.indent)); items.forEach(x => { x.indent -= base; });
      blocks.push(renderList(items, key++)); continue;
    }
    if (line.trim() === '') { flush(); i++; continue; }
    para.push(line); i++;
  }
  flush();
  return <div className="md" style={{ lineHeight: 1.5 }}>{blocks}</div>;
}