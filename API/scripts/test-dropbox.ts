// Tests the plain rules behind the Dropbox photos and videos: folder and file names, which files count as a photo or a video, and how the details of an upload are written for
// Dropbox. No database, no Dropbox, no internet.  Run:  npx tsx scripts/test-dropbox.ts
import { argHeader, authorizeUrl, folderName, fileParts, mediaKind, missingSetup, MAX_PHOTO, MAX_VIDEO } from '../src/lib/dropbox';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

console.log('--- customer folder names');
ok('a plain name stays as it is, with its accents', folderName('Anna Shop') === 'Anna Shop' && folderName('Café Élan') === 'Café Élan');
ok('characters Dropbox does not allow become spaces, and are tidied', folderName('A/B: C*D? "E" <F> |G\\H') === 'A B C D E F G H');
ok('dots and spaces on the end go (Dropbox refuses them), and so do dots at the start', folderName('Shop...') === 'Shop' && folderName('  Shop . ') === 'Shop' && folderName('.hidden') === 'hidden');
ok('a very long name is cut to 100 characters', folderName('x'.repeat(300)).length === 100 && !/[. ]$/.test(folderName('x'.repeat(99) + ' ' + 'y'.repeat(50))));
ok('nothing usable becomes "Customer"', folderName('') === 'Customer' && folderName(null) === 'Customer' && folderName('///') === 'Customer' && folderName('...') === 'Customer');
ok('line breaks and control characters become spaces', folderName('Shop\r\nBranch\u0007One') === 'Shop Branch One');

console.log('--- file names');
ok('the name and its extension are kept (the extension in lower case)', JSON.stringify(fileParts('Front Door.JPG', 'image/jpeg')) === '{"stem":"Front Door","ext":".jpg"}');
ok('a path in the name is dropped, and odd characters are made safe', JSON.stringify(fileParts('C:\\Users\\me\\a:b?.mp4', 'video/mp4')) === '{"stem":"a b","ext":".mp4"}' && JSON.stringify(fileParts('../../etc/passwd.png', 'image/png')) === '{"stem":"passwd","ext":".png"}');
ok('with no extension it is taken from the type', fileParts('IMG', 'image/heic').ext === '.heic' && fileParts('clip', 'video/quicktime').ext === '.mov' && fileParts('x', 'application/pdf').ext === '');
ok('with no name at all it is called "file"', fileParts('', 'image/jpeg').stem === 'file' && fileParts(undefined, 'image/jpeg').stem === 'file' && fileParts('.jpg', 'image/jpeg').stem === 'file');
ok('a very long name is cut to 60 characters', fileParts('x'.repeat(200) + '.jpg', 'image/jpeg').stem.length === 60);

console.log('--- photo or video');
ok('photo types and video types are told apart', mediaKind('image/jpeg', 'a.jpg')?.kind === 'photo' && mediaKind('video/mp4', 'a.mp4')?.kind === 'video' && mediaKind('video/quicktime', 'a.mov')?.kind === 'video' && mediaKind('image/heic', 'a.heic')?.kind === 'photo');
ok('the type is read without its extras and in any capitals', mediaKind('IMAGE/JPEG; charset=x', 'a')?.mime === 'image/jpeg');
ok('some phones give no type, so the extension is used', mediaKind('', 'IMG_1.MOV')?.kind === 'video' && mediaKind('application/octet-stream', 'IMG_1.HEIC')?.kind === 'photo' && mediaKind(undefined, 'a.jpeg')?.mime === 'image/jpeg');
ok('anything else is refused, whatever its name says', mediaKind('application/pdf', 'a.jpg') === null && mediaKind('text/html', 'a.mp4') === null && mediaKind('', 'a.exe') === null && mediaKind('', '') === null && mediaKind('image/svg+xml', 'a.svg') === null);
ok('the size limits are 30 MB for a photo and 250 MB for a video', MAX_PHOTO === 30 * 1048576 && MAX_VIDEO === 250 * 1048576);

console.log('--- the details of an upload, for Dropbox');
ok('plain characters are left alone', argHeader({ path: '/Customers/Anna Shop/a.jpg', mode: 'add' }) === '{"path":"/Customers/Anna Shop/a.jpg","mode":"add"}');
ok('anything beyond plain characters is written as \\uXXXX, so the header is safe and means the same thing', (() => { const h = argHeader({ path: '/Café ✓.jpg' }); return /^[\x20-\x7e]*$/.test(h) && JSON.parse(h).path === '/Café ✓.jpg'; })());
ok('emoji (two-part characters) survive too', (() => { const h = argHeader({ path: '/a😀.jpg' }); return /^[\x20-\x7e]*$/.test(h) && JSON.parse(h).path === '/a😀.jpg'; })());

console.log('--- the settings');
const keep = { k: process.env.DROPBOX_APP_KEY, s: process.env.DROPBOX_APP_SECRET, r: process.env.DROPBOX_REDIRECT_URI, p: process.env.PUBLIC_API_URL };
delete process.env.DROPBOX_APP_KEY; delete process.env.DROPBOX_APP_SECRET; delete process.env.DROPBOX_REDIRECT_URI; delete process.env.PUBLIC_API_URL;
ok('what is missing is named, so it can be added', missingSetup().join() === 'DROPBOX_APP_KEY,DROPBOX_APP_SECRET,PUBLIC_API_URL');
let refused = ''; try { authorizeUrl('s'); } catch (e) { refused = (e as Error).message; } ok('with nothing set, the sign-in link is refused in plain words', /not set up on the server yet/.test(refused));
process.env.DROPBOX_APP_KEY = 'key123'; process.env.DROPBOX_APP_SECRET = 'sec'; process.env.PUBLIC_API_URL = 'https://api.example.com/';
const u = new URL(authorizeUrl('state-1'));
ok('the sign-in link asks for a lasting sign-in, with the right address to come back to and the signed state', u.origin + u.pathname === 'https://www.dropbox.com/oauth2/authorize' && u.searchParams.get('client_id') === 'key123' && u.searchParams.get('response_type') === 'code' && u.searchParams.get('token_access_type') === 'offline' && u.searchParams.get('redirect_uri') === 'https://api.example.com/dropbox/callback' && u.searchParams.get('state') === 'state-1');
ok('the secret is never in the link', !authorizeUrl('s').includes('sec&') && !/client_secret/.test(authorizeUrl('s')));
process.env.DROPBOX_REDIRECT_URI = 'https://other.example.com/cb'; ok('a redirect address set by hand wins', new URL(authorizeUrl('s')).searchParams.get('redirect_uri') === 'https://other.example.com/cb');
for (const [k, v] of [['DROPBOX_APP_KEY', keep.k], ['DROPBOX_APP_SECRET', keep.s], ['DROPBOX_REDIRECT_URI', keep.r], ['PUBLIC_API_URL', keep.p]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
