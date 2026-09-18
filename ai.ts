// Layer 2 of deduplication: one Claude Haiku call per free-text message.
// It splits, canonicalizes, and matches against the existing list in a single pass.
// If it fails for any reason the caller falls back to the deterministic layer —
// the AI is never allowed to be the reason a message gets dropped.

import type { ListItem } from './db';

const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 8000;

export type ParsedItem = {
  display_name: string;
  canonical_name: string;
  quantity_text: string | null;
  note: string | null;
  merge_with: number | null; // id of an existing item this is the same as
};

export type Plan = {
  intent: 'add' | 'list' | 'done' | 'remove' | 'help' | 'unknown';
  add: ParsedItem[];
  remove: number[]; // ids
};

const SYSTEM_PROMPT = `You turn text messages into edits on a shared household grocery list.

You are given the current list (each line has a numeric id) and one incoming message.
Reply with ONLY a JSON object. No prose, no markdown, no code fences.

Shape:
{
  "intent": "add" | "list" | "done" | "remove" | "help" | "unknown",
  "add": [
    {
      "display_name": "Milk",
      "canonical_name": "milk",
      "quantity_text": "2 gallons" or null,
      "note": "the oat one" or null,
      "merge_with": <existing item id> or null
    }
  ],
  "remove": [<existing item id>, ...]
}

Intent rules:
- "add": the message names one or more things to buy. This is the default.
- "list": they are asking what is on the list.
- "done": they bought everything / finished shopping / want the list cleared.
- "remove": they want specific things taken off, but are not done shopping.
- "help": they are asking how this works.
- "unknown": you genuinely cannot tell. Use this sparingly.

Parsing rules:
- One message can contain several items. "milk eggs and bread" is three items.
- display_name is short and readable, title case, no quantity in it.
- canonical_name is lowercase, singular, no quantity, no brand, no adjectives that
  do not change what the product IS. "2% milk" and "a gallon of milk" both give "milk".
  But "oat milk" gives "oat milk", because that is a different product.
- quantity_text is free text exactly as a person would say it. Never invent one.
- note holds anything else useful they said about it.

Matching rules — READ CAREFULLY:
- Set merge_with when the new item is THE SAME REAL PRODUCT as an existing line.
- Similar is NOT the same. "whole milk" and "oat milk" are two items.
  "apples" and "apple juice" are two items. "chicken" and "chicken stock" are two items.
- If you are not confident it is the same product, set merge_with to null and let it
  be a new line. A duplicate line is a small annoyance. A wrongly merged line means
  they come home without something. Under-merge rather than over-merge.
- If merging and the new message gives a quantity, put the new quantity in quantity_text.`;

export async function interpret(
  apiKey: string,
  message: string,
  current: ListItem[],
): Promise<Plan | null> {
  const listText = current.length
    ? current.map((i) => `${i.id}. ${i.display_name}${i.quantity_text ? ` — ${i.quantity_text}` : ''}`).join('\n')
    : '(the list is empty)';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Current list:\n${listText}\n\nIncoming message:\n${message}`,
          },
          // Prefilling the opening brace stops the model from adding any preamble.
          { role: 'assistant', content: '{' },
        ],
      }),
    });

    if (!res.ok) return null;

    const data: any = await res.json();
    const text = (data.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');

    return validate(JSON.parse('{' + text));
  } catch {
    return null; // caller falls back to the deterministic path
  } finally {
    clearTimeout(timer);
  }
}

/** Never trust model output straight into SQL. */
function validate(raw: any): Plan | null {
  const intents = ['add', 'list', 'done', 'remove', 'help', 'unknown'];
  if (!raw || typeof raw !== 'object' || !intents.includes(raw.intent)) return null;

  const add: ParsedItem[] = Array.isArray(raw.add)
    ? raw.add
        .filter((i: any) => i && typeof i.display_name === 'string' && typeof i.canonical_name === 'string')
        .slice(0, 25)
        .map((i: any) => ({
          display_name: String(i.display_name).slice(0, 60).trim(),
          canonical_name: String(i.canonical_name).toLowerCase().slice(0, 60).trim(),
          quantity_text: i.quantity_text ? String(i.quantity_text).slice(0, 60).trim() : null,
          note: i.note ? String(i.note).slice(0, 120).trim() : null,
          merge_with: Number.isInteger(i.merge_with) ? i.merge_with : null,
        }))
        .filter((i: ParsedItem) => i.display_name && i.canonical_name)
    : [];

  const remove: number[] = Array.isArray(raw.remove)
    ? raw.remove.filter((n: any) => Number.isInteger(n)).slice(0, 25)
    : [];

  return { intent: raw.intent, add, remove };
}
