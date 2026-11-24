import { Fragment, useState, type ReactNode } from 'react';

// Buttons for writing an email or a template without typing any brackets:
//   Add link     select some words (or not), press it, then choose a saved link or paste a web address.
//   Fill-in      "First name", "Number" and "Brands" put the words that Radar fills in for each customer.
// Both put their text where the cursor is (or over the selected words).
export type SavedLink = { id?: string; name: string; url: string };
type Box = () => HTMLTextAreaElement | null;

/** Put `text` over the selected words (or at the cursor, or at the end), and give back the new whole text. */
export function insertInto(value: string, start: number, end: number, text: string): string {
  const a = Math.max(0, Math.min(start, value.length)), b = Math.max(a, Math.min(end, value.length));
  return value.slice(0, a) + text + value.slice(b);
}
const tidyWords = (w: string) => w.replace(/[\[\]\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
const safeUrl = (u: string) => u.replace(/\(/g, '%28').replace(/\)/g, '%29');
/** The text for a saved link. In a template it keeps the link's name, so the address is still changed in one place. In an email it is the finished link. */
export function linkText(mode: 'template' | 'email', link: SavedLink, wordsIn: string): string {
  const words = tidyWords(wordsIn) || link.name;
  if (mode === 'template') return words === link.name ? `[Link: ${link.name}]` : `[Link: ${link.name} | ${words}]`;
  return `[${words}](${safeUrl(link.url)})`;
}
/** The text for a pasted address, or the reason it cannot be used. */
export function addressText(wordsIn: string, addressIn: string): { text: string } | { error: string } {
  const words = tidyWords(wordsIn), address = addressIn.trim();
  if (!words) return { error: 'Type the words that should be the link.' };
  if (!address) return { error: 'Paste the web address.' };
  let u: URL; try { u = new URL(address); } catch { return { error: 'That does not look like a web address. Paste the whole thing, starting with https://' }; }
  if (u.protocol !== 'https:') return { error: 'Only addresses starting with https:// can be used.' };
  return { text: `[${words}](${safeUrl(u.href)})` };
}

export function FillButtons({ getBox, value, onChange, number = true, brands = true }: { getBox: Box; value: string; onChange: (v: string) => void; number?: boolean; brands?: boolean }) {
  const put = (tag: string) => { const b = getBox(), s = b?.selectionStart ?? value.length, e = b?.selectionEnd ?? value.length; onChange(insertInto(value, s, e, tag)); b?.focus(); };
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="acct-region">Put in:</span>
      <button type="button" className="btn secondary" style={{ padding: '3px 10px' }} title={'Becomes the customer\'s first name, or "there"'} onClick={() => put('[Name]')}>First name</button>
      {number && <button type="button" className="btn secondary" style={{ padding: '3px 10px' }} title="Becomes the quote or order number" onClick={() => put('[Number]')}>Number</button>}
      {brands && <button type="button" className="btn secondary" style={{ padding: '3px 10px' }} title="Abandoned cart: the brands in the cart" onClick={() => put('[Brands]')}>Brands</button>}
    </span>
  );
}

const OTHER = '__other__';
export function AddLink({ getBox, value, onChange, links, mode }: { getBox: Box; value: string; onChange: (v: string) => void; links: SavedLink[]; mode: 'template' | 'email' }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [words, setWords] = useState('');
  const [which, setWhich] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  function start() {
    const b = getBox(), s = b?.selectionStart ?? value.length, e = b?.selectionEnd ?? value.length;
    setSel({ start: s, end: e }); setWords(value.slice(s, e)); setWhich(links.length ? links[0]!.name : OTHER); setAddress(''); setError(null); setOpen(true);
  }
  function add() {
    let text: string;
    if (which === OTHER) { const r = addressText(words, address); if ('error' in r) { setError(r.error); return; } text = r.text; }
    else { const l = links.find(x => x.name === which); if (!l) { setError('Choose a link.'); return; } text = linkText(mode, l, words); }
    onChange(insertInto(value, sel.start, sel.end, text)); setOpen(false); getBox()?.focus();
  }
  return (
    <span>
      <button type="button" className="btn secondary" style={{ padding: '3px 10px' }} onClick={() => (open ? setOpen(false) : start())} aria-expanded={open}>Add link</button>
      {open && (
        <div role="group" aria-label="Add a link" style={{ border: '1px solid var(--line)', borderRadius: 6, padding: 10, margin: '8px 0', display: 'grid', gap: 8, maxWidth: 520, background: '#fff' }}>
          <div className="acct-region" style={{ fontSize: 12.5 }}>Select the words in the email that should be a link first, or just type them here.</div>
          <label className="modal-field" style={{ margin: 0 }}>Words to show<input value={words} onChange={e => setWords(e.target.value)} placeholder={which !== OTHER ? 'Leave empty to show the link\'s name' : 'See the presentation'} /></label>
          <label className="modal-field" style={{ margin: 0 }}>Link
            <select value={which} onChange={e => { setWhich(e.target.value); setError(null); }}>
              {links.map(l => <option key={l.name} value={l.name}>{l.name}</option>)}
              <option value={OTHER}>Another web address…</option>
            </select>
          </label>
          {which === OTHER && <label className="modal-field" style={{ margin: 0 }}>Web address<input value={address} onChange={e => setAddress(e.target.value)} placeholder="https://" /></label>}
          {error && <div className="save-msg err" role="alert">{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={add}>Add</button>
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </span>
  );
}

/** An email as it will look: paragraphs, with each [words](https://address) as a clickable blue link. Nothing here can run code. */
export function EmailPreview({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /\[([^\]\n]{1,200})\]\((https:\/\/[^\s)]+)\)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Fragment key={i++}>{text.slice(last, m.index)}</Fragment>);
    parts.push(<a key={i++} href={m[2]} target="_blank" rel="noopener noreferrer" style={{ color: '#1155cc', textDecoration: 'underline' }}>{m[1]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<Fragment key={i++}>{text.slice(last)}</Fragment>);
  return <div style={{ whiteSpace: 'pre-wrap' }}>{parts}</div>;
}
