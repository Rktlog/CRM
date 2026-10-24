import { fmtDate } from '../lib/types';
import { ACTIVITY_LABEL, ActivityKind } from '../lib/activityLabels';
import RemarksThread from './RemarksThread';

// The remarks on one Activity Log entry, in a window: the log for context, then the thread (see RemarksThread).
type Props = {
  activity: { id: string; accountName: string; type: ActivityKind; occurredAt: string; note: string; repName?: string | null };
  onChanged: () => void;
  onClose: () => void;
};

export default function ActivityRemarksModal({ activity, onChanged, onClose }: Props) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-label="Remarks" onClick={e => e.stopPropagation()} style={{ maxWidth: 600, width: '94vw', maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ marginBottom: 4 }}>Remarks</h3>
        <div className="acct-region" style={{ marginBottom: 6 }}>
          {activity.accountName} · {ACTIVITY_LABEL[activity.type] ?? activity.type} · {fmtDate(activity.occurredAt)}{activity.repName ? ` · ${activity.repName}` : ''}
        </div>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 6, padding: '8px 10px', marginBottom: 14, color: 'var(--ink-soft)', whiteSpace: 'pre-wrap' }}>{activity.note}</div>
        <RemarksThread kind="activity" id={activity.id} onChanged={onChanged} />
        <div className="modal-actions" style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" className="btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}