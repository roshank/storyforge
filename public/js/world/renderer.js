// Wonder World: draws a story's scene with WebGPU (SDF shader), with a simple
// Canvas 2D fallback when WebGPU isn't available.
import { WGSL, UNIFORM_SIZE, MAX_CHARS, SETTING_IDS, TIME_IDS, KIND_IDS } from './shader.js';
import { COLORS } from '../shared/prompts.js';

/** Place characters left→right along the ground. Pure, so it can be tested. */
export function layoutCharacters(scene, aspect) {
  const chars = scene.characters.slice(0, MAX_CHARS);
  const n = chars.length;
  const span = Math.min(aspect * 0.78, 0.36 * n + 0.1);
  const scale = n <= 2 ? 0.15 : n <= 3 ? 0.13 : 0.11;
  return chars.map((c, i) => {
    const x = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
    let y = -0.3 + (i % 2 ? 0.025 : -0.015);
    if (scene.setting === 'space') y = -0.18 + (i % 2 ? 0.08 : -0.02);
    if (scene.setting === 'ocean' && c.kind !== 'fish') y = -0.37;
    if (scene.setting === 'ocean' && c.kind === 'fish') y = -0.24;
    if (c.kind === 'star' || c.kind === 'ghost') y += 0.08;
    return { ...c, x, y, scale, phase: (i * 0.37) % 1 };
  });
}

export class WonderWorld {
  constructor(canvas, labelLayer) {
    this.canvas = canvas;
    this.labels = labelLayer;
    this.scene = { setting: 'forest', time: 'night', characters: [] };
    this.mode = 'none';
    this.start = performance.now();
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  async init() {
    if (navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('No WebGPU adapter');
        this.device = await adapter.requestDevice();
        this.ctx = this.canvas.getContext('webgpu');
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
        const module = this.device.createShaderModule({ code: WGSL });
        const info = await module.getCompilationInfo?.();
        const errors = info?.messages?.filter((m) => m.type === 'error') ?? [];
        if (errors.length) throw new Error(errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n'));
        this.pipeline = this.device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
          primitive: { topology: 'triangle-list' },
        });
        this.ubo = this.device.createBuffer({ size: UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.bind = this.device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: this.ubo } }],
        });
        this.uniforms = new Float32Array(UNIFORM_SIZE / 4);
        this.device.lost.then((i) => {
          if (this.disposed) return;
          console.warn('WebGPU device lost, switching to 2D:', i.message);
          this.useFallback();
        });
        this.mode = 'webgpu';
      } catch (err) {
        console.warn('WebGPU unavailable, using 2D fallback:', err);
        this.useFallback();
      }
    } else {
      this.useFallback();
    }
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this.resize();
    const loop = () => { if (this.disposed) return; this.frame(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
    return this.mode;
  }

  useFallback() {
    this.mode = '2d';
    this.device = null;
    // A canvas that had a webgpu context can't switch; swap in a fresh one.
    if (this.ctx && !(this.ctx instanceof CanvasRenderingContext2D)) {
      const fresh = this.canvas.cloneNode();
      this.canvas.replaceWith(fresh);
      this.canvas = fresh;
    }
    this.ctx2d = this.canvas.getContext('2d');
    if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver.observe(this.canvas); }
    this.resize();
    this.onModeChange?.(this.mode);
  }

  destroy() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.device?.destroy();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.placeLabels();
  }

  setScene(scene) {
    this.scene = scene;
    this.placeLabels();
  }

  placeLabels() {
    if (!this.labels) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    const placed = layoutCharacters(this.scene, w / h);
    this.labels.replaceChildren(...placed.map((c) => {
      const el = document.createElement('span');
      el.className = 'char-label';
      el.textContent = c.name;
      // world coords: x in [-aspect/2, aspect/2], y in [-0.5, 0.5] (y up)
      el.style.left = `${(c.x / (w / h) + 0.5) * 100}%`;
      el.style.top = `${(0.5 - (c.y - c.scale * 0.85)) * 100}%`;
      return el;
    }));
  }

  frame() {
    if (document.hidden) return;
    const t = ((performance.now() - this.start) / 1000) * (this.reducedMotion ? 0.25 : 1);
    if (this.mode === 'webgpu') this.drawGpu(t);
    else if (this.mode === '2d') this.draw2d(t);
  }

  drawGpu(t) {
    const { width, height } = this.canvas;
    const u = this.uniforms;
    const placed = layoutCharacters(this.scene, width / height);
    u.fill(0);
    u[0] = width; u[1] = height; u[2] = t;
    u[3] = SETTING_IDS[this.scene.setting] ?? 0;
    u[4] = TIME_IDS[this.scene.time] ?? 0;
    u[5] = placed.length;
    placed.forEach((c, i) => {
      const o = 8 + i * 8;
      const rgb = COLORS[c.color] ?? COLORS.purple;
      u.set([c.x, c.y, c.scale, KIND_IDS[c.kind] ?? 9, rgb[0], rgb[1], rgb[2], c.phase], o);
    });
    this.device.queue.writeBuffer(this.ubo, 0, u);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  draw2d(t) {
    const ctx = this.ctx2d;
    const { width: w, height: h } = this.canvas;
    const sky = { night: ['#0a0d29', '#382866'], dusk: ['#2e1f61', '#fa8f6b'], day: ['#59a0f2', '#c7e6ff'] }[this.scene.time] ?? ['#0a0d29', '#382866'];
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, sky[0]); g.addColorStop(1, sky[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    if (this.scene.time !== 'day') {
      for (let i = 0; i < 60; i++) {
        const x = ((i * 97) % 100) / 100 * w, y = ((i * 53) % 60) / 100 * h;
        ctx.globalAlpha = 0.4 + 0.4 * Math.sin(t * 2 + i);
        ctx.fillStyle = '#fff'; ctx.fillRect(x, y, 2, 2);
      }
      ctx.globalAlpha = 1;
    }
    const ground = { ocean: '#1d4f86', space: '#55507a', desert: '#e9c178', city: '#5b5b70' }[this.scene.setting] ?? '#3f7a45';
    ctx.fillStyle = ground;
    ctx.beginPath(); ctx.ellipse(w / 2, h * 1.05, w * 0.8, h * 0.38, 0, 0, Math.PI * 2); ctx.fill();
    const placed = layoutCharacters(this.scene, w / h);
    const emoji = { fox: '🦊', bunny: '🐰', bear: '🐻', cat: '🐱', owl: '🦉', dragon: '🐲', robot: '🤖', fish: '🐟',
      unicorn: '🦄', child: '🧒', star: '⭐', ghost: '👻', mouse: '🐭', turtle: '🐢' };
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of placed) {
      const px = (c.x / (w / h) + 0.5) * w;
      const py = (0.5 - c.y) * h + Math.sin(t * 2 + c.phase * 6) * h * 0.01;
      ctx.font = `${Math.round(c.scale * h * 1.4)}px serif`;
      ctx.fillText(emoji[c.kind] ?? '✨', px, py);
    }
  }
}
