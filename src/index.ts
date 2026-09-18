import { verifySignature, twiml, silence } from './twilio';
import { interpret, type Plan } from './ai';
import { canonicalize, displayCase, naiveSplit } from './normalize';
import {
  findMember, currentTripId, getList, upsertItem, mergeInto,
  removeItems, closeTrip, undoClose, logMessage, messagesToday,
  type ListItem, type Member,
} from './db';

export interface Env {
  DB: D1Database;
  TWILIO_AUTH_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  PUBLIC_URL: string;        // e.g. https://grocery.you.workers.dev
  DAILY_LIMIT?: string;
}

const HELP_TEXT =
  'Shared grocery list.\n' +
  'Text anything to add it: "milk, eggs, 2 lb chicken"\n' +
  'LIST — see everything\n' +
  'DONE — clear the list after shopping\n' +
  'DROP milk — take one thing off\n' +
  'UNDO — bring back a list you just cleared';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    if (request.method !== 'POST' || url.pathname !== '/sms') {
      return new Response('Not found', { status: 404 });
    }

    const params = new URLSearchParams(await request.text());
    const signature = request.headers.get('X-Twilio-Signature') ?? '';
    const ok = await verifySignature(env.TWILIO_AUTH_TOKEN, signature, `${env.PUBLIC_URL}/sms`, params);
    if (!ok) return new Response('Forbidden', { status: 403 });

    const from = (params.get('From') ?? '').trim();
    const body = (params.get('Body') ?? '').trim();
    if (!from || !body) return silence();

    // Unknown numbers never reach the AI. This is the cost and abuse control.
    const member = await findMember(env.DB, from);
    if (!member) return silence();

    const limit = Number(env.DAILY_LIMIT ?? '100');
    if ((await messagesToday(env.DB, member.id)) >= limit) {
      return twiml("You've hit today's message limit for this list.");
    }

    const tripId = await currentTripId(env.DB, member.household_id);

    try {
      return await handle(env, member, tripId, body);
    } catch (err) {
      console.error('handler failed', err);
      return twiml("Something went wrong on my end — your message wasn't saved. Try again?");
    }
  },
};

async function handle(env: Env, member: Member, tripId: number, body: string): Promise<Response> {
  const keyword = body.toLowerCase().replace(/[^a-z\s]/g, '').trim();

  // --- Fast paths: no AI call, no token cost, instant reply ---
  if (['list', 'whats on the list', 'what s on the list', 'show', 'show list'].includes(keyword)) {
    await logMessage(env.DB, member.id, 'in', body, 'list');
    return twiml(renderList(await getList(env.DB, tripId)));
  }

  if (['done', 'bought', 'got it', 'got everything', 'clear', 'finished', 'shopping done'].includes(keyword)) {
    await logMessage(env.DB, member.id, 'in', body, 'done');
    const n = await closeTrip(env.DB, member.household_id, tripId, member.id);
    return twiml(
      n === 0
        ? 'The list was already empty. Starting fresh anyway.'
        : `Nice — ${n} item${n === 1 ? '' : 's'} cleared. Fresh list started.\n(Text UNDO within the hour if that was a mistake.)`,
    );
  }

  if (keyword === 'undo') {
    await logMessage(env.DB, member.id, 'in', body, 'undo');
    const restored = await undoClose(env.DB, member.household_id);
    if (!restored) return twiml('Nothing to undo.');
    const restoredTrip = await currentTripId(env.DB, member.household_id);
    return twiml('Restored.\n\n' + renderList(await getList(env.DB, restoredTrip)));
  }

  if (['help', 'commands', 'how does this work'].includes(keyword)) {
    await logMessage(env.DB, member.id, 'in', body, 'help');
    return twiml(HELP_TEXT);
  }

  // --- Everything else goes to Claude ---
  const list = await getList(env.DB, tripId);
  const plan: Plan = (await interpret(env.ANTHROPIC_API_KEY, body, list)) ?? fallbackPlan(body);

  await logMessage(env.DB, member.id, 'in', body, plan.intent);

  switch (plan.intent) {
    case 'list':
      return twiml(renderList(list));

    case 'help':
      return twiml(HELP_TEXT);

    case 'done': {
      const n = await closeTrip(env.DB, member.household_id, tripId, member.id);
      return twiml(
        n === 0
          ? 'The list was already empty. Starting fresh anyway.'
          : `Nice — ${n} item${n === 1 ? '' : 's'} cleared. Fresh list started.`,
      );
    }

    case 'remove': {
      const n = await removeItems(env.DB, tripId, plan.remove);
      if (!n) return twiml("Couldn't find that on the list.");
      return twiml(`Removed ${n} item${n === 1 ? '' : 's'}.\n\n` + renderList(await getList(env.DB, tripId)));
    }

    case 'add':
      return twiml(await applyAdds(env, member, tripId, plan, body));

    default:
      return twiml(`Not sure what to do with that. Text HELP for the commands.`);
  }
}

async function applyAdds(
  env: Env,
  member: Member,
  tripId: number,
  plan: Plan,
  rawText: string,
): Promise<string> {
  if (!plan.add.length) return 'Nothing to add there. Text HELP for the commands.';

  const added: string[] = [];
  const merged: string[] = [];

  for (const item of plan.add) {
    if (item.merge_with !== null) {
      const ok = await mergeInto(
        env.DB, tripId, member.id, item.merge_with, item.quantity_text, item.note, rawText,
      );
      if (ok) { merged.push(item.display_name); continue; }
      // The id was stale or wrong — fall through and upsert normally.
    }

    const { created } = await upsertItem(env.DB, tripId, member.id, item, rawText);
    (created ? added : merged).push(item.display_name);
  }

  const total = (await getList(env.DB, tripId)).length;
  const parts: string[] = [];
  if (added.length) parts.push(`Added: ${added.join(', ')}`);
  if (merged.length) parts.push(`Already on it: ${merged.join(', ')}`);
  parts.push(`List: ${total} item${total === 1 ? '' : 's'}`);
  return parts.join('\n');
}

/** Used when the AI call fails. Dumb, but it never loses the message. */
function fallbackPlan(body: string): Plan {
  return {
    intent: 'add',
    remove: [],
    add: naiveSplit(body)
      .map((chunk) => ({
        display_name: displayCase(chunk).slice(0, 60),
        canonical_name: canonicalize(chunk).slice(0, 60),
        quantity_text: null,
        note: null,
        merge_with: null,
      }))
      .filter((i) => i.canonical_name.length > 0)
      .slice(0, 25),
  };
}

function renderList(items: ListItem[]): string {
  if (!items.length) return 'The list is empty. Text anything to add it.';
  const lines = items.map((item, i) => {
    const extra = [item.quantity_text, item.note].filter(Boolean).join(', ');
    return `${i + 1}. ${item.display_name}${extra ? ` — ${extra}` : ''}`;
  });
  return `Grocery list (${items.length})\n` + lines.join('\n');
}
