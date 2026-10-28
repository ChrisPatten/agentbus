# Slack relay: n8n setup

This guide sets up the n8n side of the AgentBus Slack channel (E76). n8n receives your Slack messages, holds them in a queue until AgentBus fetches them, and posts AgentBus's replies back to Slack. AgentBus only makes outbound calls to n8n, so it works from a laptop that is often offline. Messages you send while it is offline wait in the queue.

```
Slack ──event──▶ [1 ingest] ──▶ Data Table agentbus_inbox ◀── [2 inbox] ◀── GET  AgentBus
                                                          ◀── [3 ack]   ◀── POST AgentBus
Slack ◀──────────────────────────────────────────────────── [4 send]  ◀── POST AgentBus
                                 [5 cleanup] (daily)
```

Node and field names below match recent n8n 1.x releases. If a label differs in your version, the option is usually nearby.

There are two parts. **Outbound DM** (E76, S76.0) is what AgentBus uses today: one webhook that sends you a DM. **Full relay** (Steps 1–9 below) is the planned two-way setup for later E76 stories.

## Outbound DM (S76.0)

AgentBus POSTs `{"slack_user_id": "U…", "message": "…"}` with `Authorization: Bearer <JWT>`, and the workflow DMs that user from your bot.

**Slack credential:** a bot token (`xoxb-…`) with the `chat:write` scope is enough. Posting to a user id opens the bot's DM with that user automatically.

### 1. Create the JWT credential

1. Generate a secret: `openssl rand -base64 48`. Put it in AgentBus's `.env` as `SLACK_JWT_SECRET`.
2. In n8n, go to **Credentials → Add credential → JWT Auth**.
3. Key type **Passphrase**, paste the same secret, algorithm **HS256**. Name it `AgentBus JWT`.

n8n uses the passphrase text directly as the signing key, and so does AgentBus. Paste it exactly as generated, with no added quotes or spaces.

### 2. Build the workflow

Create a workflow named **AgentBus · slack-dm**:

1. **Webhook**
   - HTTP method **POST**, path `agentbus/slack-dm`
   - Authentication **JWT Auth**, credential `AgentBus JWT`
   - Respond: **Using 'Respond to Webhook' Node**

2. **If** named `Valid`. Both must be true:
   - `{{ $json.body.slack_user_id }}` matches regex `^[UW][A-Z0-9]+$`
   - `{{ $json.body.message }}` is not empty

   To limit who the bot can DM, add a third condition: `slack_user_id` is equal to your member id.

   **false** branch → **Respond to Webhook**, response code **400**, JSON `{ "ok": false, "error": "invalid_request" }`.

3. **true** branch → **Slack**, resource **Message**, operation **Send**
   - Send message to: **User**, by **ID**: `{{ $json.body.slack_user_id }}`
   - Message type **Simple Text Message**, text `{{ $json.body.message }}`
   - Options → **Include Link to Workflow**: **off**
   - Settings → **On Error: Continue (using error output)**

4. Slack success output → **Respond to Webhook**, response code **200**, JSON:

   ```
   { "ok": true, "ts": "{{ $json.ts ?? $json.message?.ts ?? '' }}" }
   ```

   Check the Slack node's output after a test to see which field holds the timestamp in your version.

5. Slack error output → **Respond to Webhook**, response code **502**, JSON `{ "ok": false, "error": "{{ $json.error?.message ?? 'slack_error' }}" }`. AgentBus retries a 502.

Save and **activate** the workflow. Its production URL (`https://<your-n8n>/webhook/agentbus/slack-dm`) goes in AgentBus's `adapters.slack.webhook_url`. Copy it from the Webhook node's **Production URL** tab, or from `webhookUrl` in a test execution's output. Behind some gateways it's on a different host from the test URL.

### 3. What AgentBus expects back

