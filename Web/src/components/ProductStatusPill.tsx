import { statusInfo } from '../lib/productStatus';

// The product's status as a small coloured tag. Nothing if it has none.
export default function ProductStatusPill({ status }: { status: string | null | undefined }) {
  const s = statusInfo(status);
  if (!s) return null;
  return <span className={`pill ${s.tone}`} title={s.meaning}>{s.label}</span>;
}