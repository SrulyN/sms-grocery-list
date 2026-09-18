# sms-grocery-list

A shared grocery list my wife and I text to.

We kept forgetting things because we each had our own list on our own phone. So one
phone number: whoever thinks of something texts it, and it lands on one list we both
share. Text `list` to see it. Text `done` on the way home from the store and it clears.

It runs on Cloudflare Workers with a SQLite database, and uses Claude Haiku to work out
when "milk" and "2% milk" are the same thing so the list doesn't fill up with duplicates.

## What it understands

| Text | Does |
|---|---|
| anything else | Adds it. Several at a time works: `milk, eggs, 2 lb chicken` |
| `list` | Sends the list back |
| `done` | Clears it and starts the next trip |
| `undo` | Restores a list cleared in the last hour |
| `drop milk` | Takes one thing off |
| `help` | Lists the commands |

## Running it yourself

You'll need a Twilio account with an SMS-capable US number, a Cloudflare account, and
an Anthropic API key. US numbers also need A2P 10DLC registration through Twilio before
they'll send reliably.

```bash
npm install
wrangler d1 create grocery          # put the returned id in wrangler.toml
wrangler d1 execute grocery --remote --file=./schema.sql
```

Add the household and whoever is allowed to text it:

```bash
wrangler d1 execute grocery --remote --command="
  INSERT INTO households (id, name) VALUES (1, 'Home');
  INSERT INTO members (household_id, phone_e164, display_name)
    VALUES (1, '+1XXXXXXXXXX', 'Me'), (1, '+1YYYYYYYYYY', 'Wife');
  INSERT INTO trips (household_id) VALUES (1);"
```

Then the two secrets, and deploy:

```bash
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
```

Put the deployed URL into `wrangler.toml` as `PUBLIC_URL` and deploy once more. The
signature check hashes that URL, so it has to match exactly. Then point the number's
incoming message webhook at `https://<your-worker>/sms`.

## Layout

| File | Job |
|---|---|
| `src/index.ts` | The webhook. Checks the signature, checks the sender, routes the message, replies. |
| `src/twilio.ts` | Signature verification and TwiML responses. |
| `src/ai.ts` | The Claude call that splits a message into items and matches them against the list. |
| `src/db.ts` | Every database query. |
| `src/normalize.ts` | Plain text matching, used before the AI and as a fallback after it. |

## Notes to self

- Only numbers in the `members` table get a reply. Everything else is ignored, which
  keeps wrong numbers and spam from reaching the AI.
- If the Anthropic call fails it falls back to splitting on commas and matching
  normalized text. Worse, but it never loses a message.
- `done` doesn't delete anything. It closes the current trip and opens a new one, which
  is what makes `undo` possible.
- The unique index on `(trip_id, canonical_name)` is the real duplicate guard. The AI is
  the smart part, the index is the guarantee.
- Quantities are stored as text, not numbers. People write "a couple of".
