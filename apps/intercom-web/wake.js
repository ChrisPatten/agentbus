// Keeps the phone screen on while the app is open: Screen Wake Lock API, with a NoSleep-style hidden video
// fallback. Never throws. Whether to hold at a given moment is decided by shouldHoldWakeLock (logic.js).
import { shouldHoldWakeLock } from './logic.js';

// 1 s, 16x16 black H.264 clip (about 1.6 KB), played muted and looping.
const NOSLEEP_MP4 = 'data:video/mp4;base64,AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAuZtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB6XRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAEAAAABAAAAAAAYVtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAEwbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA8HN0YmwAAACkc3RzZAAAAAAAAAABAAAAlGF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAQAEgAAABIAAAAAAAAAAEVTGF2YzYyLjExLjEwMCBsaWJ4MjY0AAAAAAAAAAAAAAAY//8AAAAuYXZjQwFCwAr/4QAWZ0LACtkewEQAAAMABAAAAwAQPEiZIAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjIuMy4xMDAAAABwbW9vZgAAABBtZmhkAAAAAAAAAAEAAABYdHJhZgAAABx0ZmhkAAIAOAAAAAEAACAAAAACgwEBAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAACB0cnVuAAACBQAAAAIAAAB4AgAAAAAAAoMAAAAKAAAClW1kYXQAAAJwBgX//2zcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0yIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAC2WIhAU8mKAAP7+AAAAABkGaOAl6gAAAAENtZnJhAAAAK3RmcmEBAAAAAAAAAQAAAAAAAAABAAAAAAAAAAAAAAAAAAADAgEBAQAAABBtZnJvAAAAAAAAAEM=';

/**
 * @param {{ tz?: string, forceQuiet?: boolean|null, nav?: object, doc?: object, clock?: () => Date }} [opts]
 * @returns {{ evaluate: () => Promise<void>, gesture: () => void }}
 */
export function createWakeKeeper(opts = {}) {
  const nav = opts.nav ?? (typeof navigator !== 'undefined' ? navigator : {});
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
  const clock = opts.clock ?? (() => new Date());
  let lock = null;
  let pending = false;
  let video = null;
  let gestured = false;

  const wanted = () => {
    try {
      return shouldHoldWakeLock({ now: clock(), tz: opts.tz, visible: !doc || doc.visibilityState === 'visible', forceQuiet: opts.forceQuiet ?? null });
    } catch { return false; }
  };

  async function releaseLock() {
    const l = lock; lock = null;
    try { await l?.release(); } catch { /* already released */ }
  }

  async function acquireLock() {
    if (lock || pending) return;
    pending = true;
    try {
      const l = await nav.wakeLock.request('screen');
      lock = l;
      l.addEventListener('release', () => {
        if (lock === l) lock = null;
        if (wanted()) acquireLock(); // released while we still want it (not hidden, not quiet)
      });
      if (!wanted()) await releaseLock(); // conditions changed while the request was in flight
    } catch { lock = null; } finally { pending = false; }
  }

  function startVideo() {
    try {
      if (!doc || !gestured) return;
      if (!video) {
        const v = doc.createElement('video');
        v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.setAttribute('loop', '');
        v.setAttribute('aria-hidden', 'true'); v.setAttribute('tabindex', '-1');
        v.muted = true; v.loop = true; v.playsInline = true;
        v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;';
        v.src = NOSLEEP_MP4;
        doc.body.appendChild(v);
        video = v;
      }
      if (video.paused) { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
    } catch { /* fallback is best effort */ }
  }

  function stopVideo() {
    try { if (video && !video.paused) video.pause(); } catch { /* ignore */ }
  }

  async function evaluate() {
    try {
      const want = wanted();
      if (nav.wakeLock && typeof nav.wakeLock.request === 'function') {
        if (want) await acquireLock(); else await releaseLock();
      } else if (want) startVideo(); else stopVideo();
    } catch { /* never break the UI */ }
  }

  function gesture() {
    if (gestured) return;
    gestured = true;
    evaluate();
  }

  return { evaluate, gesture };
}
