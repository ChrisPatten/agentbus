# E104 — The Compact: Capture (long recordings)

**Status:** approved for build (Chris, Nov 19, 2026: "plan and build the recording functionality")
**Repos:** firmware `~/workspace/intercom-firmware` (branch `capture`), AgentBus (`feat/compact-capture`), Peggy (`.claude/skills/compact-capture`)
**Design:** `~/workspace/peggy-claude-code/data/intercom/design/plum-dusk/spec.md` §6.4, §7.6, §8.1, §8.2, §11; `data/intercom/architecture.md` §15 (Plaud-style recording; Massachusetts all-party consent: the REC indicator must be unmissable).

## Why

BOOT double-press on the Compact shows "Capture: coming soon". Chris wants it to record a conversation or a note, upload it as it goes, and have Peggy summarise and file it (action items to the commitments ledger).

## Stories

### S104.1 — Bus: capture frames and durable spool (this repo)
- `capture_start` / `capture_chunk` / `capture_end` on the surface socket, answered with `capture_ack` (see docs/SURFACE_API.md "Capture: long recordings"). IMA ADPCM chunks (the phone-link codec), base64 in JSON so they never interleave with push-to-talk binary frames.
- Each chunk written to `<spool>/<surface>/<id>/c<seq>.adpcm` before its ack; repeats acked without rewriting; `capture_start` is the resume handshake.

### S104.2 — Bus: assemble, transcribe, file, wake
- On end: WAV (gaps become silence), transcript (ElevenLabs whole + diarized; other engines in pieces), `.txt` + `.json` in `<out_dir>/<date>/`.
- `[capture]` message into the followed conversation (client_msg_id `capture-<id>`), echo `⏺️`.
- Recovery at start and every 10 min; stale recordings (no frames 6 h, no end) assembled as partial.

### S104.3 — Firmware (intercom-firmware `capture`)
- Recorder: mics -> ADPCM 2 s chunks in a PSRAM ring; uploader streams chunks with a window and per-chunk acks; spill to the raw `storage` partition when the bus is unreachable; resume after reconnect or restart.
- Screens per spec §7.6; BOOT double-press start/stop; HOLD TO STOP 0.8 s; no sleep, no push-to-talk while recording; urgent Moments wait ("1 ALERT"); battery refuse < 10%, stop at 5%; 2 h cap; `/info` capture state.

### S104.4 — Peggy skill `compact-capture`
- On a `[capture]` message: read the transcript, write a summary memo beside it, log the daily file, capture commitments per the ledger rules, post a short summary to the Compact topic with `notify` info.

## Acceptance
- Unit tests for the codec (shared firmware vector), ack/resume/dedupe, assembly with a gap, transcription paths, recovery; a WebSocket route test end to end.
- A synthetic capture over the live bus lands files in `data/intercom/captures/` and wakes Peggy once.
- On hardware: `/info` shows capture state; a real double-press recording is uploaded and transcribed (Chris to confirm).
