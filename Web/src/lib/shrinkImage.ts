// Makes a picture small enough to send quickly from a phone at a show: at most `maxDim` pixels on the long side, re-saved as JPEG.
// A payment screenshot stays readable at 1600 pixels; a 4 MB phone photo comes down to a few hundred KB.
export function shrinkImage(file: Blob, maxDim = 1600, quality = 0.82): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('This device cannot prepare the picture.'));
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);   // a transparent PNG becomes white, not black
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('The picture could not be prepared.'))), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a picture this browser can open.')); };
    img.src = url;
  });
}
export const blobToBase64 = (b: Blob): Promise<string> => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => no(new Error('The picture could not be read.')); r.readAsDataURL(b); });
