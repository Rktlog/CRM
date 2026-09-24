export function normalize(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^zz\(closed\)\s*/i, '')
    .replace(/^\(closed\)\s*/i, '')
    .replace(/\s+/g, ' ');
}