| Status | AgentBus does |
|---|---|
| `200 {"ok": true, "ts": "…"}` | Marks the message delivered |
| `400`, `401`, `403` | Fails it without retrying (`401`/`403` means the secret doesn't match) |
| `429`, `5xx`, no answer within 10s | Retries it later |

### 4. Test it from AgentBus

With `adapters.slack` configured and AgentBus restarted, queue a DM to yourself (replace `chris` with your contact id):

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/messages -H "Content-Type: application/json" -d '{"channel":"slack","topic":"general","sender":"agent:test","recipient":"contact:chris","payload":{"type":"text","body":"Hello from AgentBus"}}'
```

The DM should arrive within a few seconds. If it doesn't, check the n8n workflow's **Executions** list, and the AgentBus log for lines starting `[slack]`.

---

# Full relay (planned)

The steps below describe the planned two-way relay. Its webhooks will use the same JWT credential instead of the header secret in Step 1.

## Before you start

You need:

- A self-hosted n8n on version 1.113 or later (for Data Tables), reachable from the internet over HTTPS so Slack can deliver events to it.
- The n8n environment variable `WEBHOOK_URL` set to n8n's public base URL (for example `https://n8n.example.com/`). Without it, the Slack Trigger node registers an internal URL that Slack cannot reach.
- A Slack credential in n8n that uses a **bot token** (`xoxb-…`) with these scopes: `chat:write`, `im:history`, `reactions:write`. Add `groups:history` if you also want to use a private channel.

The bot token matters. If the credential is a *user* token, replies post as you, and the ingest filter can no longer tell your messages from the agent's.

If you don't already have a Slack app you control, create one from the manifest in [Appendix A](#appendix-a-slack-app-manifest). You need to be able to edit the app's **Event Subscriptions** page, because that is where Slack is told to send events to n8n.

## Step 1: Create the shared secret

AgentBus authenticates to n8n with one header on every call.

1. Generate a secret: `openssl rand -hex 24`.
2. In n8n, go to **Credentials → Add credential → Header Auth**.
3. Name it `AgentBus relay`. Set **Name** to `X-AgentBus-Relay-Token` and **Value** to the secret.

You'll put the same secret in AgentBus's config as `adapters.slack.relay_token`.

## Step 2: Create the data tables

Go to **Overview → Data tables → Create data table**.

**`agentbus_inbox`**: one row per incoming Slack message.

| Column | Type | Holds |
|---|---|---|
| `msg_id` | String | `<channel>:<ts>`, the unique key |
| `channel` | String | Slack channel id (`D…` for a DM) |
| `ts` | String | Slack message timestamp, kept as a string to keep its full precision |
| `thread_ts` | String | Parent thread timestamp, empty for a top-level message |
| `user` | String | Slack user id (`U…`) |
| `text` | String | Message text |
| `status` | String | `pending` or `delivered` |
| `received_at` | Date | When n8n received it |
| `delivered_at` | Date | When AgentBus acked it |

n8n also adds its own `id`, `createdAt`, and `updatedAt` columns. You don't need to create those.

## Step 3: Find your ids

You need two Slack ids for the allowlists below:

- **Your user id**: in Slack, open your profile, click **⋯**, then **Copy member ID** (`U…`).
- **The bot DM channel id**: open the bot's **Messages** tab. The id appears in the URL of Slack in a browser (`…/D0123ABCD`). You can also send the bot a message after Step 4 and read `channel` from the trigger's output.

## Step 4: Workflow 1, ingest

Create a workflow named **AgentBus · ingest**.

1. **Slack Trigger**
   - Credential: your Slack bot credential. If the credential has a **Signature Secret** field, paste the app's signing secret (from **Basic Information**) so n8n checks that events really come from Slack.
   - Trigger on: **Any Event** (or the message/DM event if your version lists one).
   - Copy the node's **Production URL**.
   - **Save and activate** the workflow. Slack checks the URL immediately, and only an active workflow answers it.
   - In the Slack app, open **Event Subscriptions**, turn it on, paste the Production URL as the **Request URL**, and wait for "Verified". Under **Subscribe to bot events**, add `message.im` (and `message.groups` for a private channel). Save, then reinstall the app if Slack asks you to.

2. **If** node named `Is my message`. All of these must be true (combine with AND):
   - `{{ $json.type }}` is equal to `message`
   - `{{ $json.bot_id }}` is empty, so the agent's own replies are ignored
   - `{{ $json.subtype }}` is empty, so edits, deletes, and joins are ignored
   - `{{ $json.user }}` is equal to your user id
   - `{{ $json.channel }}` is equal to the bot DM channel id

   Send a test DM and check the trigger's output panel. If the event fields sit under `event` (for example `$json.event.user`), adjust every expression in this workflow to match.

3. On the **true** branch, a **Data table** node named `Already queued?`
   - Operation: **Get row(s)**, table `agentbus_inbox`
   - Condition: `msg_id` equals `{{ $json.channel }}:{{ $json.ts }}`
   - Settings → turn on **Always Output Data**, so an empty result still continues.

4. **If** node named `New?`: `{{ $json.msg_id }}` **is empty**. Slack retries an event if n8n is slow to answer, and this check stops a retry from creating a second row.

5. On the **true** branch, a **Data table** node named `Queue it`
   - Operation: **Insert**, table `agentbus_inbox`
   - Values, read from the trigger with `$('Slack Trigger').item.json`:
     - `msg_id` = `{{ $('Slack Trigger').item.json.channel }}:{{ $('Slack Trigger').item.json.ts }}`
     - `channel`, `ts`, `user`, `text` = the matching trigger fields
     - `thread_ts` = `{{ $('Slack Trigger').item.json.thread_ts ?? '' }}`
     - `status` = `pending`
     - `received_at` = `{{ $now.toISO() }}`

6. **Slack** node named `React ⏳`
   - Resource **Reaction**, operation **Add**
   - Channel `{{ $('Slack Trigger').item.json.channel }}`, timestamp `{{ $('Slack Trigger').item.json.ts }}`, emoji `hourglass_flowing_sand`
   - Settings → **On Error: Continue**. A reaction failure must never drop a message.

**Check:** DM the bot. A row appears in `agentbus_inbox` with `status = pending`, and your message gets ⏳.

## Step 5: Workflow 2, inbox

AgentBus calls this to fetch queued messages, oldest first.

1. **Webhook**
   - Method **GET**, path `agentbus/inbox`
   - Authentication **Header Auth**, credential `AgentBus relay`
   - Respond: **Using 'Respond to Webhook' Node**

2. **Data table**: **Get row(s)** from `agentbus_inbox` where `status` equals `pending`. Turn on **Return All**, and in Settings turn on **Always Output Data**.

3. **Code** (Run Once for All Items):

   ```js
   const limit = Math.min(Number($('Webhook').first().json.query.limit) || 50, 200);
   const rows = $input.all().map((i) => i.json).filter((r) => r.msg_id);
   // Slack ts strings are fixed-width ("1729430000.123456"), so string order is time order.
   rows.sort((a, b) => a.ts.localeCompare(b.ts));
   return [{
     json: {
       messages: rows.slice(0, limit).map((r) => ({
         id: r.msg_id,
         channel: r.channel,
         ts: r.ts,
         thread_ts: r.thread_ts || null,
         user: r.user,
         text: r.text,
         received_at: r.received_at,
       })),
     },
   }];
   ```

4. **Respond to Webhook**: Respond With **JSON**, body `{{ $json }}`.

Activate the workflow.

## Step 6: Workflow 3, ack

AgentBus calls this once it has queued a page of messages. A message stays `pending`, and is returned again by `inbox`, until it's acked. AgentBus keeps its own record of ids it has seen, so a message returned twice is still delivered to the agent only once.

1. **Webhook**: method **POST**, path `agentbus/ack`, Header Auth `AgentBus relay`, Respond **Using 'Respond to Webhook' Node**.

2. **Code** (Run Once for All Items). This turns `{"ids": [...]}` into one item per id:

   ```js
   const ids = $input.first().json.body?.ids ?? [];
   return ids.map((id) => {
     const sep = id.indexOf(':');
     return { json: { msg_id: id, channel: id.slice(0, sep), ts: id.slice(sep + 1) } };
   });
   ```

   AgentBus never sends an empty `ids` list.

3. **Data table**: **Update row(s)** in `agentbus_inbox` where `msg_id` equals `{{ $json.msg_id }}`. Set `status` = `delivered` and `delivered_at` = `{{ $now.toISO() }}`.

4. **Slack** Reaction **Remove** `hourglass_flowing_sand` on channel `{{ $('Code').item.json.channel }}`, timestamp `{{ $('Code').item.json.ts }}`. On Error: **Continue**.

5. **Slack** Reaction **Add** `eyes` with the same channel and timestamp. On Error: **Continue**.

6. **Respond to Webhook**: JSON `{ "ok": true, "acked": {{ $('Code').all().length }} }`. In Settings, turn on **Execute Once**, so it answers once after every id has been processed.

Activate the workflow.

## Step 7: Workflow 4, send

AgentBus calls this to post a reply.

1. **Webhook**: method **POST**, path `agentbus/send`, Header Auth `AgentBus relay`, Respond **Using 'Respond to Webhook' Node**.

2. **If** named `Allowed channel`: `{{ $json.body.channel }}` equals the bot DM channel id. This means a leaked secret can only post where the bot already talks.
   - **false** branch → **Respond to Webhook**, response code **403**, JSON `{ "ok": false, "error": "channel_not_allowed" }`.

3. **true** branch → **Slack** node, resource **Message**, operation **Send**
   - Send to: **Channel**, channel id `{{ $json.body.channel }}`
   - Message type: **Simple Text Message**, text `{{ $json.body.text }}`
   - Options:
     - **Include Link to Workflow**: **off**. Otherwise n8n appends "Automated with this n8n workflow" to every reply.
     - **Reply to a Message**: set the parent timestamp to `{{ $json.body.thread_ts }}`. Leave out the option entirely (or use an expression that is empty for a top-level post) when `thread_ts` is absent.
   - Settings → **On Error: Continue (using error output)**.

4. Success output → **Respond to Webhook**, JSON `{ "ok": true, "ts": "{{ $json.ts ?? $json.message?.ts }}" }`. Check the Slack node's output after a test send to see which field holds the timestamp in your version.

5. Error output → **Respond to Webhook**, response code **502**, JSON `{ "ok": false, "error": "{{ $json.error?.message ?? 'slack_error' }}" }`. AgentBus treats a 502 as retryable and keeps the reply queued.

Activate the workflow.

## Step 8: Workflow 5, cleanup

1. **Schedule Trigger**: every day at 03:00.
2. **Data table**: **Delete row(s)** from `agentbus_inbox` where `status` equals `delivered` **and** `delivered_at` is before `{{ $now.minus({ days: 7 }).toISO() }}`.

Activate the workflow.

## Step 9: Test with curl

Set two shell variables first:

```bash
export N8N=https://n8n.example.com/webhook
export TOKEN=your-relay-secret
```

DM the bot "hello", then fetch the queue:

```bash
curl -s "$N8N/agentbus/inbox?limit=10" -H "X-AgentBus-Relay-Token: $TOKEN"
```

You should see `{"messages":[{"id":"D0123ABCD:1729430000.123456", …}]}`. Ack it, using the `id` from that response:

```bash
curl -s -X POST "$N8N/agentbus/ack" -H "X-AgentBus-Relay-Token: $TOKEN" -H "Content-Type: application/json" -d '{"ids":["D0123ABCD:1729430000.123456"]}'
```

The ⏳ on your message turns into 👀, and fetching the inbox again returns an empty list. Reply in the thread:

```bash
curl -s -X POST "$N8N/agentbus/send" -H "X-AgentBus-Relay-Token: $TOKEN" -H "Content-Type: application/json" -d '{"channel":"D0123ABCD","thread_ts":"1729430000.123456","text":"hi from AgentBus"}'
```

The reply appears in the thread under your message. Finally, check that a call without the header returns 403:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$N8N/agentbus/inbox"
```

## After it works

Export each workflow (**⋯ → Download**) and commit the JSON files next to this README, as S76.1 asks. The exports reference credentials by name and don't contain your secrets, but check before committing.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Slack says the Request URL didn't respond | The ingest workflow isn't active, or `WEBHOOK_URL` isn't set, so the URL isn't the public one. |
| No row appears for a DM | The `Is my message` check failed. Compare its expressions with the trigger's output (`event.` nesting, the user id, the channel id). |
| The agent's own replies are queued | The credential is a user token rather than a bot token, so replies have no `bot_id`. |
| Every reply ends with "Automated with this n8n workflow" | **Include Link to Workflow** is still on in the send workflow. |
| A webhook call never returns | A **Respond to Webhook** node wasn't reached. Usually the inbox Data table node needs **Always Output Data** turned on. |

## Appendix A: Slack app manifest

Use this if you're creating your own app (**api.slack.com/apps → Create New App → From a manifest**). It leaves out Event Subscriptions on purpose: Slack checks the Request URL when you save it, so add events in Step 4, once the ingest workflow is active.

```yaml
display_information:
  name: AgentBus
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: AgentBus
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - reactions:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Install the app to your workspace, copy the **Bot User OAuth Token** (`xoxb-…`) into an n8n Slack credential, and copy the **Signing Secret** from **Basic Information** for Step 4.
