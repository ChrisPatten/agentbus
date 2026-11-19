#!/usr/bin/env python3
"""Local long-form transcription for Intercom Capture (whisper.cpp, Metal on Apple Silicon).

    whisper-local.py <wav> [<lang>]

Prints one JSON object on stdout:

    {"text": "...", "segments": [{"start": 1.2, "end": 6.8, "text": "..."}], "language": "en", "engine": "whisper.cpp:large-v3-turbo"}

`start`/`end` are seconds from the start of the recording. There are no speaker labels (Whisper has no diarization).

How it works:
1. Silero VAD (`whisper-vad-speech-segments`) finds the stretches with speech. Fast: about 1 s per 3 min of audio.
2. `whisper-cli` transcribes the whole file once WITHOUT VAD, so segment times stay exact (whisper.cpp's own `--vad`
   packs the speech together and its timestamps drift by tens of seconds across long pauses).
3. Segments that overlap no speech are dropped: Whisper fills silent 30 s windows with stock captions ("Thank you.").
   Without the VAD model, step 1 is skipped and nothing is dropped here (agentbus still drops the stock captions).

Environment (all optional):
  WHISPER_CLI          whisper-cli binary              (default: whisper-cli on PATH, then /opt/homebrew/bin/whisper-cli)
  WHISPER_VAD_BIN      whisper-vad-speech-segments     (default: beside whisper-cli)
  WHISPER_MODEL        ggml model                      (default: ~/.cache/whisper-cpp/ggml-large-v3-turbo.bin)
  WHISPER_VAD_MODEL    Silero ggml model, "" disables  (default: ~/.cache/whisper-cpp/ggml-silero-v5.1.2.bin)
  WHISPER_THREADS      CPU threads                     (default: 4)
  WHISPER_BEAM         beam size, 1 = greedy (faster)  (default: 5)
  WHISPER_PROMPT       initial prompt (names, vocabulary)

SIGTERM/SIGINT stop the running child too (agentbus aborts a job that passes capture.timeout_s). Exit codes:
0 ok, 2 usage, 3 missing binary/model, 4 whisper failed.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import wave

HOME = os.path.expanduser("~")
CHILD = None


def die(code, msg):
    sys.stderr.write(f"whisper-local: {msg}\n")
    sys.exit(code)


def on_signal(signum, _frame):
    if CHILD and CHILD.poll() is None:
        CHILD.terminate()
        try:
            CHILD.wait(timeout=5)
        except subprocess.TimeoutExpired:
            CHILD.kill()
    sys.exit(128 + signum)


def run(argv):
    """Run a child we can stop on SIGTERM; returns (code, stdout, stderr tail)."""
    global CHILD
    with tempfile.TemporaryFile() as err:
        CHILD = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=err)
        out, _ = CHILD.communicate()
        code = CHILD.returncode
        CHILD = None
        err.seek(0)
        tail = err.read()[-2000:].decode("utf-8", "replace")
    return code, out.decode("utf-8", "replace"), tail


def find_bin(env, name, beside=None):
    path = os.environ.get(env)
    if path:
        return path
    if beside:
        cand = os.path.join(os.path.dirname(beside), name)
        if os.access(cand, os.X_OK):
            return cand
    return shutil.which(name) or (f"/opt/homebrew/bin/{name}" if os.access(f"/opt/homebrew/bin/{name}", os.X_OK) else None)


def speech_regions(vad_bin, vad_model, wav, threads):
    """[(start_s, end_s)] from whisper-vad-speech-segments (it prints centiseconds), or None if VAD is unavailable."""
    code, out, tail = run([vad_bin, "-vm", vad_model, "-f", wav, "-t", str(threads)])
    if code != 0:
        sys.stderr.write(f"whisper-local: VAD failed ({code}), keeping every segment: {tail.strip()[-300:]}\n")
        return None
    regions = [(float(a) / 100.0, float(b) / 100.0)
               for a, b in re.findall(r"start\s*=\s*([\d.]+),\s*end\s*=\s*([\d.]+)", out)]
    return regions


def main():
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        sys.stderr.write(__doc__)
        sys.exit(2)
    wav = sys.argv[1]
    lang = (sys.argv[2] if len(sys.argv) > 2 else "").strip() or "auto"
    if not os.path.isfile(wav):
        die(2, f"no such file: {wav}")

    cli = find_bin("WHISPER_CLI", "whisper-cli")
    if not cli:
        die(3, "whisper-cli not found (brew install whisper.cpp)")
    model = os.environ.get("WHISPER_MODEL") or os.path.join(HOME, ".cache/whisper-cpp/ggml-large-v3-turbo.bin")
    if not os.path.isfile(model):
        die(3, f"model not found: {model}")
    vad_model = os.environ.get("WHISPER_VAD_MODEL", os.path.join(HOME, ".cache/whisper-cpp/ggml-silero-v5.1.2.bin"))
    vad_bin = find_bin("WHISPER_VAD_BIN", "whisper-vad-speech-segments", beside=cli) if vad_model else None
    threads = int(os.environ.get("WHISPER_THREADS", "4"))
    beam = int(os.environ.get("WHISPER_BEAM", "5"))

    with tempfile.TemporaryDirectory(prefix="whisper-local-") as tmp:
        src = wav
        with wave.open(wav, "rb") as w:
            rate, channels = w.getframerate(), w.getnchannels()
        if rate != 16000 or channels != 1:
            ffmpeg = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
            src = os.path.join(tmp, "in16k.wav")
            code, _, tail = run([ffmpeg, "-loglevel", "error", "-y", "-i", wav, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", src])
            if code != 0:
                die(4, f"ffmpeg resample failed: {tail.strip()[-300:]}")

        regions = None
        if vad_model and vad_bin and os.path.isfile(vad_model):
            regions = speech_regions(vad_bin, vad_model, src, threads)
            if regions == []:
                print(json.dumps({"text": "", "segments": [], "language": lang, "engine": engine_name(model)}))
                return

        prefix = os.path.join(tmp, "out")
        argv = [cli, "-m", model, "-f", src, "-l", lang, "-t", str(threads), "-bs", str(beam),
                "-np", "-oj", "-of", prefix]
        if os.environ.get("WHISPER_PROMPT"):
            argv += ["--prompt", os.environ["WHISPER_PROMPT"]]
        code, _, tail = run(argv)
        if code != 0:
            die(4, f"whisper-cli exited {code}: {tail.strip()[-500:]}")
        with open(prefix + ".json", encoding="utf-8", errors="replace") as f:
            result = json.load(f)

    segments = []
    pad = 0.3
    for s in result.get("transcription", []):
        text = re.sub(r"\s+", " ", s.get("text", "")).strip()
        off = s.get("offsets", {})
        start, end = off.get("from", 0) / 1000.0, off.get("to", 0) / 1000.0
        if not text:
            continue
        if regions is not None and not any(a - pad < end and start < b + pad for a, b in regions):
            continue
        segments.append({"start": round(start, 2), "end": round(end, 2), "text": text})
    detected = (result.get("result") or {}).get("language") or lang
    print(json.dumps({
        "text": " ".join(s["text"] for s in segments),
        "segments": segments,
        "language": detected,
        "engine": engine_name(model),
    }, ensure_ascii=False))


def engine_name(model):
    base = os.path.basename(model)
    base = re.sub(r"^ggml-", "", re.sub(r"\.bin$", "", base))
    return f"whisper.cpp:{base}"


if __name__ == "__main__":
    main()
