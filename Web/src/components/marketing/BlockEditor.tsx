import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../../lib/api';
import { PictureUpload, ProductPicker } from './PickParts';
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
          ? <textarea ref={ref as any} value={value} rows={rows} placeholder={placeholder} onChange={e => onChange(e.target.value)} className="eb-input" style={{ flex: 1, resize: 'vertical' }} />
          : <input ref={ref as any} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} className="eb-input" style={{ flex: 1 }} />}
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

// One small picture for each kind of block, so a block can be told apart at a glance.
const ICONS: Record<string, string> = {
  heading: 'M5 4v12M13 4v12M5 10h8',
  text: 'M4 6h12M4 10h12M4 14h8',
  image: 'M3.5 5.5h13v9h-13zM3.5 13l4-4 3 3 2-2 4 4M13 8.2h.01',
  button: 'M3.5 7h13a1 1 0 011 1v4a1 1 0 01-1 1h-13a1 1 0 01-1-1V8a1 1 0 011-1zM7 10h6',
  products: 'M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z',
  divider: 'M3 10h14',
  spacer: 'M10 3v4M10 13v4M7 5l3-2 3 2M7 15l3 2 3-2',
  items: 'M4 5h2M8 5h8M4 10h2M8 10h8M4 15h2M8 15h8',
  details: 'M4 4h12v12H4zM4 8h12M9 8v8',
};
function BlockIcon({ type, size = 15 }: { type: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[type] ?? ICONS.text} /></svg>;
}
const Arrow = ({ up }: { up?: boolean }) => <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={up ? 'M5 12l5-5 5 5' : 'M5 8l5 5 5-5'} /></svg>;
const Cross = () => <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>;

