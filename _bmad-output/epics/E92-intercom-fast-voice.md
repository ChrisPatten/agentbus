# E92 — Intercom Fast Voice Input

| Field | Value |
|---|---|
| Epic ID | E92 |
| Dependencies | E90 (follow and echo), E91 (socket) |
| Story Count | 5 |
| Estimated Complexity | L |
| Status | Scoped — not started |

Source: `data/intercom/intercom-prd.md` v1.1, section 6 (V1 to V7), section 8 (latency budget).

## Epic Summary

Push-to-talk audio from a surface is transcribed locally on bobafett with latency as the top priority, and the final transcript enters the followed conversation like a typed send. No text-to-speech.

## Scope

- **S92.1 Capture and framing (V1).** 16 kHz mono PCM in roughly 100 to 200 ms chunks while held; `audio_start`, binary frames and `audio_end` with an `interaction_id`. iPhone needs HTTPS for `getUserMedia`; iOS audio behaviour is the open question Q5.
- **S92.2 STT engine benchmark and server (V2).** Compare whisper.cpp (Metal, `base.en`, `small.en`), MLX Whisper and Parakeet-MLX on Chris's samples; run the winner resident and warm.
- **S92.3 Latency target (V3).** Final transcript at most 700 ms after release at p50 and 1.2 s at p95 for a 2 to 6 second utterance; extend the I7 marks with `ptt_release` and `transcript_final`.
- **S92.4 Flow and failure (V4, V5, V6).** Transcript becomes an inbound send in the followed conversation (with the existing echo); "Didn't catch that" on no speech; audio kept 24 hours then deleted.
- **S92.5 Voice sample bank (V7).** With a config flag, keep clean clips with transcripts, capped near 30 minutes, for the later wake-word and voiceprint work (E94).
