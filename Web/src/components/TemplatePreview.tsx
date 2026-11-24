import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPost, clearApiCache } from '../lib/api';
import type { TemplateProposal } from '../lib/aiStream';
import { EmailPreview } from './LinkTools';

// The preview the assistant builds when someone asks it to save an email as a template. Nothing is saved until "Save template" is pressed. Then the new
// template (and any new links in it) is saved for the whole sales team, and it can be picked from "Start from a saved email" in any email window.
export default function TemplatePreview({ proposal }: { proposal: TemplateProposal }) {
  const [state, setState] = useState<'idle' | 'saving' | 'done' | 'cancelled'>('idle');
  const [made, setMade] = useState<{ name: string; linksAdded: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setState('saving'); setError(null);
    try {
      setMade(await apiPost('/ai/template/confirm', { name: proposal.name, subject: proposal.subject, body: proposal.body, newLinks: proposal.newLinks }));
      clearApiCache(); setState('done');
    } catch (e) { setError((e as Error).message); setState('idle'); }   // nothing was saved, so it can be pressed again
  }
  return (
    <div style={{ marginTop: 10, border: '1px solid var(--line)', borderRadius: 6, background: '#fff', color: '#111' }}>
      <div style={{ padding: '8px 10px', fontWeight: 600 }}>New email template: {proposal.name} <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 12.5 }}>how it looks for a made-up customer</span></div>
      <div style={{ padding: '0 10px 8px' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{proposal.preview.subject}</div>
        <EmailPreview text={proposal.preview.body} />
      </div>
      {proposal.newLinks.length > 0 && (
        <div style={{ padding: '0 10px 8px', fontSize: 13 }}>
          These links will also be saved on the Links tab: {proposal.newLinks.map(l => <span key={l.name} title={l.url}><b>{l.name}</b> </span>)}
        </div>
      )}
      {error && <div className="save-msg err" role="alert" style={{ margin: '0 10px 8px' }}>{error}</div>}
      <div style={{ padding: '8px 10px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {state === 'done' && made ? (
          <span role="status">Saved "{made.name}". <Link className="order-link" to="/sales-tools">See it in Sales Tools</Link>{made.linksAdded.length ? `, with ${made.linksAdded.length} new link${made.linksAdded.length === 1 ? '' : 's'}` : ''}.</span>
        ) : state === 'cancelled' ? <span className="acct-region">Not saved.</span> : (
          <>
            <button type="button" className="btn" disabled={state === 'saving'} onClick={save}>{state === 'saving' ? 'Saving…' : 'Save template'}</button>
            <button type="button" className="btn secondary" disabled={state === 'saving'} onClick={() => setState('cancelled')}>Don't save</button>
            <span className="acct-region" style={{ fontSize: 12.5 }}>Nothing is saved until you press Save template.</span>
          </>
        )}
      </div>
    </div>
  );
}
