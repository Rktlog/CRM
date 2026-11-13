import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { EVENT_PRIMARY, GIVEAWAY_PRIMARY, OUTCOME_LABEL, STAGE_LABEL, changeText, day, dayShort, msg, num, todayMel, usePeriodParams, type Account, type EdmPage, type EdmRow, type Gift, type IgPage, type ImportResult, type Init, type InitOut, type InitPage, type Outcome } from '../lib/mkt';
import { LightPill, MetricTable, PeriodPicker } from '../components/MktBits';

// The four detail pages of the marketing dashboard (managers only): EDMs, events, Instagram and giveaways. Each reads against its goal, and against the last comparable run.
const small: CSSProperties = { padding: '3px 10px', fontSize: 12.5 };
const input: CSSProperties = { padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 3, font: 'inherit', fontSize: 13 };
const lab: CSSProperties = { display: 'grid', gap: 2 };

function usePage<T>(path: string, query: string) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => apiGet(`${path}${query}`, { fresh: true }).then((d: T) => { setData(d); setError(null); }).catch((e: unknown) => setError(msg(e))), [path, query]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, load };
}
function Shell({ title, intro, children, query, period, from, to, set, error }: { title: string; intro: string; children: ReactNode; query: string; period: IgPage['period'] | null; from: string; to: string; set: (f: string, t: string) => void; error: string | null }) {
  return (
    <>
      <Link className="back-link" to={`/marketing-dashboard${query}`}>&larr; Marketing Dashboard</Link>
      <h1 style={{ marginTop: 4 }}>{title}</h1>
      <div className="acct-region" style={{ maxWidth: 780 }}>{intro}</div>
      {error && <div className="save-msg err" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      <PeriodPicker period={period} from={from} to={to} onChange={set} />
      {children}
    </>
  );
}
const Tile = ({ label, cur, prev, money }: { label: string; cur: number; prev: number; money?: boolean }) => {
  const ch = prev === 0 ? null : Math.round(((cur - prev) / prev) * 100);
  return <div className="card" style={{ margin: 0, minWidth: 130 }}><div className="acct-region">{label}</div><div style={{ fontSize: 24, fontWeight: 700 }}>{num(cur, money)}</div><div className="acct-region" style={{ fontSize: 12 }}>previous {num(prev, money)}{ch !== null ? ` (${changeText(ch)})` : ''}</div></div>;
};

// ---------- EDMs ----------
function Edm() {
  const { query, from, to, set } = usePeriodParams(); const { data, error, load } = usePage<EdmPage>('/mkt/edm', query);
  const [busy, setBusy] = useState(false); const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  async function refresh() {
    setBusy(true); setNote(null);
    try { const r: { campaigns: number; clickRefreshes: number; stopped: string | null } = await apiPost('/mkt/mailchimp/sync', {}); setNote({ ok: !r.stopped, text: r.stopped ? `Stopped: ${r.stopped}.` : `Read ${r.campaigns} campaigns from Mailchimp, and the clicks on ${r.clickRefreshes} of them.` }); await load(); }
    catch (e) { setNote({ ok: false, text: msg(e) }); } finally { setBusy(false); }
  }
  const t = data?.totals;
  return (
    <Shell title="EDMs" intro="One row for each Mailchimp campaign. Radar only reads Mailchimp: it never sends, changes or deletes anything there. Sales and carts are credited to a campaign when the customer clicked it within a few days before ordering (or leaving the cart); if they clicked more than one, the last click gets the credit." {...{ query, from, to, set, error }} period={data?.period ?? null}>
      {data && (
        <>
          <div className="card">
            <h3>Mailchimp</h3>
            {!data.mailchimp.configured
              ? <div className="acct-region">Mailchimp is not connected yet. Add MAILCHIMP_API_KEY to the API (a read-only key made under a dedicated Mailchimp user is best) and the campaigns appear here.</div>
              : <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`pill ${data.mailchimp.ok === false ? 'rust' : data.mailchimp.at ? 'teal' : 'neutral'}`}>{data.mailchimp.ok === false ? 'Last read failed' : data.mailchimp.at ? 'Connected' : 'Not read yet'}</span>
                  <span className="acct-region">{data.mailchimp.at ? `Last read ${new Date(data.mailchimp.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}${data.mailchimp.campaigns != null ? `, ${data.mailchimp.campaigns} campaigns` : ''}.` : 'It has not been read yet.'}{data.mailchimp.error ? ` ${data.mailchimp.error}` : ''}</span>
                  <button type="button" className="btn secondary" style={small} disabled={busy} onClick={refresh}>{busy ? 'Reading…' : 'Refresh from Mailchimp'}</button>
                </div>}
            {note && <div className={note.ok ? 'save-msg ok' : 'save-msg err'} role={note.ok ? 'status' : 'alert'} style={{ marginTop: 6 }}>{note.text}</div>}
          </div>
          <div className="card">
            <h3>Goal for every campaign</h3>
            <div className="acct-region" style={{ marginBottom: 6 }}>Goal applied to: sales (orders credited to a campaign within {data.attributionDays} days of a click). Edit it here; a different manager approves the change.</div>
            <MetricTable cells={data.goals} kind="edm" onChanged={load} />
          </div>
          {t && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              <Tile label="Campaigns sent" cur={t.current.campaigns} prev={t.previous.campaigns} /><Tile label="Sent to" cur={t.current.sent} prev={t.previous.sent} /><Tile label="Opens" cur={t.current.opens} prev={t.previous.opens} /><Tile label="Clicks" cur={t.current.clicks} prev={t.previous.clicks} />
              <Tile label="Carts left behind" cur={t.current.carts} prev={t.previous.carts} /><Tile label="Sales (orders)" cur={t.current.sales} prev={t.previous.sales} /><Tile label="Sales value" cur={t.current.salesValue} prev={t.previous.salesValue} money />
            </div>
          )}
          {t && t.current.sales > 0 && <div className="acct-region" style={{ marginBottom: 10 }}>Who ordered: {t.current.byTag.new} new, {t.current.byTag.existing} existing, {t.current.byTag.reactivated} reactivated stockists.</div>}
          <div className="card">
            <h3>Campaigns <span className="acct-region">{data.rows.length}</span></h3>
            {data.rows.length === 0 && <div className="acct-region">No campaigns were sent in this period.</div>}
            <div className="table-scroll">
              <table style={{ width: '100%', fontSize: 13.5 }}>
                <thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}><th>Campaign</th><th>Date sent</th><th>Sent to (segment)</th><th>Opens (total)</th><th title="Radar only sees carts that were left behind, not every cart">Carts left behind</th><th>Clicks (total)</th><th>Sale</th></tr></thead>
                <tbody>
                  {data.rows.map((r: EdmRow) => {
                    const sales = r.cells.find(c => c.metric === 'sales')!, clicks = r.cells.find(c => c.metric === 'clicks')!, carts = r.cells.find(c => c.metric === 'carts')!;
                    return (
                      <tr key={r.id} style={{ borderTop: '1px solid var(--line)', verticalAlign: 'top' }}>
                        <td style={{ padding: '6px 8px 6px 0' }}><b>{r.name}</b>{r.prevName && <div className="acct-region" style={{ fontSize: 11.5 }}>compared with {r.prevName}</div>}</td>
                        <td>{day(r.date)}{r.status === 'scheduled' && <div><span className="pill neutral">Scheduled</span></div>}</td>
                        <td>{r.list ?? ''}{r.segment ? <div className="acct-region" style={{ fontSize: 12 }}>{r.segment}</div> : null}{r.sent ? <div className="acct-region" style={{ fontSize: 12 }}>{num(r.sent)} sent</div> : null}</td>
                        <td>{r.status === 'scheduled' ? '–' : num(r.opens)}</td>
                        <td>{r.status === 'scheduled' ? '–' : <>{num(r.carts)}{carts.goal !== null && <> <LightPill light={carts.light} text="" /></>}{carts.prev !== null && <div className="acct-region" style={{ fontSize: 11.5 }}>previous {num(carts.prev)}{carts.goal !== null ? `, goal ${num(carts.goal)}` : ''}</div>}</>}</td>
                        <td>{r.status === 'scheduled' ? '–' : <>{num(r.clicks)}{clicks.goal !== null && <> <LightPill light={clicks.light} text="" /></>}{clicks.prev !== null && <div className="acct-region" style={{ fontSize: 11.5 }}>previous {num(clicks.prev)}{clicks.goal !== null ? `, goal ${num(clicks.goal)}` : ''}</div>}</>}</td>
                        <td>
                          {r.status === 'scheduled' ? '–' : (
                            <>
                              <b>{num(r.sales)}</b> orders, {num(r.salesValue, true)}{' '}{sales.goal !== null ? <LightPill light={sales.light} text={`goal ${num(sales.goal)}`} /> : <span className="acct-region">no goal</span>}
                              <div className="acct-region" style={{ fontSize: 11.5 }}>{sales.prev !== null ? `previous ${num(sales.prev)}` : 'no earlier campaign'}{r.sales > 0 ? ` · ${r.byTag.new} new, ${r.byTag.existing} existing, ${r.byTag.reactivated} reactivated` : ''}</div>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}

// ---------- events and giveaways ----------
function InitForm({ kind, init, onDone, onCancel }: { kind: 'event' | 'giveaway'; init?: Init; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: init?.name ?? '', series: init?.series ?? '', outcome: (init?.outcome ?? 'sales') as Outcome, startsOn: init?.startsOn ?? todayMel(), endsOn: init?.endsOn ?? '', venue: init?.venue ?? '', postUrl: init?.postUrl ?? '', notes: init?.notes ?? '', primaryMetric: init?.primaryMetric ?? (kind === 'event' ? 'new_customers' : 'entries') });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function save() {
    setBusy(true); setError(null);
    const body = { ...f, endsOn: f.endsOn || null, series: f.series || null, venue: f.venue || null, postUrl: f.postUrl || null, notes: f.notes || null };
    try { if (init) await apiPatch(`/mkt/initiatives/${init.id}`, body); else await apiPost('/mkt/initiatives', { kind, ...body }); onDone(); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <h3>{init ? `Change ${init.name}` : kind === 'event' ? 'Add an event' : 'Add a giveaway'}</h3>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label className="acct-region" style={{ ...lab, flex: '2 1 220px' }}>Name<input aria-label="Name" value={f.name} onChange={set('name')} style={input} /></label>
        <label className="acct-region" style={{ ...lab, flex: '1 1 160px' }} title="Runs that can be compared share a series, for example the same show each year">Series (to compare runs)<input aria-label="Series" value={f.series} onChange={set('series')} placeholder="e.g. Life Instyle" style={input} /></label>
        <label className="acct-region" style={lab}>Starts<input type="date" aria-label="Starts" value={f.startsOn} onChange={set('startsOn')} style={input} /></label>
        <label className="acct-region" style={lab}>Ends (empty = one day)<input type="date" aria-label="Ends" value={f.endsOn} onChange={set('endsOn')} style={input} /></label>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {kind === 'event' && <label className="acct-region" style={{ ...lab, flex: '1 1 200px' }}>Venue<input aria-label="Venue" value={f.venue} onChange={set('venue')} style={input} /></label>}
        {kind === 'giveaway' && <label className="acct-region" style={{ ...lab, flex: '2 1 280px' }}>Instagram post link (fills in entries and entrants from the imported post stats)<input aria-label="Instagram post link" value={f.postUrl} onChange={set('postUrl')} placeholder="https://www.instagram.com/p/..." style={input} /></label>}
        <label className="acct-region" style={lab}>Serves<select aria-label="Serves" value={f.outcome} onChange={set('outcome')} style={input}>{(Object.keys(OUTCOME_LABEL) as Outcome[]).map(o => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}</select></label>
        <label className="acct-region" style={lab} title="The number that decides its colour on the overview">Judged on<select aria-label="Judged on" value={f.primaryMetric} onChange={set('primaryMetric')} style={input}>{(kind === 'event' ? EVENT_PRIMARY : GIVEAWAY_PRIMARY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" className="btn" style={small} disabled={busy} onClick={save}>{busy ? 'Saving…' : init ? 'Save changes' : 'Add'}</button>
        <button type="button" className="btn secondary" style={small} disabled={busy} onClick={onCancel}>Cancel</button>
        {error && <span className="save-msg err" role="alert">{error}</span>}
      </div>
    </div>
  );
}
function InitCard({ o, kind, onChanged }: { o: InitOut; kind: 'event' | 'giveaway'; onChanged: () => void }) {
  const [editing, setEditing] = useState(false), [error, setError] = useState<string | null>(null);
  const i = o.init;
  async function remove() {
    if (!window.confirm(`Delete ${i.name}? Its numbers and goals go with it.`)) return;
    try { await apiDelete(`/mkt/initiatives/${i.id}`); onChanged(); } catch (e) { setError(msg(e)); }
  }
  if (editing) return <InitForm kind={kind} init={i} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />;
  return (
    <div className="card" aria-label={i.name}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>{i.name}</h3>
        <span className="acct-region">{dayShort(i.startsOn)}{i.endsOn ? ` to ${dayShort(i.endsOn)}` : ''}{i.venue ? `, ${i.venue}` : ''} · serves {OUTCOME_LABEL[i.outcome]}</span>
        <LightPill light={o.primary} />
        <span style={{ flex: 1 }} />
        <button type="button" className="link-btn" onClick={() => setEditing(true)}>Change</button>
        <button type="button" className="link-btn" onClick={remove} style={{ color: 'var(--rust)' }}>Delete</button>
      </div>
      <div className="acct-region" style={{ marginBottom: 6 }}>{o.prevName ? `Previous run for comparison: ${o.prevName}.` : 'No earlier run to compare with.'}{o.waitingForResults ? ' It is over and no results have been entered yet.' : ''}{i.postUrl ? ` Post: ${i.postUrl}` : ''}</div>
      {error && <div className="save-msg err" role="alert">{error}</div>}
      {kind === 'event'
        ? (['pre', 'at', 'post'] as const).map(s => <div key={s} style={{ marginBottom: 8 }}><div style={{ fontWeight: 600, margin: '6px 0 2px' }}>{STAGE_LABEL[s]}</div><MetricTable cells={o.cells.filter(c => c.stage === s)} kind="event" initiativeId={i.id} onChanged={onChanged} /></div>)
        : <MetricTable cells={o.cells} kind="giveaway" initiativeId={i.id} onChanged={onChanged} />}
      {i.notes && <div className="acct-region" style={{ marginTop: 6 }}>{i.notes}</div>}
    </div>
  );
}
function Initiatives({ kind }: { kind: 'event' | 'giveaway' }) {
  const { query, from, to, set } = usePeriodParams(); const { data, error, load } = usePage<InitPage>(kind === 'event' ? '/mkt/events' : '/mkt/giveaways', query);
  const [adding, setAdding] = useState(false);
  return (
    <Shell title={kind === 'event' ? 'Trade shows and events' : 'Giveaways'} intro={kind === 'event' ? 'Each event is tracked in three stages: before, at and after. Type the numbers in as you get them; each reads against its goal and the last run of the same show.' : 'One card for each giveaway. If you give the Instagram post it ran on, the entries (comments), entrants (likes) and profile activity fill in from the imported post stats. Type in the prize value.'} {...{ query, from, to, set, error }} period={data?.period ?? null}>
      <div style={{ margin: '0 0 12px' }}><button type="button" className="btn" disabled={adding} onClick={() => setAdding(true)}>{kind === 'event' ? '+ Add event' : '+ Add giveaway'}</button></div>
      {adding && <InitForm kind={kind} onDone={() => { setAdding(false); void load(); }} onCancel={() => setAdding(false)} />}
      {data && data.items.length === 0 && !adding && <div className="acct-region">{kind === 'event' ? 'No events in this period.' : 'No giveaways in this period.'}</div>}
      {data?.items.map(o => <InitCard key={o.init.id} o={o} kind={kind} onChanged={load} />)}
      {data && data.upcoming.length > 0 && <><h2 style={{ marginTop: 18 }}>Coming up</h2>{data.upcoming.map(o => <InitCard key={o.init.id} o={o} kind={kind} onChanged={load} />)}</>}
    </Shell>
  );
}

// ---------- Instagram ----------
function ImportBox({ onDone }: { onDone: () => void }) {
  const [metric, setMetric] = useState('reach'); const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null); const [busy, setBusy] = useState(false);
  async function go(kind: 'posts' | 'daily', file: File | undefined) {
    if (!file) return; setBusy(true); setNote(null);
    try {
      const csv = await file.text();
      if (csv.length > 90_000) throw new Error('That file is too big to import at once. Import a month at a time.');
      const r: ImportResult = await apiPost(kind === 'posts' ? '/mkt/instagram/import-posts' : '/mkt/instagram/import-daily', kind === 'posts' ? { csv } : { csv, metric });
      setNote({ ok: true, text: `${r.added} added, ${r.updated} updated${r.from ? `, ${day(r.from)} to ${day(r.to ?? r.from)}` : ''}.${r.problems.length ? ` Skipped: ${r.problems.join(' ')}` : ''}` }); onDone();
    } catch (e) { setNote({ ok: false, text: msg(e) }); } finally { setBusy(false); }
  }
  return (
    <div className="card">
      <h3>Import Meta's reports</h3>
      <div className="acct-region" style={{ marginBottom: 8 }}>Once a month, export the reports from Meta Business Suite as CSV files and import them here. Importing the same month again just updates it. Dates written with slashes are read day first. Radar never connects to Instagram itself.</div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <label className="acct-region" style={lab}>Posts report (one row per post)<input type="file" accept=".csv,text/csv,text/plain" aria-label="Posts report file" disabled={busy} onChange={e => { void go('posts', e.target.files?.[0]); e.target.value = ''; }} /></label>
        <div style={{ display: 'grid', gap: 2 }}>
          <label className="acct-region" style={lab}>Daily account report (one row per day)<input type="file" accept=".csv,text/csv,text/plain" aria-label="Daily report file" disabled={busy} onChange={e => { void go('daily', e.target.files?.[0]); e.target.value = ''; }} /></label>
          <label className="acct-region">If the file has only one number per day, it is: <select aria-label="What the daily file measures" value={metric} onChange={e => setMetric(e.target.value)} style={input}>{[['reach', 'Reach'], ['profile_visits', 'Profile visits'], ['followers_gained', 'Followers gained'], ['views', 'Views'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'], ['saves', 'Saves']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>
      </div>
      {note && <div className={note.ok ? 'save-msg ok' : 'save-msg err'} role={note.ok ? 'status' : 'alert'} style={{ marginTop: 8 }}>{note.text}</div>}
    </div>
  );
}
function GiftLog({ gifts, onChanged }: { gifts: Gift[]; onChanged: () => void }) {
  const blank = { kind: 'influencer', name: '', handle: '', giftedOn: todayMel(), qty: '1', likes: '0', comments: '0', shares: '0' };
  const [f, setF] = useState(blank); const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function add() { setError(null); try { await apiPost('/mkt/instagram/gifts', f); setF({ ...blank, kind: f.kind }); onChanged(); } catch (e) { setError(msg(e)); } }
  async function del(id: string) { try { await apiDelete(`/mkt/instagram/gifts/${id}`); onChanged(); } catch (e) { setError(msg(e)); } }
  return (
    <div className="card">
      <h3>Gifting log <span className="acct-region">{gifts.length} in this period</span></h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginBottom: 8 }}>
        <label className="acct-region" style={lab}>Who<select aria-label="Gift type" value={f.kind} onChange={set('kind')} style={input}><option value="influencer">Influencer</option><option value="horeca">HORECA venue</option></select></label>
        <label className="acct-region" style={lab}>Name<input aria-label="Gift name" value={f.name} onChange={set('name')} style={{ ...input, width: 150 }} /></label>
        <label className="acct-region" style={lab}>Handle<input aria-label="Gift handle" value={f.handle} onChange={set('handle')} style={{ ...input, width: 120 }} /></label>
        <label className="acct-region" style={lab}>Gifted on<input type="date" aria-label="Gifted on" value={f.giftedOn} onChange={set('giftedOn')} style={input} /></label>
        {(['qty', 'likes', 'comments', 'shares'] as const).map(k => <label key={k} className="acct-region" style={lab}>{k === 'qty' ? 'Qty gifted' : k[0]!.toUpperCase() + k.slice(1)}<input aria-label={`Gift ${k}`} inputMode="numeric" value={f[k]} onChange={set(k)} style={{ ...input, width: 70 }} /></label>)}
        <button type="button" className="btn" style={small} onClick={add}>Add</button>
      </div>
      {error && <div className="save-msg err" role="alert">{error}</div>}
      {gifts.length > 0 && <div className="table-scroll"><table style={{ width: '100%', fontSize: 13.5 }}><thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}><th>Who</th><th>Gifted</th><th>Qty</th><th>Likes</th><th>Comments</th><th>Shares</th><th /></tr></thead><tbody>
        {gifts.map(g => <tr key={g.id} style={{ borderTop: '1px solid var(--line)' }}><td style={{ padding: '4px 8px 4px 0' }}>{g.name}{g.handle ? ` ${g.handle}` : ''} <span className="pill neutral">{g.kind === 'horeca' ? 'HORECA' : 'Influencer'}</span></td><td>{day(g.giftedOn)}</td><td>{g.qty}</td><td>{g.likes}</td><td>{g.comments}</td><td>{g.shares}</td><td><button type="button" className="link-btn" onClick={() => del(g.id)} aria-label={`Delete gift to ${g.name}`}>Delete</button></td></tr>)}
      </tbody></table></div>}
    </div>
  );
}
function AccountTiles({ a }: { a: { current: Account; previous: Account } }) {
  return <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
    <Tile label="Accounts reached" cur={a.current.reach} prev={a.previous.reach} /><Tile label="Profile visits" cur={a.current.profile_visits} prev={a.previous.profile_visits} /><Tile label="Followers gained" cur={a.current.followers_gained} prev={a.previous.followers_gained} /><Tile label="Views" cur={a.current.views} prev={a.previous.views} /><Tile label="Interactions" cur={a.current.interactions} prev={a.previous.interactions} />
  </div>;
}
function Instagram() {
  const { query, from, to, set } = usePeriodParams(); const { data, error, load } = usePage<IgPage>('/mkt/instagram', query);
  const [post, setPost] = useState({ postedAt: todayMel(), status: 'scheduled', kind: '', caption: '' }); const [perr, setPerr] = useState<string | null>(null);
  async function addPost() { setPerr(null); try { await apiPost('/mkt/instagram/posts', post); setPost({ ...post, caption: '' }); await load(); } catch (e) { setPerr(msg(e)); } }
  async function delPost(id: string) { try { await apiDelete(`/mkt/instagram/posts/${id}`); await load(); } catch (e) { setPerr(msg(e)); } }
  return (
    <Shell title="Instagram" intro="Account stats for the period, then three blocks: influencers, scheduled posts and HORECA. Goals are written per 30 days and scaled to the period you look at." {...{ query, from, to, set, error }} period={data?.period ?? null}>
      {data && (
        <>
          <ImportBox onDone={load} />
          <div className="acct-region" style={{ marginBottom: 8 }}>{data.import.dailyTo || data.import.postsTo ? `Imported so far: daily report to ${data.import.dailyTo ? day(data.import.dailyTo) : 'nothing yet'}, posts to ${data.import.postsTo ? day(data.import.postsTo) : 'nothing yet'}.` : 'Nothing has been imported yet.'}{data.account.current.daysWithData === 0 ? ' There is no daily data for this period, so the account numbers show 0.' : ''}</div>
          <AccountTiles a={data.account} />
          <div className="card"><h3>Influencers <span className="acct-region">{data.people.influencers} gifted in the period</span></h3><div className="acct-region" style={{ marginBottom: 4 }}>Averages per influencer, from the gifting log below.</div><MetricTable cells={data.blocks.influencers} kind="instagram" scope="influencers" onChanged={load} /></div>
          <div className="card"><h3>Scheduled posts</h3><div className="acct-region" style={{ marginBottom: 4 }}>From the imported post stats. Buffer is not connected: add upcoming posts by hand below and they show on the calendar.</div><MetricTable cells={data.blocks.scheduled} kind="instagram" scope="scheduled" onChanged={load} /></div>
          <div className="card"><h3>HORECA <span className="acct-region">{data.people.horeca} venues gifted in the period</span></h3><div className="acct-region" style={{ marginBottom: 4 }}>The same columns as influencers.</div><MetricTable cells={data.blocks.horeca} kind="instagram" scope="horeca" onChanged={load} /></div>
          <GiftLog gifts={data.gifts} onChanged={load} />
          <div className="card">
            <h3>Posts <span className="acct-region">{data.posts.length} in this period</span></h3>
            <div className="acct-region" style={{ marginBottom: 6 }}>Every post with its stats, so you can compare what works and what does not. Still open: link to Brittany's data collection method (to be added by Marketing).</div>
            {data.compare.byKind.length > 0 && <div style={{ marginBottom: 8 }}><b>What works:</b> {data.compare.byKind.map(k => `${k.kind}: ${num(k.avgInteractions)} interactions on average over ${k.posts} post${k.posts === 1 ? '' : 's'}${k.avgEngagement !== null ? ` (${k.avgEngagement}% of reach)` : ''}`).join('; ')}.</div>}
            {data.compare.best.length > 0 && <div className="acct-region" style={{ marginBottom: 2 }}>Best: {data.compare.best.map(p => `${dayShort(p.day)} ${p.kind ?? 'post'} (${num(p.interactions)})`).join(', ')}.</div>}
            {data.compare.weakest.length > 0 && <div className="acct-region" style={{ marginBottom: 8 }}>Weakest: {data.compare.weakest.map(p => `${dayShort(p.day)} ${p.kind ?? 'post'} (${num(p.interactions)})`).join(', ')}.</div>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginBottom: 8 }}>
              <label className="acct-region" style={lab}>Add a post<input type="date" aria-label="Post date" value={post.postedAt} onChange={e => setPost({ ...post, postedAt: e.target.value })} style={input} /></label>
              <label className="acct-region" style={lab}>Status<select aria-label="Post status" value={post.status} onChange={e => setPost({ ...post, status: e.target.value })} style={input}><option value="scheduled">Scheduled</option><option value="posted">Posted</option></select></label>
              <label className="acct-region" style={lab}>Type<input aria-label="Post type" value={post.kind} onChange={e => setPost({ ...post, kind: e.target.value })} placeholder="reel, photo" style={{ ...input, width: 100 }} /></label>
              <label className="acct-region" style={{ ...lab, flex: '1 1 220px' }}>What it is<input aria-label="Post caption" value={post.caption} onChange={e => setPost({ ...post, caption: e.target.value })} style={input} /></label>
              <button type="button" className="btn" style={small} onClick={addPost}>Add</button>
            </div>
            {perr && <div className="save-msg err" role="alert">{perr}</div>}
            {data.posts.length > 0 && <div className="table-scroll"><table style={{ width: '100%', fontSize: 13 }}><thead><tr style={{ textAlign: 'left', color: 'var(--muted)' }}><th>Date</th><th>Type</th><th>Post</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Reach</th><th>Profile activity</th><th>Interactions</th><th>Of reach</th><th /></tr></thead><tbody>
              {data.posts.map(p => <tr key={p.id} style={{ borderTop: '1px solid var(--line)' }}><td style={{ padding: '4px 6px 4px 0' }}>{dayShort(p.day)}{p.status === 'scheduled' && <> <span className="pill neutral">Scheduled</span></>}</td><td>{p.kind ?? ''}</td><td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.permalink ? <a className="order-link" href={p.permalink} target="_blank" rel="noopener noreferrer">{p.caption ?? 'Open post'}</a> : p.caption}</td><td>{p.likes ?? '–'}</td><td>{p.comments ?? '–'}</td><td>{p.shares ?? '–'}</td><td>{p.reach ?? '–'}</td><td>{p.profileActivity ?? '–'}</td><td><b>{num(p.interactions)}</b></td><td>{p.engagement === null ? '–' : `${p.engagement}%`}</td><td>{p.source === 'manual' && <button type="button" className="link-btn" onClick={() => delPost(p.id)} aria-label={`Delete post ${p.caption ?? ''}`}>Delete</button>}</td></tr>)}
            </tbody></table></div>}
            {data.upcoming.length > 0 && <div className="acct-region" style={{ marginTop: 8 }}>Scheduled to come: {data.upcoming.map(p => `${dayShort(p.day)} ${p.caption ?? p.kind ?? 'post'}`).join('; ')}.</div>}
          </div>
        </>
      )}
    </Shell>
  );
}

export default function MarketingFocus() {
  const { focus } = useParams();
  if (focus === 'edms') return <Edm />;
  if (focus === 'events') return <Initiatives kind="event" />;
  if (focus === 'giveaways') return <Initiatives kind="giveaway" />;
  if (focus === 'instagram') return <Instagram />;
  return <div className="empty-state">That page does not exist. <Link to="/marketing-dashboard" className="order-link">Back to the Marketing Dashboard</Link></div>;
}
