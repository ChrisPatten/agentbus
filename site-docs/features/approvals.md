# Approvals

When your agent wants to do something that needs your permission, such as run a command or edit a file outside its folder, Claude Code stops and asks. With approvals, that question comes to you in Telegram with **Approve** and **Deny** buttons, so you can answer from your phone and the agent carries on.

Approvals work with the [`cc-pool`](/runtimes/cc-pool) runtime, for conversations that take place on Telegram.

## How it works

1. A pane's Claude Code session shows a permission prompt.
2. A hook in that session tells the bus. The bus works out which conversation the pane is serving and who it's with.
3. You receive a private Telegram message from your bot:

   ```
   🔐 Approval needed
   Bash: npm run deploy

   Agent: agent:sam-pool-1 · answer by 14:35 UTC
   ```

4. You tap **Approve** or **Deny**. The bus checks that the prompt is still showing, then answers it in the pane. The message updates to show the outcome, and the buttons disappear.

The prompt still appears in the pane as normal, so you (or anyone attached to the pane) can also answer it there. Whichever answer comes first wins.

**The bus never answers a prompt that's no longer there.** If the prompt was already answered, the pane moved on to another conversation, or the request is more than 15 minutes old, tapping a button does nothing to the pane, and the message tells you why.

| Outcome | Shown as |
|---|---|
| You approved | ✅ Approved |
| You denied | 🚫 Denied |
| 15 minutes passed with no answer | ⌛ Expired — no answer in time |
| The prompt had already gone | ⚠️ No longer applicable |

Only the person the conversation is with can answer. A tap from anyone else gets "Not authorized".

## Set it up

Approvals use a Claude Code hook in your agent's working folder.

1. In a terminal, make a `scripts/hooks` folder in your agent's working folder (replace the path with your own):

   ```bash
   mkdir -p ~/agents/sam/scripts/hooks
   ```

2. Link the hook from AgentBus into it:

   ```bash
   ln -s ~/agentbus/scripts/hooks/agentbus_approval_hook.sh ~/agents/sam/scripts/hooks/agentbus_approval_hook.sh
   ```

3. Register the hook in the agent folder's `.claude/settings.json`. If the file already has a `hooks` section, add `PermissionRequest` to it:

   ```json
   {
     "hooks": {
       "PermissionRequest": [
         { "hooks": [{ "type": "command", "command": "scripts/hooks/agentbus_approval_hook.sh" }] }
       ]
     }
   }
   ```

4. Running panes only load new hooks when they start. While your agent is idle, close the pool's tmux session (use your `tmux_session` name):

   ```bash
   tmux kill-session -t sam-pool
   ```

   The bus starts fresh panes as conversations need them, and each conversation resumes its Claude session.

The hook needs `jq` and `curl`, and sends requests to `http://127.0.0.1:3000`. If your bus uses another address, set `AGENTBUS_URL`. If you set `bus.auth_token`, the hook sends it from `AGENTBUS_BUS_TOKEN`, which cc-pool sets in each pane for you.

## Checking requests

```bash
make approvals
```

lists pending requests. Add `STATUS=approved`, `denied`, `expired` or `stale` to see others. You can also answer a request without Telegram through the [HTTP API](/reference/http-api#approvals).

## Limits

- **`cc-pool` only.** `cc-headless` refuses tools that need permission, and `claude-code` prompts must be answered in its terminal.
- **Telegram only.** A pane serving an email, Siri, Mac app or scheduled conversation can't reach you with buttons. Those requests are marked as not applicable, and the prompt waits in the pane.
- **Permission prompts only.** A pane stuck for any other reason isn't reported.
- **The 15-minute limit is fixed.**
