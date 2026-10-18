// How long it took, shown under each Conversion card and above the list of customers: the median days from the start to the
// order, how many ordered within 30, 60 and 90 days of starting, and (Prospects) where the wait went.
export type Timing = {
  medianDaysToOrder: number | null; averageDaysToOrder: number | null;
  within: { days: number; eligible: number; converted: number; pct: number | null }[];
  dear?: { knownSetup: number; medianDaysToDear: number | null; knownOrder: number; medianDaysDearToOrder: number | null };
  age?: { label: string; known: number; medianDays: number | null };
};

const n = (v: number) => v.toLocaleString('en-AU');

export default function ConversionTiming({ timing }: { timing?: Timing }) {
  if (!timing) return null;   // an older API that does not send the days yet
  const { medianDaysToOrder: med, within, dear, age } = timing;
  return (
    <div style={{ marginTop: 8, display: 'grid', gap: 2 }}>
      <div className="acct-region" title={timing.averageDaysToOrder != null ? `Average ${n(timing.averageDaysToOrder)} days` : undefined}>
        {med !== null ? <><b>{n(med)} days</b> median to order</> : 'No order yet to time'}
      </div>
      <div className="acct-region" title="Of the customers who have had that long inside this period, the share who ordered within that many days of starting">
        Ordered within:{' '}
        {within.map((w, i) => (
          <span key={w.days} title={w.pct === null ? `Nobody has had ${w.days} days yet` : `${n(w.converted)} of ${n(w.eligible)} who have had ${w.days} days`}>
            {i > 0 ? ' · ' : ''}{w.days} days <b>{w.pct === null ? '–' : `${w.pct}%`}</b>
          </span>
        ))}
      </div>
      {dear && dear.knownSetup > 0 && (
        <div className="acct-region" title={`Known for ${n(dear.knownSetup)} prospects so far: the CRM records the day a customer is linked to DEAR from now on`}>
          Set up in DEAR after <b>{dear.medianDaysToDear !== null ? n(dear.medianDaysToDear) : '–'} days</b>
          {dear.knownOrder > 0 && dear.medianDaysDearToOrder !== null ? <>, then first order <b>{n(dear.medianDaysDearToOrder)} days</b> later</> : ''}
        </div>
      )}
      {age && age.known > 0 && age.medianDays !== null && <div className="acct-region">{age.label}: <b>{n(age.medianDays)}</b> median</div>}
    </div>
  );
}