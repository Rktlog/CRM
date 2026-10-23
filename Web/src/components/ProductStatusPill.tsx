import { statusInfo, useProductStatuses } from '../lib/productStatus';

// The product's status as a small coloured tag. Nothing if it has none (or if it is one that has since been removed).
export default function ProductStatusPill({ status }: { status: string | null | undefined }) {
  useProductStatuses();   // so the tag redraws when the statuses arrive or a manager changes them
  const s = statusInfo(status);
  if (!s) return null;
  return <span className={`pill ${s.tone}`} title={s.meaning ?? undefined}>{s.label}</span>;
}