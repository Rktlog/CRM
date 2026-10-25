import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import EmailThreadList, { type EmailThread } from './EmailThreadList';

// On an order: only the emails about THIS order (so nobody has to open the customer's account and search). An email is linked when it
// names the order number, or, for reps who switched on summaries, when Claude matched it to the order. Hidden if there are none.
export default function OrderEmails({ orderId }: { orderId: string }) {
  const [threads, setThreads] = useState<EmailThread[]>([]);
  const [number, setNumber] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setProblem(null);
    apiGet(`/gmail/order/${orderId}/emails`).then(d => { setThreads(d.threads ?? []); setNumber(d.orderNumber); })
      .catch((e: Error) => { setThreads([]); setProblem(e.message); });
  }, [orderId]);
  if (problem) return <div className="card"><h3>Emails about this order</h3><div className="acct-region">Could not load the emails: {problem}</div></div>;
  if (!threads.length) return null;
  return (
    <div className="card">
      <h3>Emails about this order</h3>
      <EmailThreadList threads={threads} hideOrder={number} />
    </div>
  );
}