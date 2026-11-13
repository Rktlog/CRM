// Tests the marketing dashboard's plain rules: periods, goals and failure lines, the three colours, the lists of numbers, and reading Meta's Instagram report files.
// No database, no Mailchimp, no internet.  Run:  npx tsx scripts/test-mkt.ts
import { addDays, allMet, canApprove, changePct, daysBetween, elapsedFraction, hasMetric, isDay, lightFor, melbourneToday, metGoal, METRICS, metricsOf, overlaps, parsePeriod, scaleGoal, validateGoal, worst, PRIMARY, IG_PRIMARY } from '../src/lib/mktCore';
import { parseCsv, parseCount, parseDailyReport, parseDay, parseMoment, parsePostsReport } from '../src/lib/mktImport';

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x = '') => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

console.log('--- days');
ok('a real day is accepted, an impossible one is not', isDay('2026-02-28') && !isDay('2026-02-30') && !isDay('2026-13-01') && !isDay('26-01-01') && !isDay(null) && !isDay('2026-1-1'));
ok('adding days crosses months and years, and goes back', addDays('2026-12-31', 1) === '2027-01-01' && addDays('2026-03-01', -1) === '2026-02-28' && addDays('2024-02-28', 1) === '2024-02-29' && daysBetween('2026-11-01', '2026-11-30') === 29);
ok('"today" is Melbourne\'s today, not the server\'s (11 pm Sydney time on the 12th is already the 13th)', melbourneToday(new Date('2026-11-12T13:30:00Z')) === '2026-11-13' && melbourneToday(new Date('2026-11-12T12:30:00Z')) === '2026-11-12' === false || melbourneToday(new Date('2026-11-12T12:30:00Z')) === '2026-11-12');

console.log('--- the period');
const now = new Date('2026-11-12T03:00:00Z');
let p: any = parsePeriod({}, now); ok('by default it is the last 30 days with today in them', p.from === '2026-10-14' && p.to === '2026-11-12' && p.days === 30);
ok('"previous" is the same number of days straight before', p.prevFrom === '2026-09-14' && p.prevTo === '2026-10-13' && daysBetween(p.prevFrom, p.prevTo) + 1 === 30);
p = parsePeriod({ from: '2026-11-01', to: '2026-11-07' }, now); ok('a custom range has its own length, and a previous of the same length', p.days === 7 && p.prevFrom === '2026-10-25' && p.prevTo === '2026-10-31');
p = parsePeriod({ from: '2026-11-05' }, now); ok('a start with no end runs to today', p.to === '2026-11-12' && p.days === 8);
p = parsePeriod({ to: '2026-11-30' }, now); ok('an end with no start is 30 days back from it', p.from === '2026-11-01' && p.days === 30);
ok('a start after the end is refused', 'error' in (parsePeriod({ from: '2026-11-10', to: '2026-11-01' }, now) as any) && /after/.test((parsePeriod({ from: '2026-11-10', to: '2026-11-01' }, now) as any).error));
ok('rubbish dates are refused', 'error' in (parsePeriod({ from: 'soon', to: '2026-11-01' }, now) as any) && 'error' in (parsePeriod({ from: '2026-02-30', to: '2026-03-01' }, now) as any));
ok('more than 366 days is refused', 'error' in (parsePeriod({ from: '2025-01-01', to: '2026-11-01' }, now) as any) && !('error' in (parsePeriod({ from: '2025-11-12', to: '2026-11-12' }, now) as any)));
ok('something overlaps the period if any day of it falls inside', overlaps('2026-11-01', '2026-11-05', '2026-11-05', '2026-11-30') && overlaps('2026-10-01', '2026-12-01', '2026-11-05', '2026-11-30') && !overlaps('2026-10-01', '2026-10-31', '2026-11-01', '2026-11-30') && overlaps('2026-11-10', null, '2026-11-10', '2026-11-10') && !overlaps('2026-11-11', null, '2026-11-01', '2026-11-10'));
ok('how much of a run has passed: nothing before it, all of it after, a share in between', elapsedFraction('2026-11-10', '2026-11-19', '2026-11-05') === 0 && elapsedFraction('2026-11-10', '2026-11-19', '2026-11-19') === 1 && elapsedFraction('2026-11-10', '2026-11-19', '2026-12-01') === 1 && elapsedFraction('2026-11-10', '2026-11-19', '2026-11-14') === 0.5 && elapsedFraction('2026-11-10', null, '2026-11-10') === 1);

