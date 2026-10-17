// Saving a chart the assistant drew: as the SVG itself, or as a picture (PNG) drawn from it in the browser.
const save = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export const chartName = (title: string) => (title.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'chart');
export const chartSrc = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
export const downloadSvg = (svg: string, title: string) => save(new Blob([svg], { type: 'image/svg+xml' }), `${chartName(title)}.svg`);
export function downloadPng(svg: string, title: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = 2, c = document.createElement('canvas'); c.width = (img.width || 800) * scale; c.height = (img.height || 440) * scale;
      const g = c.getContext('2d'); if (!g) return reject(new Error('This browser cannot make a picture of it'));
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => { if (!b) return reject(new Error('Could not make the picture')); save(b, `${chartName(title)}.png`); resolve(); }, 'image/png');
    };
    img.onerror = () => reject(new Error('Could not make the picture'));
    img.src = chartSrc(svg);
  });
}