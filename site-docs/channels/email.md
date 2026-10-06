# Email

Give your agent its own email address and you can write to it like a colleague: forward it a confirmation, ask it a question from your laptop, or keep a long-running thread going. Each email thread is its own conversation, so the agent keeps the context of that thread, and its replies arrive formatted, in the same thread, in any mail app.

## How it works

- **New mail arrives instantly.** The bus keeps a connection open to the mailbox (IMAP IDLE) and picks up new messages as they arrive.
- **Each thread is one conversation.** Replies in a thread continue that thread's session. A new email, or a forward, starts a new one.
- **Quoted history is trimmed.** When you reply in a thread, the agent sees your new text, not the whole quoted chain (it already has the earlier messages). For a new email or a forward, it sees the full message, with links kept.
- **Replies go out over SMTP**, threaded with `Re:` and the right headers, so they appear in the same conversation in your mail app. They're sent to the address you last wrote from.
- **Replies are formatted.** The agent writes Markdown, and the bus sends both a styled HTML version (headings, lists, tables, links, dark-mode friendly) and a plain-text version.

## Set it up

Create a mailbox for your agent. Many providers, including iCloud, need an **app-specific password** rather than your normal one. For iCloud, create it at account.apple.com under Sign-In and Security.

Add the password to `.env`:

```
ICLOUD_APP_PW=abcd-efgh-ijkl-mnop
```

Then configure the mailbox, list the addresses allowed to write to it, and add a route:

```yaml
adapters:
  email:
    imap:
      host: imap.mail.me.com
      user: assistant@icloud.com
      password: ${ICLOUD_APP_PW}
    smtp:
      host: smtp.mail.me.com
      from: Sam <assistant@icloud.com>

contacts:
  me:
    id: me
    displayName: Me
    platforms:
      email:
        address:
          - me@example.com
          - me@work.example

pipeline:
  routes:
    - match: { channel: email }
      target: { adapterId: cc-headless, recipientId: agent:assistant }
```

The defaults are set for iCloud. For another provider, set its IMAP and SMTP hosts and ports.

| Option | Default | What it does |
|---|---|---|
| `imap.host` | `imap.mail.me.com` | Incoming mail server |
| `imap.port` | `993` | Incoming mail port |
| `imap.user` | required | Mailbox login, usually the address |
| `imap.password` | required | Mailbox password or app-specific password |
| `imap.mailbox` | `INBOX` | The folder to watch |
| `imap.secure` | `true` | Use TLS from the start (port 993). Set `false` only for servers that need STARTTLS. |
| `smtp.host` | `smtp.mail.me.com` | Outgoing mail server |
| `smtp.port` | `587` | Outgoing mail port |
| `smtp.secure` | `false` | `false` upgrades the connection with STARTTLS (port 587). Set `true` for port 465. |
| `smtp.user`, `smtp.password` | same as IMAP | Outgoing login, if different |
| `smtp.from` | the IMAP user | The From address on replies, for example `Sam <assistant@icloud.com>` |
| `require_auth` | `true` | Only accept mail that passes sender authentication (see below) |

Tell your agent, in its system prompt, to write complete, structured answers on email. Email has no practical length limit.

### Several mailboxes

```yaml
adapters:
  email:
    personal:
      imap: { user: sam@icloud.com, password: ${ICLOUD_APP_PW_SAM} }
    work:
      imap: { host: imap.fastmail.com, user: me@work.example, password: ${FASTMAIL_PW} }
      smtp: { host: smtp.fastmail.com }
```

Each mailbox's channel is `email:<name>`, so route them separately (`channel: "email:personal"`). Each account can be configured only once, so you can't watch two folders of the same account.

## Who can email your agent

**Only listed addresses get through.** Mail from any address that isn't in some contact's `email.address` is dropped before your agent sees it.

Because a From address is easy to fake, the bus also checks that the mail really comes from that address's domain. With `require_auth: true` (the default), a message must pass the receiving server's DMARC, DKIM or SPF check for its From domain, or failing that, the bus's own DKIM signature check. Mail that fails is dropped and logged.

Only turn `require_auth` off if your mail passes through a relay that strips these checks.

## Attachments

Files attached to an email, and images embedded in it, are saved for your agent when you've configured a download folder. See [Attachments](/features/attachments). The agent's replies are text only; it can't attach files.

## Emailing you first

Your agent can start a new email to you with the `send_email` tool: a Markdown body, an optional subject (default "Message from your assistant") and an optional `to` address. It can only email addresses listed under your contacts, and it sends from the first configured mailbox. Your reply to that email starts a new conversation.

## Things to know

- **Mail that arrives while the bus is stopped is picked up when it's back.** The bus remembers the last message it handled, and each time it connects to the mailbox (at start-up or after a dropped connection) it processes anything newer, once. The first time a mailbox is connected, mail already in it is left alone; only new mail reaches the agent.
- **No typing indicator or live progress**, as email has neither.
- **Messages aren't marked as read** by the bus.
- **A forward that your mail app threads with an earlier message** continues that thread's conversation.
