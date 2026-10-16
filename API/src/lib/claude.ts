import Anthropic from '@anthropic-ai/sdk';

// The one place the CRM talks to Claude. The key lives only on the API (Railway), never in the web app.
// Models are set by variables, so changing one is a settings change, not a code change:
//   CLAUDE_FAST_MODEL  quick, cheap jobs (tidying a note)       default claude-haiku-5-5
//   CLAUDE_MODEL       jobs that need better writing (emails)   default claude-sonnet-5-5
const FAST = () => process.env.CLAUDE_FAST_MODEL || 'claude-haiku-5-5';
const SMART = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

export const aiConfigured = () => !!process.env.ANTHROPIC_API_KEY;

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic({ timeout: 30_000, maxRetries: 2 }));   // reads ANTHROPIC_API_KEY by itself

export type Reply = { text: string; model: string; inputTokens: number; outputTokens: number };

export async function ask(o: { system: string; user: string; fast?: boolean; maxTokens?: number }): Promise<Reply> {
  const model = o.fast ? FAST() : SMART();
  const msg = await getClient().messages.create({
    model,
    max_tokens: o.maxTokens ?? 500,
    system: o.system,
    messages: [{ role: 'user', content: o.user }],
  });
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('').trim();
  return { text, model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
}

// One turn of a conversation that may use tools. The caller runs the tools and calls again until Claude is done.
// With onText the words arrive as they are written (streaming); without it the whole turn comes back at once.
// The system prompt is marked cacheable, so it is read cheaply from the second turn on.
export async function chatTurn(o: {
  system: string; messages: Anthropic.MessageParam[]; tools: Anthropic.Tool[]; maxTokens: number;
  onText?: (delta: string) => void; signal?: AbortSignal;
}): Promise<Anthropic.Message> {
  const params = {
    model: SMART(), max_tokens: o.maxTokens, tools: o.tools, messages: o.messages,
    system: [{ type: 'text' as const, text: o.system, cache_control: { type: 'ephemeral' as const } }],
  };
  const opts = o.signal ? { signal: o.signal } : undefined;
  if (!o.onText) return getClient().messages.create(params, opts);
  const stream = getClient().messages.stream(params, opts);
  stream.on('text', (delta: string) => o.onText!(delta));
  return stream.finalMessage();
}
export const smartModel = SMART;

// What to tell the person when a call fails, and the status to send. Never passes the raw error on.
export function aiProblem(e: unknown): { status: number; message: string } {
  if (e instanceof Anthropic.APIError) {
    if (e.status === 401 || e.status === 403) return { status: 502, message: 'The Claude key was rejected. Check ANTHROPIC_API_KEY on the API.' };
    if (e.status === 404) return { status: 502, message: 'Claude does not know that model name. Check CLAUDE_MODEL and CLAUDE_FAST_MODEL on the API.' };
    if (e.status === 429) return { status: 429, message: 'Claude is being asked too much right now. Try again in a minute.' };
    if (e.status === 529 || (e.status ?? 0) >= 500) return { status: 503, message: 'Claude is busy. Try again in a minute.' };
    if (e.status === 400) return { status: 502, message: 'Claude refused that request. If this keeps happening, check the account has credit.' };
  }
  return { status: 502, message: "Couldn't reach Claude. Try again in a minute." };
}