import { prisma } from '../prisma';
import type { Block } from './blocks';

// The designs and the five automatic emails a new install starts with. Made once, on first use.
let n = 0;
const id = () => `b${++n}`;
const H = (text: string): Block => ({ id: id(), type: 'heading', text });
const T = (text: string): Block => ({ id: id(), type: 'text', text });
const B = (label: string, url: string): Block => ({ id: id(), type: 'button', label, url });

export const CAMPAIGN_STARTERS: { name: string; subject: string; preview: string; blocks: Block[] }[] = [
  { name: 'Newsletter', subject: 'News from Rhino Rhino', preview: 'What is new this month',
    blocks: [H('Hi {{first_name}}'), T('Here is what is new at Rhino Rhino this month.'), { id: id(), type: 'image', url: '', alt: '' }, T('Write your news here.'), B('Order on the portal', '{{portal_link}}'), { id: id(), type: 'divider' }, T('Questions? Just reply to this email.')] },
  { name: 'New arrivals', subject: 'New arrivals for {{company}}', preview: 'Fresh stock, ready to order',
    blocks: [H('New arrivals'), T('Hi {{first_name}}, these just landed and are ready to order.'), { id: id(), type: 'products', skus: [], showPrice: false, columns: 2 }, B('See them on the portal', '{{portal_link}}')] },
  { name: 'Promotion', subject: 'An offer for {{company}}', preview: 'For a limited time',
    blocks: [H('A special offer for {{company}}'), T('Hi {{first_name}},\n\nDescribe the offer, the dates and how to claim it.'), B('Order now', '{{portal_link}}'), T('Offer ends on [date].')] },
  { name: 'Reorder reminder', subject: 'Time to restock, {{first_name}}?', preview: 'Your best sellers are ready when you are',
    blocks: [H('Time to restock?'), T('Hi {{first_name}}, it has been a little while since your last order. Here are some favourites.'), { id: id(), type: 'products', skus: [], showPrice: false, columns: 3 }, B('Reorder now', '{{portal_link}}')] },
  { name: 'Plain message', subject: 'A quick note', preview: '',
    blocks: [T('Hi {{first_name}},\n\nWrite your message here.\n\nThanks')] },
];

export const AUTOMATION_STARTERS: Record<string, { name: string; subject: string; preview: string; blocks: Block[] }> = {
  unpaid_quote: { name: 'Automatic: unpaid quote', subject: 'Your quote {{quote_number}} is waiting', preview: 'Payment is needed before we can dispatch',
    blocks: [H('Your quote {{quote_number}}'), T('Hi {{first_name}}, your quote is ready and we have not received payment yet. We dispatch as soon as it is paid.'), { id: id(), type: 'details' }, B('Pay or contact us', '{{portal_link}}'), T('If you have already paid, thank you, and please ignore this email.')] },
  unpaid_invoice: { name: 'Automatic: unpaid invoice', subject: 'Reminder: invoice {{invoice_number}}', preview: 'A payment reminder',
    blocks: [H('Payment reminder'), T('Hi {{first_name}}, our records show invoice {{invoice_number}} is still unpaid.'), { id: id(), type: 'details' }, T('If you have already paid, thank you, and please ignore this email. If something looks wrong, just reply and we will sort it out.')] },
  sales_invoice: { name: 'Automatic: sales invoice', subject: 'Your invoice {{invoice_number}} from Rhino Rhino', preview: 'Your tax invoice',
    blocks: [H('Thank you for your order'), T('Hi {{first_name}}, your tax invoice has been issued.'), { id: id(), type: 'details' }, T('Reply to this email if you need a copy of the invoice or have a question.')] },
  tracking_number: { name: 'Automatic: tracking number', subject: 'Your order {{order_number}} has shipped', preview: 'Track your parcel',
    blocks: [H('Your order is on its way'), T('Hi {{first_name}}, order {{order_number}} has been sent.'), { id: id(), type: 'details' }, B('Track your parcel', '{{tracking_link}}')] },
  abandoned_cart: { name: 'Automatic: abandoned cart', subject: 'You left something in your cart', preview: 'Your cart is waiting',
    blocks: [H('Still thinking it over?'), T('Hi {{first_name}}, you left these in your cart on the ordering portal.'), { id: id(), type: 'items' }, B('Return to your cart', '{{cart_link}}'), T('Need a hand? Reply to this email.')] },
};

const AUTOMATION_DEFAULTS: Record<string, { delay: number; repeat: number; max: number }> = {
  unpaid_quote: { delay: 72, repeat: 3, max: 3 }, unpaid_invoice: { delay: 336, repeat: 7, max: 3 },
  sales_invoice: { delay: 0, repeat: 0, max: 1 }, tracking_number: { delay: 0, repeat: 0, max: 1 }, abandoned_cart: { delay: 24, repeat: 0, max: 1 },
};

export async function ensureStarters(): Promise<void> {
  const have = await prisma.$queryRaw<{ name: string }[]>`select name from crm.marketing_templates where builtin = true`;
  const names = new Set(have.map(h => h.name));
  for (const t of CAMPAIGN_STARTERS) {
    if (names.has(t.name)) continue;
    await prisma.$queryRaw`insert into crm.marketing_templates (name, kind, subject, preview_text, blocks, builtin) values (${t.name}, 'campaign', ${t.subject}, ${t.preview}, ${JSON.stringify(t.blocks)}::jsonb, true)`;
  }
  for (const [key, t] of Object.entries(AUTOMATION_STARTERS)) {
    if (!names.has(t.name)) {
      await prisma.$queryRaw`insert into crm.marketing_templates (name, kind, subject, preview_text, blocks, builtin) values (${t.name}, 'automation', ${t.subject}, ${t.preview}, ${JSON.stringify(t.blocks)}::jsonb, true)`;
    }
    const d = AUTOMATION_DEFAULTS[key];
    await prisma.$queryRaw`
      insert into crm.marketing_automations (key, template_id, delay_hours, repeat_days, max_sends)
      select ${key}, (select id from crm.marketing_templates where builtin = true and name = ${t.name} limit 1), ${d.delay}, ${d.repeat}, ${d.max}
      on conflict (key) do nothing`;
  }
}