// Turns HTML entities in text into the characters they stand for: &rsquo; into ’, &bull; into •, &amp; into &, &#8217; and &#x2019;
// too. Text that was escaped twice (&amp;rsquo;) is done in two passes. An entity it does not know is left exactly as it was.
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·', dagger: '†', prime: '′', Prime: '″',
  trade: '™', reg: '®', copy: '©', deg: '°', plusmn: '±', times: '×', divide: '÷', micro: 'µ', para: '¶', sect: '§',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', euro: '€', pound: '£', cent: '¢', yen: '¥',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Auml: 'Ä', Aring: 'Å', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Ntilde: 'Ñ',
  Oacute: 'Ó', Ouml: 'Ö', Uacute: 'Ú', Uuml: 'Ü',
};

export function decodeEntities(s: string): string {
  let out = s;
  for (let pass = 0; pass < 3; pass++) {
    const next = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        // Real characters only: not control codes (except tab and line breaks), not surrogates, nothing beyond Unicode.
        return code === 9 || code === 10 || (code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && !(code >= 0x7f && code < 0xa0)) ? String.fromCodePoint(code) : m;
      }
      return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}