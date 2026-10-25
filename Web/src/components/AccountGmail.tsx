import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import EmailThreadList, { type EmailThread } from './EmailThreadList';

// On an account: the emails between the team and this customer, as conversations, each with a one-line summary and the orders it is
// about. Hidden if there are none. If they cannot be loaded it says so and why, rather than quietly showing nothing.
export default function AccountGmail({ accountId }: { accountId: string }) {
  const [threads, setThreads] = useState<EmailThread[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setProblem(null);
    apiGet(`/gmail/account/${accountId}/emails`).then(d => setThreads(d.threads ?? [])).catch((e: Error) => { setThreads([]); setProblem(e.message); });
  }, [accountId]);
  if (problem) return <div className="card"><h3>Emails with them</h3><div className="acct-region">Could not load the emails: {problem}</div></div>;
  if (!threads.length) return null;
  return (
    <div className="card">
      <h3>Emails with them</h3>
      <EmailThreadList threads={threads} />
    </div>
  );
}