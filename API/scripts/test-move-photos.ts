// Tests the plain rules behind moving old photos to Dropbox: which addresses may ever be downloaded (only this project's own public photo storage) and the name taken from one.
// No database, no Dropbox, no internet.  Run:  npx tsx scripts/test-move-photos.ts
import { MAX_TRIES, PER_RUN, ownPhotoUrl, sourceName } from '../src/lib/movePhotos';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const S = 'https://abcd1234.supabase.co';
const own = (u: unknown) => ownPhotoUrl(u, S) !== null;

console.log('--- which addresses may be downloaded');
ok('a public photo in this project\'s own storage is allowed', own(`${S}/storage/v1/object/public/Photo/visits/abc.jpg`) && own(`${S}/storage/v1/object/public/Photo/a%20b.png`));
ok('another web address is not, however much it looks like one', !own('https://evil.example.com/storage/v1/object/public/Photo/a.jpg') && !own('https://abcd1234.supabase.co.evil.com/storage/v1/object/public/Photo/a.jpg') && !own('https://evil.com/?https://abcd1234.supabase.co/storage/v1/object/public/x'));
ok('an address inside this project that is not public photo storage is not (the login service, the database, private storage)', !own(`${S}/auth/v1/user`) && !own(`${S}/rest/v1/accounts`) && !own(`${S}/storage/v1/object/authenticated/Photo/a.jpg`) && !own(`${S}/storage/v1/object/sign/Photo/a.jpg?token=x`) && !own(S));
ok('an address on this machine or the cloud\'s internal network is not', !own('http://127.0.0.1/storage/v1/object/public/Photo/a.jpg') && !own('http://169.254.169.254/latest/meta-data/') && !own('http://localhost:8080/storage/v1/object/public/Photo/a.jpg') && !own('http://10.0.0.5/storage/v1/object/public/Photo/a.jpg'));
ok('the same host on another scheme or port is not', !own('http://abcd1234.supabase.co/storage/v1/object/public/Photo/a.jpg') && !own('https://abcd1234.supabase.co:8443/storage/v1/object/public/Photo/a.jpg'));
ok('an address with a name and password in it is not', !own('https://user:pass@abcd1234.supabase.co/storage/v1/object/public/Photo/a.jpg') && !own('https://abcd1234.supabase.co@evil.com/storage/v1/object/public/Photo/a.jpg'));
ok('things that are not addresses at all are not', !own('') && !own('nonsense') && !own(null) && !own(undefined) && !own(42) && !own('javascript:alert(1)') && !own('file:///etc/passwd'));
ok('with no Supabase address set, nothing is allowed', ownPhotoUrl(`${S}/storage/v1/object/public/Photo/a.jpg`, undefined) === null && ownPhotoUrl(`${S}/storage/v1/object/public/Photo/a.jpg`, '') === null && ownPhotoUrl(`${S}/storage/v1/object/public/Photo/a.jpg`, 'not a url') === null);
ok('an address that climbs out of the photo folder with .. (or its encoded form) is read as what it really is, and refused', !own(`${S}/storage/v1/object/public/../../../auth/v1/user`) && !own(`${S}/storage/v1/object/public/%2e%2e/%2e%2e/%2e%2e/auth/v1/user`) && new URL(`${S}/storage/v1/object/public/../../../auth/v1/user`).pathname === '/storage/auth/v1/user' && new URL(`${S}/storage/v1/object/public/../../../../auth/v1/user`).pathname === '/auth/v1/user' && !own(`${S}/storage/v1/object/public/../../../../auth/v1/user`));
ok('a local test address works against itself (so the tests can use a fake store)', ownPhotoUrl('http://127.0.0.1:5000/storage/v1/object/public/Photo/a.jpg', 'http://127.0.0.1:5000') !== null && ownPhotoUrl('http://127.0.0.1:5001/storage/v1/object/public/Photo/a.jpg', 'http://127.0.0.1:5000') === null);

console.log('--- the name of the file');
ok('the name is the end of the address, with spaces and accents decoded', sourceName(new URL(`${S}/storage/v1/object/public/Photo/Caf%C3%A9%20display.jpg`)) === 'Café display.jpg' && sourceName(new URL(`${S}/storage/v1/object/public/Photo/visits/abc.jpg`)) === 'abc.jpg');
ok('a name that cannot be decoded is kept as it is, and a bare folder gives an empty name', sourceName(new URL(`${S}/storage/v1/object/public/Photo/%E0%A4%A.jpg`)) === '%E0%A4%A.jpg' && sourceName(new URL(`${S}/storage/v1/object/public/Photo/`)) === '');
ok('the settings are 20 photos a run and three tries', PER_RUN === 20 && MAX_TRIES === 3);
console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