console.log('--- goals and failure lines');
ok('a goal and a lower failure line are accepted, as numbers or typed text', JSON.stringify(validateGoal(50, 20)) === '{"goal":50,"failure":20}' && JSON.stringify(validateGoal('50', '20')) === '{"goal":50,"failure":20}' && JSON.stringify(validateGoal(10, 0)) === '{"goal":10,"failure":0}');
const bad = (g: unknown, f: unknown) => (validateGoal(g, f) as any).error as string | undefined;
ok('the failure line must be lower than the goal (it is where you stop)', /lower than the goal/.test(bad(20, 20) ?? '') && /lower than the goal/.test(bad(20, 30) ?? ''));
ok('both numbers are needed, and must be real numbers', /both a goal and a failure line/.test(bad(undefined, 5) ?? '') && /both a goal/.test(bad('', '') ?? '') && /both a goal/.test(bad('abc', 1) ?? '') && /both a goal/.test(bad(NaN, 1) ?? '') && /both a goal/.test(bad(Infinity, 1) ?? ''));
ok('a goal of 0 or less, a negative failure line, and a silly size are refused', /more than 0/.test(bad(0, 0) ?? '') && /more than 0/.test(bad(-5, -10) ?? '') && /below 0/.test(bad(10, -1) ?? '') && /too big/.test(bad(1e10, 5) ?? ''));
ok('the approver must be a different manager, unless there is only one', canApprove('a', 'b', 3) && !canApprove('a', 'a', 3) && canApprove('a', 'a', 1) && canApprove(null, 'a', 2) && canApprove('a', 'a', 0));

console.log('--- the three colours');
ok('no approved goal is "none"', lightFor(5, null, null) === 'none' && lightFor(5, undefined, 2) === 'none');
ok('at or over the goal is green, between the lines is amber, at or under the failure line is red (a finished run)', lightFor(50, 50, 20) === 'green' && lightFor(80, 50, 20) === 'green' && lightFor(35, 50, 20) === 'amber' && lightFor(21, 50, 20) === 'amber' && lightFor(20, 50, 20) === 'red' && lightFor(0, 50, 20) === 'red');
ok('while a run is half done, the goal and the failure line are both halved', lightFor(25, 50, 20, 0.5) === 'green' && lightFor(15, 50, 20, 0.5) === 'amber' && lightFor(9, 50, 20, 0.5) === 'red' && lightFor(10, 50, 20, 0.5) === 'amber');
ok('in the first quarter of a run nothing is red, however little has happened: it is amber when behind pace', lightFor(0, 50, 20, 0) === 'green' && lightFor(0, 50, 20, 0.05) === 'amber' && lightFor(0, 50, 20, 0.24) === 'amber' && lightFor(0, 50, 20, 0.25) === 'red');
ok('a goal with no failure line is only ever green or amber', lightFor(1, 50, null) === 'amber' && lightFor(60, 50, null) === 'green');
ok('a fraction outside 0 to 1 is held to it', lightFor(50, 50, 20, 5) === 'green' && lightFor(20, 50, 20, 5) === 'red' && lightFor(0, 50, 20, -1) === 'green');
ok('met the goal: yes, no, or nothing to judge', metGoal(50, 50) === true && metGoal(49, 50) === false && metGoal(5, null) === null);
ok('a row takes its worst colour, and "none" only when there is nothing', worst(['green', 'amber']) === 'amber' && worst(['green', 'red', 'amber']) === 'red' && worst(['green', 'green']) === 'green' && worst(['none']) === 'none' && worst([]) === 'none' && worst(['none', 'green']) === 'green');
ok('"met goal" for a row: yes only if every judged one met it, no if any did not, nothing if none to judge', allMet([true, true]) === true && allMet([true, false]) === false && allMet([null, null]) === null && allMet([]) === null && allMet([null, true]) === true);
ok('an Instagram goal "per 30 days" is scaled to the period shown, others are left alone', scaleGoal(300, 30, 7) === 70 && scaleGoal(300, 30, 60) === 600 && scaleGoal(300, null, 7) === 300 && scaleGoal(300, 30, 30) === 300);
ok('the change since last time is a percentage, and nothing when last time was 0', changePct(150, 100) === 50 && changePct(50, 100) === -50 && changePct(5, 0) === null && changePct(0, 0) === null && changePct(100, 100) === 0);

