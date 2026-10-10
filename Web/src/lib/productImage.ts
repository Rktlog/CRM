// Turns a photo link from the team's sheet into one a browser can show as a picture.
// The stored link is never changed; this only decides what the screen loads.
//
//   Dropbox "share" links (...?dl=0) open a Dropbox web page, not the photo. Asking for
//   raw=1 instead makes Dropbox hand back the picture itself.
//   Google Drive "view" links are turned into its thumbnail link.
//   Anything else is used as it is.
export function directImageUrl(link: string | null | undefined): string | null {
  const raw = (link ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (/(^|\.)dropbox\.com$/i.test(u.hostname)) {
      u.searchParams.delete('dl');
      u.searchParams.set('raw', '1');
      return u.toString();
    }
    if (/(^|\.)drive\.google\.com$/i.test(u.hostname)) {
      const id = u.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ?? u.searchParams.get('id');
      if (id) return `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1000`;
    }
    return raw;
  } catch {
    return null;
  }
}