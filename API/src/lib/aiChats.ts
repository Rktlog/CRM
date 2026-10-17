import { prisma } from './prisma';

// Saved chats, the way Claude keeps them: a list you can search, open, rename and delete. Each person's chats are
// theirs alone: every query is tied to who is asking, and nobody, managers included, can open anyone else's.
// What is kept is the words, the names of attached files (not the files), the files and charts the assistant made, and
// which look-ups it used. Chats older than the retention setting are deleted.
export type ChatSummary = { id: string; title: string; updatedAt: string; messages: number };
export type StoredMessage = { id: number; role: 'user' | 'assistant'; content: string; meta: Record<string, unknown>; createdAt: string };
export type NewMessage = { role: 'user' | 'assistant'; content: string; meta?: Record<string, unknown> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isChatId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const titleFrom = (text: string) => { const t = text.replace(/\s+/g, ' ').trim(); return (t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t) || 'New chat'; };

export async function listChats(repId: string, q?: string | null, limit = 200): Promise<ChatSummary[]> {
  const like = q && q.trim() ? `%${q.trim()}%` : null;
  const rows = await prisma.$queryRaw<{ id: string; title: string; updated_at: Date; n: number }[]>`
    select c.id, c.title, c.updated_at, (select count(*)::int from crm.ai_messages m where m.chat_id = c.id) as n
    from crm.ai_chats c
    where c.rep_id = ${repId}::uuid
      and (${like}::text is null or c.title ilike ${like}::text or exists (select 1 from crm.ai_messages m where m.chat_id = c.id and m.content ilike ${like}::text))
    order by c.updated_at desc limit ${limit}`;
  return rows.map(r => ({ id: r.id, title: r.title, updatedAt: new Date(r.updated_at).toISOString(), messages: r.n }));
}

export async function getChat(repId: string, id: string): Promise<{ id: string; title: string; messages: StoredMessage[] } | null> {
  if (!isChatId(id)) return null;
  const [c] = await prisma.$queryRaw<{ id: string; title: string }[]>`select id, title from crm.ai_chats where id = ${id}::uuid and rep_id = ${repId}::uuid`;
  if (!c) return null;
  const rows = await prisma.$queryRaw<{ id: number | string; role: string; content: string; meta: Record<string, unknown>; created_at: Date }[]>`
    select id, role, content, meta, created_at from crm.ai_messages where chat_id = ${id}::uuid order by id`;
  return { id: c.id, title: c.title, messages: rows.map(r => ({ id: Number(r.id), role: r.role as 'user' | 'assistant', content: r.content, meta: r.meta ?? {}, createdAt: new Date(r.created_at).toISOString() })) };
}

export async function renameChat(repId: string, id: string, title: string): Promise<boolean> {
  if (!isChatId(id)) return false;
  const t = title.replace(/\s+/g, ' ').trim().slice(0, 120); if (!t) return false;
  return (await prisma.$queryRaw<{ id: string }[]>`update crm.ai_chats set title = ${t} where id = ${id}::uuid and rep_id = ${repId}::uuid returning id`).length > 0;
}
export async function deleteChat(repId: string, id: string): Promise<boolean> {
  if (!isChatId(id)) return false;
  return (await prisma.$queryRaw<{ id: string }[]>`delete from crm.ai_chats where id = ${id}::uuid and rep_id = ${repId}::uuid returning id`).length > 0;
}
export async function deleteAllChats(repId: string): Promise<number> {
  return (await prisma.$queryRaw<{ id: string }[]>`delete from crm.ai_chats where rep_id = ${repId}::uuid returning id`).length;
}

// Saves one exchange. No chat yet: starts one, named from the first question. `keep`: how many messages to keep before
// adding these, which is how editing an earlier question or asking again replaces what came after it.
export async function saveTurn(repId: string, chatId: string | null, firstQuestion: string, keep: number | null, msgs: NewMessage[]): Promise<{ chatId: string; title: string; messages: number }> {
  let id = chatId && isChatId(chatId) ? chatId : null, title = titleFrom(firstQuestion);
  if (id) {
    const [c] = await prisma.$queryRaw<{ title: string }[]>`select title from crm.ai_chats where id = ${id}::uuid and rep_id = ${repId}::uuid`;
    if (!c) id = null; else title = c.title;
  }
  if (!id) id = (await prisma.$queryRaw<{ id: string }[]>`insert into crm.ai_chats (rep_id, title) values (${repId}::uuid, ${title}) returning id`)[0].id as string;
  else if (keep !== null && keep >= 0) {
    await prisma.$queryRaw`delete from crm.ai_messages where chat_id = ${id}::uuid and id not in (select id from crm.ai_messages where chat_id = ${id}::uuid order by id limit ${keep})`;
  }
  const chat: string = id;
  for (const m of msgs) await prisma.$queryRaw`insert into crm.ai_messages (chat_id, role, content, meta) values (${chat}::uuid, ${m.role}, ${m.content}, ${JSON.stringify(m.meta ?? {})}::jsonb)`;
  await prisma.$queryRaw`update crm.ai_chats set updated_at = now() where id = ${chat}::uuid`;
  const [n] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from crm.ai_messages where chat_id = ${chat}::uuid`;
  return { chatId: chat, title, messages: n.n };
}

// Old chats and old files go. Runs when the list is opened, so there is no job to set up.
export async function purgeOld(retentionDays: number): Promise<number> {
  await prisma.$queryRaw`delete from crm.ai_files where created_at < now() - interval '30 days'`;
  if (!retentionDays || retentionDays < 1) return 0;
  return (await prisma.$queryRaw<{ id: string }[]>`delete from crm.ai_chats where updated_at < now() - make_interval(days => ${retentionDays}::int) returning id`).length;
}

// A person's own preferences for how the assistant answers (the "About me" box), kept with them.
export async function getPrefs(repId: string): Promise<string> {
  const [r] = await prisma.$queryRaw<{ text: string }[]>`select text from crm.ai_prefs where rep_id = ${repId}::uuid`;
  return r?.text ?? '';
}
export async function setPrefs(repId: string, text: string): Promise<void> {
  const t = text.trim().slice(0, 2000);
  await prisma.$queryRaw`insert into crm.ai_prefs (rep_id, text) values (${repId}::uuid, ${t}) on conflict (rep_id) do update set text = excluded.text, updated_at = now()`;
}