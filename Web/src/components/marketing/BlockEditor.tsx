import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '../../lib/api';
import { Block, BlockType, BLOCK_NAMES, AUTOMATION_ONLY, MergeTag, newBlock } from '../../lib/marketing';

// The email editor: a list of blocks on the left, the real email on the right. Merge tags
// ({{first_name}}) can be dropped into any text. The preview is built by the same code that builds
// the sent email, with sample values.
let tagCache: MergeTag[] | null = null;
export function useMergeTags(): MergeTag[] {
  const [tags, setTags] = useState<MergeTag[]>(tagCache ?? []);
  useEffect(() => { if (!tagCache) apiGet('/marketing/merge-tags').then((t: MergeTag[]) => { tagCache = t; setTags(t); }).catch(() => undefined); }, []);
  return tags;
}

// A text box with a "merge tag" menu that puts the tag where the cursor is.
export function TagField({ value, onChange, multiline, placeholder, tags, label, rows = 3 }: {
  value: string; onChange: (v: string) => void; multiline?: boolean; placeholder?: string; tags: MergeTag[]; label?: string; rows?: number;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  function insert(tag: string) {
    if (!tag) return;
    const el = ref.current; const text = `{{${tag}}}`;
    const at = el?.selectionStart ?? value.length, end = el?.selectionEnd ?? at;
    onChange(value.slice(0, at) + text + value.slice(end));
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(at + text.length, at + text.length); } });
  }
  const groups = [...new Set(tags.map(t => t.group))];
  return (
    <div style={{ marginBottom: 8 }}>
      {label && <div className="stat-label" style={{ marginBottom: 3 }}>{label}</div>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        {multiline
          ? <textarea ref={ref as any} value={value} rows={rows} placeholder={placeholder} onChange={e => onChange(e.target.value)} style={{ flex: 1, font: 'inherit', fontSize: 13.5, padding: '7px 9px', border: '1px solid var(--line)', borderRadius: 6, resize: 'vertical' }} />
          : <input ref={ref as any} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} style={{ flex: 1, font: 'inherit', fontSize: 13.5, padding: '7px 9px', border: '1px solid var(--line)', borderRadius: 6 }} />}
        {tags.length > 0 && (
          <select aria-label="Insert merge tag" value="" onChange={e => insert(e.target.value)} style={{ width: 96, fontSize: 12 }} title="Put the customer's name, store, order number and so on into the text">
            <option value="">+ Merge tag</option>
            {groups.map(g => <optgroup key={g} label={g}>{tags.filter(t => t.group === g).map(t => <option key={t.tag} value={t.tag}>{t.label}</option>)}</optgroup>)}
          </select>
        )}
      </div>
    </div>
  );
}

