import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Scans product barcodes with the device's camera. It stays open, so a rep can scan one product after another: each scan calls `onScan(code)`, which
// answers with a line to show ("Added: Bunny small, now 12") or a problem. A code counts once while it stays in view: it counts again only after the
// camera has lost it for 1.5 seconds (the box was taken away and shown again), so a rep who pauses on a box does not get it twice. Chrome and Edge (and Android) have a barcode reader built in; Safari on iPhone does not, so a small library does it there.
// A USB or Bluetooth scanner needs none of this: it types into the product search box.
export const scannerAvailable = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
const GONE_MS = 1500;   // how long a code must be out of view before showing it again counts again

type Result = { ok: boolean; text: string };
function beep() {
  try {
    const C = window.AudioContext ?? (window as any).webkitAudioContext, ctx = new C(), o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 1100; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.09); setTimeout(() => void ctx.close(), 250);
  } catch { /* no sound is fine */ }
  try { navigator.vibrate?.(60); } catch { /* and no buzz */ }
}

export default function BarcodeScanner({ onScan, onClose }: { onScan: (code: string) => Promise<Result>; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<Result | null>(null);
  const [count, setCount] = useState(0);
  const handler = useRef(onScan); handler.current = onScan;

  useEffect(() => {
    let stopped = false, stream: MediaStream | null = null, timer = 0, controls: { stop(): void } | null = null;
    const seen = new Map<string, number>();
    async function got(code: string) {
      const now = Date.now(), before = seen.get(code) ?? 0;
      seen.set(code, now);   // every sighting refreshes it, so a code that stays in view never counts twice
      if (now - before < GONE_MS) return;
      beep();
      const r = await handler.current(code).catch(e => ({ ok: false, text: e instanceof Error ? e.message : String(e) }));
      if (stopped) return;
      setLast(r); if (r.ok) setCount(n => n + 1);
    }
    async function start() {
      try {
        const Native = (window as any).BarcodeDetector;
        if (Native) {
          const detector = new Native({ formats: FORMATS });
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
          if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
          const v = video.current!; v.srcObject = stream; await v.play().catch(() => undefined);
          const tick = async () => {
            if (stopped) return;
            try { const found: { rawValue: string }[] = await detector.detect(v); if (found[0]?.rawValue) await got(found[0].rawValue); } catch { /* a frame that cannot be read is skipped */ }
            timer = window.setTimeout(tick, 150);
          };
          void tick();
        } else {
          // the library is loaded only when it is needed, so it is not downloaded by everyone
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          const { BarcodeFormat, DecodeHintType } = await import('@zxing/library');
          const hints = new Map<unknown, unknown>([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF]]]);
          const reader = new BrowserMultiFormatReader(hints as any, { delayBetweenScanAttempts: 150 });
          const c = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, video.current!, r => { if (r) void got(r.getText()); });
          if (stopped) c.stop(); else controls = c;
        }
      } catch (e) {
        if (stopped) return;
        const name = e instanceof DOMException ? e.name : '';
        setError(name === 'NotAllowedError' || name === 'SecurityError' ? 'The camera is blocked. Allow the camera for this site in the browser (the camera icon next to the address), then try again.'
          : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No camera was found on this device.' : name === 'NotReadableError' ? 'The camera is being used by another app. Close it and try again.' : "Couldn't open the camera.");
      }
    }
    void start();
    // Always switch the camera off when the window closes, or its light stays on.
    return () => { stopped = true; window.clearTimeout(timer); controls?.stop(); stream?.getTracks().forEach(t => t.stop()); const v = video.current; if (v?.srcObject) { (v.srcObject as MediaStream).getTracks().forEach(t => t.stop()); v.srcObject = null; } };
  }, []);

  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [onClose]);

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-label="Scan barcodes" onClick={e => e.stopPropagation()} style={{ maxWidth: 640, width: '92vw' }}>
        {error ? <div className="save-msg err" role="alert">{error}</div>
          : <div style={{ position: 'relative' }}>
              <video ref={video} playsInline muted autoPlay style={{ width: '100%', maxHeight: '55vh', background: '#000', borderRadius: 6, display: 'block', objectFit: 'cover' }} />
              <div aria-hidden="true" style={{ position: 'absolute', left: '12%', right: '12%', top: '40%', height: '20%', border: '2px solid rgba(255,255,255,0.85)', borderRadius: 6, pointerEvents: 'none' }} />
            </div>}
        <div role="status" aria-live="polite" style={{ marginTop: 10, minHeight: 44, fontSize: 15, color: last ? (last.ok ? 'var(--teal)' : 'var(--rust)') : 'var(--muted)' }}>
          {last ? last.text : error ? '' : 'Point the camera at a barcode. Keep scanning: it stays open.'}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button type="button" className="btn" onClick={onClose}>Done{count ? ` (${count} scanned)` : ''}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