export default function BlockEditor({ blocks, onChange, subject, previewText, fromName, kind = 'campaign' }: {
  blocks: Block[]; onChange: (b: Block[]) => void; subject: string; previewText: string; fromName?: string | null; kind?: 'campaign' | 'automation';
}) {
  const [phone, setPhone] = useState(false);   // preview at phone width
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
  const line = <div data-drop-line className="eb-line" />;
  const types = (['heading', 'text', 'image', 'button', 'products', 'divider', 'spacer', ...(kind === 'automation' ? AUTOMATION_ONLY : [])] as BlockType[]);

  return (
    <div className="eb">
      <div>
        {blocks.map((b, i) => (
          <div key={b.id}>
            {dragging && gap === i && line}
          <div className="eb-block" style={{ opacity: from === i ? 0.45 : 1 }} data-block={b.type}
            draggable={armed === i}
            onDragStart={e => { setFrom(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }}
            onDragEnd={end}
            onDragOver={e => { if (!dragging) return; e.preventDefault(); const g = gapAt(e, i); if (g !== gap) setGap(g); }}
            onDrop={e => { if (!dragging) return; e.preventDefault(); place(gapAt(e, i)); }}>
            <div className="eb-head">
              <span title="Drag to move this block" aria-hidden="true" data-handle className="eb-handle" onMouseDown={() => setArmed(i)} onMouseUp={() => setArmed(null)}>⠿</span>
              <span className="eb-ico"><BlockIcon type={b.type} /></span>
              <b className="eb-name">{BLOCK_NAMES[b.type]}</b>
              <span className="eb-tools">
                <button type="button" className="eb-iconbtn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" title="Move up"><Arrow up /></button>
                <button type="button" className="eb-iconbtn" onClick={() => move(i, 1)} disabled={i === blocks.length - 1} aria-label="Move down" title="Move down"><Arrow /></button>
                <button type="button" className="eb-iconbtn danger" onClick={() => onChange(blocks.filter((_, j) => j !== i))} aria-label="Remove block" title="Remove this block"><Cross /></button>
              </span>
            </div>
            {b.type === 'heading' && <TagField tags={tags} value={b.text} onChange={v => set(i, { text: v })} placeholder="Heading" />}
            {b.type === 'text' && <TagField tags={tags} multiline value={b.text} onChange={v => set(i, { text: v })} placeholder="Write your message. A web address becomes a link." />}
            {b.type === 'image' && <>
              <PictureUpload onUploaded={url => set(i, { url })} />
              <TagField tags={[]} value={b.url} onChange={v => set(i, { url: v })} placeholder="Or paste a picture address (https://...). A Dropbox share link works." label="Picture" />
              <TagField tags={[]} value={b.alt ?? ''} onChange={v => set(i, { alt: v })} placeholder="Describe the picture (shown if it cannot load)" />
              <TagField tags={tags} value={b.link ?? ''} onChange={v => set(i, { link: v })} placeholder="Where it links to (optional)" />
            </>}
            {b.type === 'button' && <>
              <TagField tags={tags} value={b.label} onChange={v => set(i, { label: v })} placeholder="Button text" />
              <TagField tags={tags} value={b.url} onChange={v => set(i, { url: v })} placeholder="Where it goes (https://... or a merge tag)" />
            </>}
            {b.type === 'products' && <>
              <ProductPicker skus={b.skus} onChange={skus => set(i, { skus })} />
              <div style={{ display: 'flex', gap: 14, fontSize: 12.5, alignItems: 'center', flexWrap: 'wrap' }}>
                <label><input type="checkbox" checked={!!b.showPrice} onChange={e => set(i, { showPrice: e.target.checked })} /> Show wholesale and retail price (ex GST)</label>
                <label>Across <select value={b.columns ?? 2} onChange={e => set(i, { columns: Number(e.target.value) === 3 ? 3 : 2 })}><option value={2}>2</option><option value={3}>3</option></select></label>
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
        <div data-drop-end className={'eb-end' + (blocks.length ? '' : ' empty')} onDragOver={e => { if (!dragging) return; e.preventDefault(); if (gap !== blocks.length) setGap(blocks.length); }} onDrop={e => { if (!dragging) return; e.preventDefault(); place(blocks.length); }}>
          {dragging && gap === blocks.length && line}
          {!blocks.length && 'Nothing here yet. Press or drag a block from below.'}
        </div>
        <div className="eb-add" aria-label="Add a block">
          {types.map(t => <span key={t} role="button" tabIndex={0} className="eb-chip" draggable   // a span, not a button: Firefox will not drag a button
            onDragStart={e => { setAdd(t); e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', t); }} onDragEnd={end}
            onClick={() => onChange([...blocks, newBlock(t)])} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange([...blocks, newBlock(t)]); } }}><span className="eb-ico"><BlockIcon type={t} size={12} /></span>+ {BLOCK_NAMES[t]}</span>)}
        </div>
        {unknown.length > 0 && <div className="save-msg err" style={{ marginTop: 10 }}>These merge tags are not recognised and will be left blank: {unknown.map(u => `{{${u}}}`).join(', ')}</div>}
      </div>
      <div className="eb-preview">
        <div className="eb-previewbar">
          <span className="eb-previewtitle">Preview {busy && <span className="acct-region">updating…</span>}</span>
          <span className="eb-device" role="group" aria-label="Preview width">
            <button type="button" className={phone ? '' : 'on'} aria-pressed={!phone} onClick={() => setPhone(false)}>Computer</button>
            <button type="button" className={phone ? 'on' : ''} aria-pressed={phone} onClick={() => setPhone(true)}>Phone</button>
          </span>
        </div>
        <div className="eb-inbox" aria-label="How it looks in an inbox">
          <div className="eb-inbox-from">{fromName?.trim() || 'Rhino Rhino'}</div>
          <div className="eb-inbox-subject">{subject.trim() || <span className="eb-ghost">Your subject line</span>}</div>
          <div className="eb-inbox-preview">{previewText.trim() || <span className="eb-ghost">Preview text shows here</span>}</div>
        </div>
        <div className="eb-frame">
          <iframe title="Email preview" srcDoc={html} sandbox="" style={{ width: phone ? 375 : '100%', maxWidth: '100%' }} />
        </div>
        <div className="acct-region" style={{ marginTop: 6 }}>Shown with sample customer details. Links work in the real email.</div>
      </div>
    </div>
  );
}
