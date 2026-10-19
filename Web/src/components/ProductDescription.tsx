import { useState } from 'react';

// DEAR's description of a product, as plain text. A long one shows its first lines, with a link to read the rest.
// With expandable off (the catalogue tiles) it just shows the first lines, and the full text on hover.
export default function ProductDescription({ text, lines = 3, expandable = true, size = 'small' }: { text: string; lines?: number; expandable?: boolean; size?: 'small' | 'normal' }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 70 || text.split('\n').length > lines;
  const clamp = !open && long;
  return (
    <div>
      <div
        className={size === 'small' ? 'acct-region' : undefined}
        title={!expandable && long ? text : undefined}
        // 'normal' is for text that is the point of its box: full size, in the main text colour.
        style={{ whiteSpace: 'pre-line', lineHeight: size === 'small' ? 1.4 : 1.55, ...(size === 'normal' ? { fontSize: 14, color: 'var(--ink)' } : {}), ...(clamp ? { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}) }}
      >
        {text}
      </div>
      {expandable && long && <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => setOpen(o => !o)}>{open ? 'Show less' : 'Show more'}</button>}
    </div>
  );
}