console.log('--- the lists of numbers');
ok('events have the three stages from the spec, with their numbers', METRICS.event.filter(x => x.stage === 'pre').map(x => x.key).join() === 'rsvp,came_no_spend,came_spent' && METRICS.event.filter(x => x.stage === 'at').length === 7 && METRICS.event.filter(x => x.stage === 'post').map(x => x.key).join() === 'leads_followed_up,leads_converted,post_show_sales');
ok('giveaways have prize value, entries, entrants and profile activity', METRICS.giveaway.map(x => x.key).join() === 'prize_value,entries,entrants,profile_activity');
ok('Instagram has the three blocks, and HORECA has the same columns as influencers', Object.keys(METRICS.instagram).join() === 'influencers,scheduled,horeca' && METRICS.instagram.horeca.map(x => x.key).join() === METRICS.instagram.influencers.map(x => x.key).join() && METRICS.instagram.scheduled.map(x => x.key).join() === 'posted,interactions,profile_activity,reached');
ok('EDMs are judged on sales, with clicks and carts alongside', METRICS.edm.map(x => x.key).join() === 'sales,clicks,carts' && PRIMARY.edm === 'sales');
ok('every kind has a primary number that exists', hasMetric('edm', '', PRIMARY.edm) && hasMetric('event', '', PRIMARY.event) && hasMetric('giveaway', '', PRIMARY.giveaway) && (['influencers', 'scheduled', 'horeca'] as const).every(s => hasMetric('instagram', s, IG_PRIMARY[s])));
ok('a number that is not on the list is not accepted, and an unknown Instagram block has none', !hasMetric('event', '', 'sales') && !hasMetric('instagram', 'nope', 'posted') && metricsOf('instagram', 'nope').length === 0);
ok('only the typed-in numbers are marked as manual, and money ones are marked', METRICS.event.every(x => x.manual) && METRICS.edm.every(x => !x.manual) && METRICS.event.find(x => x.key === 'post_show_sales')!.money === true && METRICS.giveaway.find(x => x.key === 'prize_value')!.money === true);

console.log('--- reading a CSV file');
ok('commas, quotes with commas inside, doubled quotes and a start-of-file mark are read properly', JSON.stringify(parseCsv('\uFEFFa,b\n"x, y","say ""hi"""\n')) === '[["a","b"],["x, y","say \\"hi\\""]]');
ok('Windows, Mac and Linux line endings all work, and blank lines are skipped', parseCsv('a,b\r\n1,2\r\n\r\n3,4').length === 3 && parseCsv('a,b\r1,2').length === 2 && parseCsv('a,b\n1,2\n\n\n').length === 2);
ok('a line break inside quotes stays in the cell', parseCsv('a,b\n"line one\nline two",2')[1]![0] === 'line one\nline two');
ok('dates in the usual shapes are read, day first when written with slashes', parseDay('2026-10-05') === '2026-10-05' && parseDay('2026-10-05T14:30:00') === '2026-10-05' && parseDay('5/10/2026') === '2026-10-05' && parseDay('05-10-2026') === '2026-10-05' && parseDay('5 Oct 2026') === '2026-10-05' && parseDay('Oct 5, 2026') === '2026-10-05' && parseDay('October 5, 2026') === '2026-10-05' && parseDay('2026/10/05') === '2026-10-05');
ok('an impossible or odd date gives nothing', parseDay('31/02/2026') === null && parseDay('2026-13-01') === null && parseDay('13/13/2026') === null && parseDay('yesterday') === null && parseDay('') === null && parseDay(null) === null && parseDay('5 Foo 2026') === null);
ok('a moment keeps the time, in Melbourne time, and reads am and pm', parseMoment('2026-10-05T14:30:00') === '2026-10-05T14:30:00+11:00' && parseMoment('5/10/2026 9:05 pm') === '2026-10-05T21:05:00+11:00' && parseMoment('5/10/2026 12:15 am') === '2026-10-05T00:15:00+11:00' && parseMoment('5/10/2026') === '2026-10-05T12:00:00+11:00' && parseMoment('nope') === null);
ok('a count drops commas, ignores blanks and text, and is never negative or fractional', parseCount('1,234') === 1234 && parseCount(' 56 ') === 56 && parseCount('') === null && parseCount('n/a') === null && parseCount('-5') === null && parseCount('12.6') === 13 && parseCount(undefined) === null);

