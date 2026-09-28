'use client';

import { useEffect, useRef } from 'react';

/**
 * Six guitar strings across the hero. Each is a damped 1-D wave equation;
 * the page plucks one on load, then strums the rest, and a pointer crossing a
 * string plucks it where it crossed. Vibration energy is also painted onto a
 * blurred "haze" layer that fades slowly, like a reverb tail.
 */
const STRINGS = 6;
const POINTS = 120;
// Thin (high E) at the top to thick (low E) at the bottom.
const GAUGES = [1, 1.3, 1.7, 2.3, 2.9, 3.6];
const COLORS = ['#f6b5d0', '#f29bc4', '#e58cd0', '#c48ae6', '#a489ee', '#8f7bf0'];

type Wire = { y: Float32Array; prev: Float32Array; energy: number };

export function StringField({ reduceMotion }: { reduceMotion: boolean }) {
  const crisp = useRef<HTMLCanvasElement | null>(null);
  const haze = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const sharp = crisp.current;
    const glow = haze.current;
    if (!sharp || !glow) return;
    const ctx = sharp.getContext('2d');
    const hctx = glow.getContext('2d');
    if (!ctx || !hctx) return;

    const wires: Wire[] = Array.from({ length: STRINGS }, () => ({ y: new Float32Array(POINTS), prev: new Float32Array(POINTS), energy: 0 }));
    let width = 0;
    let height = 0;
    let dpr = 1;

    const lineY = (index: number) => height * (0.47 + index * 0.058);

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = sharp.clientWidth;
      height = sharp.clientHeight;
      for (const canvas of [sharp, glow]) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    /** Triangular pluck at fraction `at` of the string, `amount` in px. */
    const pluck = (index: number, at: number, amount: number) => {
      const wire = wires[index];
      const peak = Math.max(2, Math.min(POINTS - 3, Math.round(at * (POINTS - 1))));
      for (let i = 1; i < POINTS - 1; i += 1) {
        const shape = i <= peak ? i / peak : (POINTS - 1 - i) / (POINTS - 1 - peak);
        wire.y[i] += amount * shape;
        wire.prev[i] = wire.y[i];
      }
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      // The haze keeps a fading memory of the strings: the reverb tail.
      hctx.globalCompositeOperation = 'destination-out';
      hctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
      hctx.fillRect(0, 0, width, height);
      hctx.globalCompositeOperation = 'lighter';
      wires.forEach((wire, index) => {
        const base = lineY(index);
        const path = new Path2D();
        for (let i = 0; i < POINTS; i += 1) {
          const x = (i / (POINTS - 1)) * width;
          const y = base + wire.y[i];
          if (i === 0) path.moveTo(x, y);
          else path.lineTo(x, y);
        }
        ctx.lineWidth = GAUGES[index];
        ctx.strokeStyle = COLORS[index];
        ctx.globalAlpha = 0.55 + Math.min(0.45, wire.energy * 0.02);
        ctx.stroke(path);
        if (wire.energy > 0.05) {
          hctx.lineWidth = GAUGES[index] * 5 + Math.min(26, wire.energy * 1.5);
          hctx.strokeStyle = COLORS[index];
          hctx.globalAlpha = Math.min(0.07, 0.008 + wire.energy * 0.004);
          hctx.stroke(path);
        }
      });
      ctx.globalAlpha = 1;
      hctx.globalAlpha = 1;
    };

    const next = new Float32Array(POINTS);
    const step = () => {
      for (const wire of wires) {
        const { y, prev } = wire;
        let energy = 0;
        // Leapfrog update of the damped wave equation (Courant number 0.6).
        for (let i = 1; i < POINTS - 1; i += 1) {
          next[i] = (2 * y[i] - prev[i] + 0.36 * (y[i - 1] - 2 * y[i] + y[i + 1])) * 0.9965;
          energy += Math.abs(next[i]);
        }
        prev.set(y);
        y.set(next);
        wire.energy = energy / POINTS;
      }
    };

    resize();
    if (reduceMotion) {
      const redraw = () => { resize(); draw(); };
      draw();
      window.addEventListener('resize', redraw);
      return () => window.removeEventListener('resize', redraw);
    }

    // Opening: one string, then a slow strum through all six.
    const timers = [
      window.setTimeout(() => pluck(2, 0.38, 26), 350),
      ...Array.from({ length: STRINGS }, (_, index) => window.setTimeout(() => pluck(index, 0.62, 16 + index * 2), 1_150 + index * 70)),
    ];

    let last: { x: number; y: number } | null = null;
    const onMove = (event: PointerEvent) => {
      const rect = sharp.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (last && point.x >= 0 && point.x <= width) {
        for (let index = 0; index < STRINGS; index += 1) {
          const lineAt = lineY(index);
          if ((last.y - lineAt) * (point.y - lineAt) < 0) {
            const speed = Math.min(40, Math.abs(point.y - last.y));
            pluck(index, point.x / width, Math.sign(point.y - last.y) * (6 + speed * 0.5));
          }
        }
      }
      last = point;
    };
    const onLeave = () => { last = null; };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', resize);

    let frame = 0;
    let visible = true;
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    observer.observe(sharp);
    const loop = () => {
      if (visible && !document.hidden) {
        step();
        step();
        draw();
      }
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', resize);
    };
  }, [reduceMotion]);

  return (
    <div className="string-field" aria-hidden="true">
      <canvas ref={haze} className="string-haze" />
      <canvas ref={crisp} className="string-wires" />
    </div>
  );
}