export default function BlockEditor({ blocks, onChange, subject, previewText, kind = 'campaign' }: {
  blocks: Block[]; onChange: (b: Block[]) => void; subject: string; previewText: string; kind?: 'campaign' | 'automation';
}) {
  const tags = useMergeTags();
  const [html, setHtml] = useState(''); const [unknown, setUnknown] = useState<string[]>([]); const [busy, setBusy] = useState(false);
  const key = JSON.stringify(blocks) + '|' + subject + '|' + previewText;
  useEffect(() => {
    setBusy(true);
    const t = setTimeout(() => { apiPost('/marketing/render', { subject, previewText, blocks }).then(r => { setHtml(r.html); setUnknown(r.unknownTags ?? []); }).catch(() => undefined).finally(() => setBusy(false)); }, 450);
    return () => clearTimeout(t);
  }, [key]);

  const set = (i: number, patch: Partial<Block>) => onChange(blocks.map((b, j) => (j === i ? ({ ...b, ...patch } as Block) : b)));
  const move = (i: number, d: -1 | 1) => { const j = i + d; if (j < 0 || j >= blocks.length) return; const n = [...blocks]; [n[i], n[j]] = [n[j], n[i]]; onChange(n); };
  // Drag and drop: grab a block by its handle and drop it where it should go, or drag a "+ Text" style button into the list. The arrow buttons stay, for keyboards and phones.
  const [armed, setArmed] = useState<number | null>(null);     // the handle being held
  const [from, setFrom] = useState<number | null>(null);       // the block being moved
  const [add, setAdd] = useState<BlockType | null>(null);      // a new block being dragged in from the buttons
  const [gap, setGap] = useState<number | null>(null);         // where it would land: 0 is the top, blocks.length the end
  const dragging = from !== null || add !== null;
  const end = () => { setArmed(null); setFrom(null); setAdd(null); setGap(null); };
  const place = (g: number) => {
    const n = [...blocks];
    if (from !== null) { const [m] = n.splice(from, 1); n.splice(g > from ? g - 1 : g, 0, m); onChange(n); }
    else if (add) { n.splice(g, 0, newBlock(add)); onChange(n); }
    end();
  };
  const gapAt = (e: { clientY: number; currentTarget: HTMLElement }, i: number) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 ? i : i + 1; };
  const line = <div data-drop-line style={{ height: 3, background: 'var(--teal)', borderRadius: 2, margin: '-5px 0 6px' }} />;
  const types = (['heading', 'text', 'image', 'button', 'products', 'divider', 'spacer', ...(kind === 'automation' ? AUTOMATION_ONLY : [])] as BlockType[]);
  const box = { border: '1px solid var(--line)', borderRadius: 6, padding: '9px 11px', background: 'var(--panel)', marginBottom: 8 } as const;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) minmax(300px, 1fr)', gap: 16, alignItems: 'start' }}>
      <div>
        {blocks.map((b, i) => (
          <div key={b.id}>
            {dragging && gap === i && line}
          <div style={{ ...box, opacity: from === i ? 0.45 : 1 }} data-block={b.type}
            draggable={armed === i}
            onDragStart={e => { setFrom(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }}
            onDragEnd={end}
            onDragOver={e => { if (!dragging) return; e.preventDefault(); const g = gapAt(e, i); if (g !== gap) setGap(g); }}
            onDrop={e => { if (!dragging) return; e.preventDefault(); place(gapAt(e, i)); }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span title="Drag to move this block" aria-hidden="true" data-handle style={{ cursor: 'grab', color: 'var(--muted)', userSelect: 'none', padding: '0 4px' }}
                onMouseDown={() => setArmed(i)} onMouseUp={() => setArmed(null)}>⠿</span>
              <b style={{ fontSize: 12.5 }}>{BLOCK_NAMES[b.type]}</b>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <button type="button" className="edit-link" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                <button type="button" className="edit-link" onClick={() => move(i, 1)} disabled={i === blocks.length - 1} aria-label="Move down">↓</button>
                <button type="button" className="edit-link" onClick={() => onChange(blocks.filter((_, j) => j !== i))} aria-label="Remove block">Remove</button>
              </span>
            </div>
            {b.type === 'heading' && <TagField tags={tags} value={b.text} onChange={v => set(i, { text: v })} placeholder="Heading" />}
            {b.type === 'text' && <TagField tags={tags} multiline value={b.text} onChange={v => set(i, { text: v })} placeholder="Write your message. A web address becomes a link." />}
            {b.type === 'image' && <>
              <TagField tags={[]} value={b.url} onChange={v => set(i, { url: v })} placeholder="Picture address (https://...). A Dropbox share link works." label="Picture" />
              <TagField tags={[]} value={b.alt ?? ''} onChange={v => set(i, { alt: v })} placeholder="Describe the picture (shown if it cannot load)" />
              <TagField tags={tags} value={b.link ?? ''} onChange={v => set(i, { link: v })} placeholder="Where it links to (optional)" />
            </>}
            {b.type === 'button' && <>
              <TagField tags={tags} value={b.label} onChange={v => set(i, { label: v })} placeholder="Button text" />
              <TagField tags={tags} value={b.url} onChange={v => set(i, { url: v })} placeholder="Where it goes (https://... or a merge tag)" />
            </>}
            {b.type === 'products' && <>
              <TagField tags={[]} multiline rows={2} value={b.skus.join(', ')} onChange={v => set(i, { skus: v.split(/[\s,;]+/).filter(Boolean) })} placeholder="Product codes (SKUs), separated by commas" label="Products" />
              <div style={{ display: 'flex', gap: 14, fontSize: 12.5, alignItems: 'center', flexWrap: 'wrap' }}>
                <label><input type="checkbox" checked={!!b.showPrice} onChange={e => set(i, { showPrice: e.target.checked })} /> Show the RRP</label>
                <label>Across <select value={b.columns ?? 2} onChange={e => set(i, { columns: Number(e.target.value) === 3 ? 3 : 2 })}><option value={2}>2</option><option value={3}>3</option></select></label>
                <Link to="/catalogue" target="_blank" className="order-link">Find product codes in the Catalogue</Link>
              </div>
            </>}
            {b.type === 'spacer' && <label style={{ fontSize: 12.5 }}>Height <input type="number" min={4} max={80} value={b.size ?? 20} onChange={e => set(i, { size: Number(e.target.value) })} style={{ width: 64 }} /> px</label>}
            {(b.type === 'divider' || b.type === 'items' || b.type === 'details') && (
              <div className="acct-region">{b.type === 'divider' ? 'A thin line.' : b.type === 'items' ? 'Lists the items in the customer\'s cart. Filled in for each customer.' : 'A table of the order facts (quote number, amount, dates). Filled in for each customer.'}</div>
            )}
          </div>
          </div>
        ))}
        {/* always on the page, so nothing moves when a drag starts */}
        <div data-drop-end onDragOver={e => { if (!dragging) return; e.preventDefault(); if (gap !== blocks.length) setGap(blocks.length); }} onDrop={e => { if (!dragging) return; e.preventDefault(); place(blocks.length); }}
          style={{ minHeight: blocks.length ? 22 : 60, marginBottom: 8, border: blocks.length ? undefined : '2px dashed var(--line)', borderRadius: 6, padding: blocks.length ? 0 : '18px 10px', fontSize: 12.5, color: 'var(--muted)' }}>
          {dragging && gap === blocks.length && line}
          {!blocks.length && 'Drag a block in from the buttons below, or press one.'}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }} aria-label="Add a block">
          {types.map(t => <span key={t} role="button" tabIndex={0} className="btn secondary" style={{ padding: '4px 10px', fontSize: 12, cursor: 'grab', userSelect: 'none' }} draggable   // a span, not a button: Firefox will not drag a button
            onDragStart={e => { setAdd(t); e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', t); }} onDragEnd={end}
            onClick={() => onChange([...blocks, newBlock(t)])} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange([...blocks, newBlock(t)]); } }}>+ {BLOCK_NAMES[t]}</span>)}
        </div>
        {unknown.length > 0 && <div className="save-msg err" style={{ marginTop: 10 }}>These merge tags are not recognised and will be left blank: {unknown.map(u => `{{${u}}}`).join(', ')}</div>}
      </div>
      <div>
        <div className="stat-label" style={{ marginBottom: 4 }}>Preview {busy && <span className="acct-region">updating…</span>}</div>
        <iframe title="Email preview" srcDoc={html} sandbox="" style={{ width: '100%', height: 560, border: '1px solid var(--line)', borderRadius: 6, background: '#f3f4ef' }} />
        <div className="acct-region" style={{ marginTop: 4 }}>Shown with sample customer details. Links work in the real email.</div>
      </div>
    </div>
  );
}