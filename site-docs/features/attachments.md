# Attachments

Send your agent a photo of a receipt, a PDF or a screenshot, and it can open and read it. The bus saves files you send on Telegram, by email or from the Mac app into a folder your agent can reach, and tells the agent where to find each one.

## How it works

1. You send a file with your message.
2. The bus saves it in the agent's download folder under a random name.
3. The agent's message includes a line for each file, which it can open by path:

   ```
   Here's the receipt from lunch
   [Image: /Users/you/.agentbus/assistant/media/3f1a9c2e.jpg]
   [File: /Users/you/.agentbus/assistant/media/8b7d0a41.pdf — invoice.pdf]
   ```

4. After the retention time, the bus deletes the file.

If you send a file with no text, the agent still gets the file lines.

## Set it up

Give the agent a download folder, under `agents`, keyed by the agent's full name:

```yaml
agents:
  "agent:assistant":
    media:
      download_path: /Users/you/.agentbus/assistant/media
      ttl_seconds: 86400       # keep files for a day
```

| Option | Default | What it does |
|---|---|---|
| `download_path` | required | The folder files are saved in. Must be a full path (starting with `/`). Created when the bus starts. |
| `ttl_seconds` | `3600` (1 hour) | How long files are kept before they're deleted |

The bus picks the agent's folder from your routes: it uses the first route for that channel. **Without a `media` block for that agent, files aren't saved.** The message still reaches the agent, with its text, or with `[Image]` or `[File]` if it had none.

Make sure your agent is allowed to read files in `download_path`. If it's outside the agent's working folder, add it to the folder's Claude Code permissions.

## By channel

| Channel | What's saved |
|---|---|
| Telegram | Photos (largest size) and files sent as documents. Voice messages, videos, audio and stickers aren't saved; their caption is passed on as text. |
| Email | Attachments, and images embedded in the message body. |
| Mac app | Any file you attach, up to `adapters.app.max_upload_bytes` (25 MB by default). Images from the Mac arrive as files. |

Your agent can't send files back. Its replies are text only.

## Retention

Every 10 minutes, the bus deletes files older than `ttl_seconds`. Pick a retention long enough for your agent to get to the file, especially with the Mac app, where you might upload a file and send the message later. The Mac app shows deleted files as expired.

If your agent needs to keep a file, ask it to copy it into its own folder.
