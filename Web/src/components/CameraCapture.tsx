import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// "Take photo": opens the device's camera in a small window, shows what it sees, and hands back a JPEG file when the person presses Capture.
// It exists for laptops and tablets, whose file pickers only offer files that are already on the device. (A phone's picker has a camera
// option of its own, and this works there too.) Nothing is sent anywhere here: the file goes to the same place a chosen file would.
// The button is not shown at all when the browser has no camera support (or the page is not on https), so nobody gets a button that cannot work.
export const cameraAvailable = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

const cameraProblem = (e: unknown) => {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The camera is blocked. Allow the camera for this site in the browser (the camera icon next to the address), then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.';
  if (name === 'NotReadableError') return 'The camera is being used by another app. Close it and try again.';
  return "Couldn't open the camera.";
};

function CameraWindow({ onCapture, onClose }: { onCapture: (file: File) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');   // the back camera first (a phone or tablet), the webcam if there is none

  useEffect(() => {
    let stopped = false;
    setReady(false); setError(null);
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(s => {
        if (stopped) { s.getTracks().forEach(t => t.stop()); return; }
        stream.current = s;
        if (video.current) { video.current.srcObject = s; void video.current.play().catch(() => undefined); }
      })
      .catch(e => { if (!stopped) setError(cameraProblem(e)); });
    // Always switch the camera off when the window closes or the camera is swapped, or its light stays on.
    return () => { stopped = true; stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; };
  }, [facing]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    canvas.toBlob(blob => {
      if (!blob) { setError("Couldn't take the photo. Try again."); return; }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      onCapture(new File([blob], `photo-${stamp}.jpg`, { type: 'image/jpeg' }));
      onClose();
    }, 'image/jpeg', 0.9);
  }

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-label="Take a photo" onClick={e => e.stopPropagation()} style={{ maxWidth: 720, width: '92vw' }}>
        {error
          ? <div className="save-msg err" role="alert">{error}</div>
          : <video ref={video} playsInline muted autoPlay onPlaying={() => setReady(true)}
              style={{ width: '100%', maxHeight: '65vh', background: '#000', borderRadius: 6, display: 'block', objectFit: 'contain', transform: facing === 'user' ? 'scaleX(-1)' : undefined }} />}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {!error && <button type="button" className="btn" disabled={!ready} onClick={capture}>{ready ? 'Capture' : 'Starting camera…'}</button>}
          {!error && <button type="button" className="btn secondary" onClick={() => setFacing(f => (f === 'environment' ? 'user' : 'environment'))}>Switch camera</button>}
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A "Take photo" button that opens the camera. Renders nothing where there is no camera support. */
export default function CameraButton({ onCapture, disabled, label = 'Take photo' }: { onCapture: (file: File) => void; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!cameraAvailable()) return null;
  return (
    <>
      <button type="button" className="btn secondary" disabled={disabled} onClick={() => setOpen(true)}>{label}</button>
      {open && <CameraWindow onCapture={onCapture} onClose={() => setOpen(false)} />}
    </>
  );
}