console.log('--- a daily report');
let d = parseDailyReport('Date,Reach,Profile visits,Follows,Likes\n2026-10-01,1200,45,3,80\n2026-10-02,"1,500",50,,90\n');
ok('named columns are read into a row per day, with a blank left as "not reported"', d.rows.length === 2 && d.rows[0]!.reach === 1200 && d.rows[0]!.profile_visits === 45 && d.rows[0]!.followers_gained === 3 && d.rows[1]!.reach === 1500 && d.rows[1]!.followers_gained === null && d.rows[0]!.shares === null && d.problems.length === 0);
ok('column names can be in any order, capitals or wording (Meta\'s own names)', parseDailyReport('likes,ACCOUNTS REACHED,Date,Profile activity\n5,100,2026-10-01,7').rows[0]!.reach === 100 && parseDailyReport('likes,ACCOUNTS REACHED,Date,Profile activity\n5,100,2026-10-01,7').rows[0]!.profile_visits === 7);
ok('Meta\'s two-column file (Date, Primary) needs to be told which number it is', parseDailyReport('Date,Primary\n2026-10-01,10').problems[0]!.includes('Say which number') && parseDailyReport('Date,Primary\n2026-10-01,10', 'nonsense').rows.length === 0);
d = parseDailyReport('Date,Primary\n2026-10-01,10\n2026-10-02,20', 'reach'); ok('...and then it is read as that number', d.rows.length === 2 && d.rows[1]!.reach === 20 && d.rows[0]!.likes === null);
ok('the same day twice is added up, not repeated', parseDailyReport('Date,Reach\n2026-10-01,10\n2026-10-01,5').rows[0]!.reach === 15 && parseDailyReport('Date,Reach\n2026-10-01,10\n2026-10-01,5').rows.length === 1);
d = parseDailyReport('Date,Reach\n2026-10-01,10\nsoon,5\n31/02/2026,7'); ok('a bad date skips that row and says which one, and the rest still read', d.rows.length === 1 && d.problems.length === 2 && /Row 3/.test(d.problems[0]!) && /Row 4/.test(d.problems[1]!));
ok('no Date column, no numbers, and no rows are each explained', /No Date column/.test(parseDailyReport('Day2,Reach\n1,2').problems[0]!) && /No numbers/.test(parseDailyReport('Date,Colour\n2026-10-01,red').problems[0]!) && /no rows/.test(parseDailyReport('Date,Reach').problems[0]!));
ok('rows come out in date order', parseDailyReport('Date,Reach\n2026-10-03,1\n2026-10-01,2\n2026-10-02,3').rows.map(r => r.day).join() === '2026-10-01,2026-10-02,2026-10-03');

console.log('--- a posts report');
const posts = 'Publish time,Description,Permalink,Post type,Likes,Comments,Shares,Saves,Reach,Profile activity\n10/10/2026 9:30 am,"New range, in store now",https://www.instagram.com/p/AAA/,Reel,120,8,5,12,"2,400",33\n11/10/2026 6:00 pm,Window display,https://www.instagram.com/p/BBB/,Photo,60,2,,3,900,\n';
let pr = parsePostsReport(posts);
ok('each post is read with its time, type, caption, link and numbers', pr.rows.length === 2 && pr.rows[0]!.postedAt === '2026-10-10T09:30:00+11:00' && pr.rows[0]!.kind === 'reel' && pr.rows[0]!.caption === 'New range, in store now' && pr.rows[0]!.permalink === 'https://www.instagram.com/p/AAA/' && pr.rows[0]!.likes === 120 && pr.rows[0]!.reach === 2400 && pr.rows[0]!.profile_activity === 33);
ok('a number the file does not give is "not reported", so importing again never overwrites it with 0', pr.rows[1]!.shares === null && pr.rows[1]!.profile_activity === null && pr.rows[1]!.saves === 3);
ok('the same link twice in the file is one post', parsePostsReport(posts + '12/10/2026,Dup,https://www.instagram.com/p/AAA/,Photo,1,1,1,1,1,1\n').rows.length === 2);
pr = parsePostsReport('Publish time,Permalink,Likes\n10/10/2026,not a link,5\nbad,https://x.com/a,5\n10/10/2026,https://x.com/b,5'); ok('a row with a bad date or a link that is not a web address is skipped and named, the rest still read', pr.rows.length === 1 && pr.problems.length === 2 && /Row 2.*not a web address/.test(pr.problems[0]!) && /Row 3.*not a date/.test(pr.problems[1]!));
ok('a post with no link is kept (it cannot be matched later)', parsePostsReport('Date,Likes\n10/10/2026,5\n11/10/2026,6').rows.length === 2);
ok('no date column and no numbers are each explained', /No publish date/.test(parsePostsReport('Likes\n5').problems[0]!) && /No numbers/.test(parsePostsReport('Date,Colour\n10/10/2026,red').problems[0]!));
ok('a very long caption is cut', parsePostsReport(`Date,Description,Likes\n10/10/2026,${'x'.repeat(900)},5`).rows[0]!.caption!.length === 500);
console.log(`\npassed: ${pass}   failed: ${fail}`); process.exit(fail ? 1 : 0);
