import { useState } from 'react';

// DEAR's description of a product, as plain text. A long one shows its first lines, with a link to read the rest.
// With expandable off (the catalogue tiles) it just shows the first lines, and the full text on hover.
export default function ProductDescription({ text, lines = 3, expandable = true }: { text: string; lines?: number; expandable?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 70 || text.split('\n').length > lines;
  const clamp = !open && long;
  return (
    <div>
      <div
        className="acct-region"
        title={!expandable && long ? text : undefined}
        style={{ whiteSpace: 'pre-line', lineHeight: 1.4, ...(clamp ? { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}) }}
      >
        {text}
      </div>
      {expandable && long && <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => setOpen(o => !o)}>{open ? 'Show less' : 'Show more'}</button>}
    </div>
  );
}