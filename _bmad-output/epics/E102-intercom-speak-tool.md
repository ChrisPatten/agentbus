# E102 — Intercom agent-authored speech: the `speak` tool and a once-per-session voice style guide

| Field | Value |
|---|---|
| Epic ID | E102 |
| Dependencies | E92 (push-to-talk, spoken replies), E96 (Surface API v2) |
| Story Count | 4 |
| Estimated Complexity | M |
| Status | Built on `feat/intercom-speak-tool` (Nov 9, 2026); not merged or deployed |

## Goal

Today the bus speaks a clipped version of whatever the agent replies (body if at most 160 characters, else the glance). The agent has no say in what is said aloud. Give it a `speak` tool for push-to-talk messages, keep automatic speech only as a fallback, and give the agent the owner's voice style guide once per session.

## Stories

1. **S102.1 `speak(message_id, text)` MCP tool + `POST /api/v1/speak`.** Allowed only for a voice message in its open interaction (reply window, `max_replies`, no typed send since). Device resolved by the bus, never named by the agent. All speech guards apply; text up to `voice.speech.speak_max_chars` (400); ElevenLabs audio tags pass through to TTS and are not counted or shown. Returns `spoken` / `queued` / `skipped(reason)` at once; utterances queue per socket instead of cutting each other off.
2. **S102.2 Device answer and record.** A successful call emits the interaction's `reply` event with the spoken text (`spoken: true`), which the Compact firmware already renders on Understood (no firmware change). Later `reply()` events in that interaction keep the spoken text as `body`/`glance`. The tool posts `🔊 text` as a silent agent message (`metadata.intercom_spoken`) so the Thread, transcript, journaling and Telegram see it; the bus neither re-emits nor re-speaks it.
3. **S102.3 Fallback auto-speech.** `voice.speech.fallback` (default true) and `fallback_grace_s` (default 3): if no `speak` arrives that long after the first reply, speak the glance or short body as before. A `speak` call cancels it; after `speak`, replies are never auto-spoken.
4. **S102.4 Voice style guide, once per session.** `voice.speech.style_file`. Pipeline stage 89 attaches the file (read fresh) as a system block on a voice message the first time an agent session gets one, and again when the content hash changes. Key: bus `sessions.id` + route pane; persisted in `voice_style_injections` (migration 47), so a bus restart does not re-inject. Per-message voice note stays short and says: speech transcript, call `speak` first.

## Decisions and limits

- The style guide is its own system block (`kind="voice-style"`) ahead of the per-message Intercom note, not text inside that note, so the one-line note stays short.
- The bus cannot see Claude compaction; a guide compacted away returns on the next new session, pane change or file edit. Marked delivered at enqueue, not pane ack (as advisories).
- `speak` skipped because of a guard records and shows nothing; the agent falls back to `reply()`.
- ElevenLabs tags are read aloud by models that do not support them: set `voice.elevenlabs.tts_model` to a tag-aware model (`eleven_v4_turbo`) before using them.

## Docs

`docs/SURFACE_API.md` ("The `speak` tool"), `docs/INTERCOM.md` (config), `site-docs/channels/intercom.md`, `CHANGELOG.md`.
