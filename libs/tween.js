/**
 * tween.js — minimal dependency-free tween/interpolation helpers used by
 * the UI and camera systems. Not the npm @tweenjs package: this project
 * vendors a tiny purpose-built implementation to stay self-contained.
 */

export const Easing = {
  linear: (t) => t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  outCubic: (t) => 1 + (--t) * t * t,
  outBack: (t) => { const s = 1.70158; return 1 + (--t) * t * ((s + 1) * t + s); },
  outElastic: (t) => t === 0 || t === 1 ? t
    : Math.pow(2, -10 * t) * Math.sin((t - 0.075) * (2 * Math.PI) / 0.3) + 1
};

/**
 * Animate numeric properties of an object over `duration` ms.
 * Returns a cancel function.
 */
export function tween(obj, props, duration = 400, ease = Easing.outCubic, onUpdate, onDone) {
  const start = {};
  for (const k of Object.keys(props)) start[k] = obj[k];
  const t0 = performance.now();
  let raf = 0, cancelled = false;

  function frame(now) {
    if (cancelled) return;
    const t = Math.min(1, (now - t0) / duration);
    const e = ease(t);
    for (const k of Object.keys(props)) obj[k] = start[k] + (props[k] - start[k]) * e;
    if (onUpdate) onUpdate(obj, t);
    if (t < 1) raf = requestAnimationFrame(frame);
    else if (onDone) onDone(obj);
  }
  raf = requestAnimationFrame(frame);
  return () => { cancelled = true; cancelAnimationFrame(raf); };
}

/** Animate a number from a to b, calling fn(value) each frame. */
export function tweenValue(a, b, duration, fn, ease = Easing.outCubic, onDone) {
  const holder = { v: a };
  return tween(holder, { v: b }, duration, ease, (o) => fn(o.v), onDone);
}

/** Exponential smoothing helper for per-frame lerps (framerate independent). */
export function damp(current, target, lambda, dt) {
  return target + (current - target) * Math.exp(-lambda * dt);
}
