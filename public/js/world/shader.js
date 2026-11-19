// WGSL for the Wonder World: one full-screen fragment shader that paints the sky,
// the setting, and up to 5 characters with signed distance fields.

export const MAX_CHARS = 5;

export const SETTING_IDS = { forest: 0, ocean: 1, space: 2, castle: 3, meadow: 4, mountains: 5, desert: 6, city: 7 };
export const TIME_IDS = { night: 0, dusk: 1, day: 2 };
export const KIND_IDS = {
  fox: 0, bunny: 1, bear: 2, cat: 3, owl: 4, dragon: 5, robot: 6, fish: 7,
  unicorn: 8, child: 9, star: 10, ghost: 11, mouse: 12, turtle: 13,
};

// Uniform layout (bytes): res(8) time(4) setting(4) tod(4) count(4) pad(8) = 32, then chars[5] x 32.
export const UNIFORM_SIZE = 32 + MAX_CHARS * 32;

export const WGSL = /* wgsl */ `
struct Char {
  pos: vec4f,   // x, y, scale, kind
  color: vec4f, // r, g, b, phase
};
struct U {
  res: vec2f,
  time: f32,
  setting: f32,
  tod: f32,
  count: f32,
  pad: vec2f,
  chars: array<Char, ${MAX_CHARS}>,
};
@group(0) @binding(0) var<uniform> u: U;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(3.0, 1.0), vec2f(-1.0, 1.0));
  return vec4f(p[i], 0.0, 1.0);
}

// ---------- helpers ----------
fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}
fn rot(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn sdCircle(p: vec2f, r: f32) -> f32 { return length(p) - r; }
fn sdEllipse(p: vec2f, r: vec2f) -> f32 { return (length(p / r) - 1.0) * min(r.x, r.y); }
fn sdBox(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
fn sdSeg(p: vec2f, a: vec2f, b: vec2f, r: f32) -> f32 {
  let pa = p - a; let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
fn sdTri(p: vec2f, p0: vec2f, p1: vec2f, p2: vec2f) -> f32 {
  let e0 = p1 - p0; let e1 = p2 - p1; let e2 = p0 - p2;
  let v0 = p - p0; let v1 = p - p1; let v2 = p - p2;
  let pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  let pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  let pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  let s = sign(e0.x * e2.y - e0.y * e2.x);
  let d = min(min(vec2f(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                  vec2f(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                  vec2f(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
fn sdStar(pin: vec2f, r: f32, rf: f32) -> f32 {
  let k1 = vec2f(0.809016994375, -0.587785252292);
  let k2 = vec2f(-k1.x, k1.y);
  var p = vec2f(abs(pin.x), pin.y);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  let ba = rf * vec2f(-k1.y, k1.x) - vec2f(0.0, 1.0);
  let h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
fn fill(d: f32, aa: f32) -> f32 { return 1.0 - smoothstep(-aa, aa, d); }
fn paint(col: ptr<function, vec3f>, c: vec3f, d: f32, aa: f32) { *col = mix(*col, c, fill(d, aa)); }

// ---------- sky + settings ----------
fn sky(p: vec2f, t: f32, tod: f32, setting: f32) -> vec3f {
  let h = p.y + 0.5;
  var top = vec3f(0.04, 0.05, 0.16);
  var bot = vec3f(0.22, 0.16, 0.4);
  if (tod > 0.5 && tod < 1.5) { top = vec3f(0.18, 0.12, 0.38); bot = vec3f(0.98, 0.56, 0.42); }
  if (tod > 1.5) { top = vec3f(0.35, 0.62, 0.95); bot = vec3f(0.78, 0.9, 1.0); }
  if (setting == 2.0) { top = vec3f(0.01, 0.01, 0.06); bot = vec3f(0.12, 0.06, 0.25); }
  var col = mix(bot, top, smoothstep(0.0, 1.0, h));

  // stars
  let starAmt = select(select(0.0, 0.5, tod < 1.5), 1.0, tod < 0.5 || setting == 2.0);
  if (starAmt > 0.0) {
    let g = p * 60.0;
    let id = floor(g);
    let f = fract(g) - 0.5;
    let r = hash21(id);
    if (r > 0.93) {
      let tw = 0.5 + 0.5 * sin(t * (1.0 + r * 3.0) + r * 40.0);
      let s = 1.0 - smoothstep(0.0, 0.08 + 0.06 * tw, length(f - (vec2f(hash21(id + 3.1), hash21(id + 7.7)) - 0.5) * 0.6));
      col += vec3f(1.0, 0.95, 0.85) * s * starAmt * (0.5 + tw);
    }
  }
  // moon / sun
  let mp = p - vec2f(0.55 * u.res.x / u.res.y - 0.3, 0.32);
  if (tod < 1.5) {
    let md = length(mp);
    col += vec3f(0.9, 0.85, 0.7) * 0.25 * exp(-md * 8.0);
    var moon = fill(md - 0.07, 0.003);
    moon *= smoothstep(0.0, 0.01, length(mp - vec2f(0.03, 0.02)) - 0.062);
    col = mix(col, vec3f(1.0, 0.96, 0.82), moon);
  } else {
    let sd = length(mp);
    col += vec3f(1.0, 0.85, 0.4) * 0.35 * exp(-sd * 6.0);
    col = mix(col, vec3f(1.0, 0.92, 0.55), fill(sd - 0.075, 0.003));
  }
  return col;
}

fn nightTint(c: vec3f, tod: f32) -> vec3f {
  if (tod < 0.5) { return c * vec3f(0.42, 0.48, 0.75); }
  if (tod < 1.5) { return c * vec3f(0.85, 0.65, 0.7); }
  return c;
}

fn world(p: vec2f, t: f32) -> vec3f {
  let tod = u.tod;
  let s = u.setting;
  let aa = 1.5 / u.res.y;
  var col = sky(p, t, tod, s);
  let x = p.x;

  if (s == 2.0) { // space: planets + asteroid floor
    let pl = p - vec2f(-0.55, 0.22);
    paint(&col, vec3f(0.55, 0.4, 0.9), sdCircle(pl, 0.12), aa);
    paint(&col, vec3f(0.7, 0.55, 1.0), sdCircle(pl + vec2f(0.03, -0.03), 0.07), aa);
    paint(&col, vec3f(0.95, 0.75, 0.5), abs(sdEllipse(pl * rot(0.3), vec2f(0.22, 0.04))) - 0.006, aa);
    paint(&col, vec3f(0.3, 0.75, 0.75), sdCircle(p - vec2f(0.15, 0.36), 0.04), aa);
    paint(&col, vec3f(0.42, 0.4, 0.55), sdEllipse(p - vec2f(0.0, -0.75), vec2f(1.5, 0.32)), aa);
    for (var i = 0; i < 6; i++) {
      let fi = f32(i);
      paint(&col, vec3f(0.33, 0.31, 0.45), sdCircle(p - vec2f(-0.9 + fi * 0.36, -0.5 - 0.03 * sin(fi * 2.0)), 0.025 + 0.01 * fi % 0.02), aa);
    }
    return col;
  }

  // far layer
  if (s == 0.0) { // forest: pine silhouettes
    let cell = floor(x * 7.0);
    let fx = fract(x * 7.0) - 0.5;
    let hgt = 0.12 + 0.1 * hash21(vec2f(cell, 1.0));
    let base = -0.12;
    var d = 1.0;
    for (var k = 0; k < 3; k++) {
      let fk = f32(k);
      let y0 = base + fk * hgt * 0.35;
      d = min(d, sdTri(vec2f(fx / 7.0, p.y), vec2f(-0.055 + fk * 0.012, y0), vec2f(0.055 - fk * 0.012, y0), vec2f(0.0, y0 + hgt * 0.55)));
    }
    paint(&col, nightTint(vec3f(0.12, 0.35, 0.25), tod), d, aa);
  } else if (s == 3.0) { // castle
    var d = sdBox(p - vec2f(0.0, -0.05), vec2f(0.22, 0.12), 0.0);
    d = min(d, sdBox(p - vec2f(-0.22, 0.02), vec2f(0.05, 0.19), 0.0));
    d = min(d, sdBox(p - vec2f(0.22, 0.02), vec2f(0.05, 0.19), 0.0));
    d = min(d, sdBox(p - vec2f(0.0, 0.08), vec2f(0.06, 0.22), 0.0));
    d = min(d, sdTri(p, vec2f(-0.28, 0.21), vec2f(-0.16, 0.21), vec2f(-0.22, 0.32)));
    d = min(d, sdTri(p, vec2f(0.16, 0.21), vec2f(0.28, 0.21), vec2f(0.22, 0.32)));
    d = min(d, sdTri(p, vec2f(-0.07, 0.3), vec2f(0.07, 0.3), vec2f(0.0, 0.44)));
    paint(&col, nightTint(vec3f(0.62, 0.55, 0.78), tod), d, aa);
    let win = sdBox(vec2f(fract((p.x + 0.5) * 20.0) - 0.5, p.y - 0.0), vec2f(0.18, 0.025), 0.01);
    if (abs(p.x) < 0.2 && tod < 1.5) { paint(&col, vec3f(1.0, 0.85, 0.45), max(win, -0.0), aa * 20.0); }
    paint(&col, vec3f(1.0, 0.6, 0.7), sdTri(p - vec2f(0.0, 0.44), vec2f(0.0, 0.0), vec2f(0.0, 0.05), vec2f(0.06 + 0.01 * sin(t * 3.0), 0.03)), aa);
  } else if (s == 5.0) { // mountains
    var d = 1.0;
    var snow = 1.0;
    for (var k = 0; k < 4; k++) {
      let fk = f32(k);
      let cx = -0.8 + fk * 0.55;
      let hh = 0.2 + 0.12 * hash21(vec2f(fk, 4.0));
      let tri = sdTri(p, vec2f(cx - 0.35, -0.2), vec2f(cx + 0.35, -0.2), vec2f(cx, -0.2 + hh + 0.15));
      d = min(d, tri);
      snow = min(snow, max(tri, -(p.y - (-0.2 + hh + 0.15) + 0.07 + 0.01 * sin(p.x * 80.0))));
    }
    paint(&col, nightTint(vec3f(0.45, 0.48, 0.68), tod), d, aa);
    paint(&col, nightTint(vec3f(0.95, 0.97, 1.0), tod), snow, aa);
  } else if (s == 7.0) { // city skyline with lit windows
    let cell = floor(x * 9.0);
    let fx = fract(x * 9.0);
    let hgt = -0.12 + 0.22 * hash21(vec2f(cell, 9.0));
    let inB = step(0.08, fx) * step(fx, 0.92) * step(p.y, hgt);
    col = mix(col, nightTint(vec3f(0.3, 0.3, 0.45), tod), inB);
    let wg = vec2f(fx * 6.0, p.y * 40.0);
    let lit = step(0.55, hash21(floor(wg) + cell * 13.0)) * step(0.3, fract(wg.x)) * step(0.35, fract(wg.y));
    if (tod < 1.5) { col = mix(col, vec3f(1.0, 0.86, 0.5), inB * lit * step(0.15, fx) * step(fx, 0.85)); }
  }

  // ground
  var groundCol = vec3f(0.36, 0.68, 0.36);
  var gy = -0.2 + 0.035 * sin(x * 3.0 + 1.0) + 0.02 * sin(x * 7.0);
  if (s == 6.0) { groundCol = vec3f(0.93, 0.75, 0.45); gy = -0.2 + 0.05 * sin(x * 2.5) + 0.02 * sin(x * 6.0 + 2.0); }
  if (s == 7.0) { groundCol = vec3f(0.42, 0.42, 0.5); gy = -0.2; }
  if (s == 5.0) { groundCol = vec3f(0.5, 0.72, 0.5); }
  if (s == 1.0) { // ocean
    let wave = -0.15 + 0.012 * sin(x * 18.0 + t * 1.5) + 0.008 * sin(x * 31.0 - t * 2.0);
    let w = step(p.y, wave);
    var water = mix(vec3f(0.1, 0.35, 0.6), vec3f(0.05, 0.18, 0.4), smoothstep(-0.15, -0.5, p.y));
    water = nightTint(water, tod);
    col = mix(col, water, w);
    // moon/sun glitter
    let gx = 0.55 * u.res.x / u.res.y - 0.3;
    let glit = exp(-abs(x - gx) * 14.0) * step(0.6, fract(p.y * 40.0 + sin(x * 30.0 + t) * 0.5));
    col += vec3f(1.0, 0.9, 0.7) * glit * w * 0.35;
    // sandy foreground
    let sandY = -0.42 + 0.03 * sin(x * 2.0);
    col = mix(col, nightTint(vec3f(0.93, 0.8, 0.55), tod), step(p.y, sandY));
    return col;
  }
  col = mix(col, nightTint(groundCol, tod), fill(p.y - gy, aa));
  // near hill
  let ny = -0.36 + 0.04 * sin(x * 2.0 + 3.0);
  col = mix(col, nightTint(groundCol * 0.82, tod), fill(p.y - ny, aa));

  if (s == 4.0 || s == 0.0) { // flowers / grass tufts
    let g = vec2f(p.x * 22.0, p.y * 22.0);
    let id = floor(g);
    let r = hash21(id + 2.0);
    if (r > 0.82 && p.y < gy - 0.02) {
      let f = fract(g) - 0.5;
      var fc = vec3f(1.0, 0.75, 0.85);
      if (r > 0.94) { fc = vec3f(1.0, 0.9, 0.5); } else if (r > 0.88) { fc = vec3f(0.75, 0.7, 1.0); }
      if (s == 0.0) { fc = vec3f(0.55, 0.9, 0.55); }
      col = mix(col, nightTint(fc, tod), fill(length(f) - 0.12, 0.05));
    }
  }
  return col;
}

// ---------- characters ----------
fn eyes(col: ptr<function, vec3f>, q: vec2f, c: vec2f, sep: f32, r: f32, aa: f32, t: f32, phase: f32) {
  let blink = select(1.0, 0.12, fract(t * 0.23 + phase) > 0.965);
  for (var sgn = -1.0; sgn < 2.0; sgn += 2.0) {
    let e = q - c - vec2f(sgn * sep, 0.0);
    paint(col, vec3f(0.08, 0.07, 0.12), sdEllipse(e, vec2f(r, r * blink + 0.001)), aa);
    paint(col, vec3f(1.0), sdCircle(e - vec2f(r * 0.35, r * 0.35), r * 0.35 * blink), aa);
  }
}
fn smile(col: ptr<function, vec3f>, q: vec2f, c: vec2f, r: f32, aa: f32) {
  let d = max(abs(length(q - c) - r) - 0.018, q.y - c.y + r * 0.35);
  paint(col, vec3f(0.12, 0.08, 0.12), d, aa);
}
fn cheeks(col: ptr<function, vec3f>, q: vec2f, c: vec2f, sep: f32, aa: f32) {
  paint(col, vec3f(1.0, 0.55, 0.62), sdEllipse(q - c - vec2f(sep, 0.0), vec2f(0.07, 0.045)), aa * 3.0);
  paint(col, vec3f(1.0, 0.55, 0.62), sdEllipse(q - c + vec2f(sep, 0.0), vec2f(0.07, 0.045)), aa * 3.0);
}

fn drawChar(col: ptr<function, vec3f>, p: vec2f, ch: Char, t: f32) {
  let kind = ch.pos.w;
  let sc = ch.pos.z;
  let phase = ch.color.w;
  let base = ch.color.xyz;
  let dark = base * 0.62;
  let light = mix(base, vec3f(1.0), 0.55);
  let floaty = kind == 10.0 || kind == 11.0 || kind == 7.0 || u.setting == 2.0;
  let bob = select(abs(sin(t * 2.2 + phase * 6.28)) * 0.04, sin(t * 1.4 + phase * 6.28) * 0.12, floaty);
  var q = (p - ch.pos.xy) / sc - vec2f(0.0, bob);
  q = rot(0.04 * sin(t * 1.3 + phase * 9.0)) * q;
  let aa = 1.5 / (u.res.y * sc);

  // soft shadow on the ground
  if (!floaty) {
    let sh = sdEllipse((p - ch.pos.xy) / sc - vec2f(0.0, -0.58), vec2f(0.55 - bob, 0.1));
    *col = mix(*col, *col * 0.55, fill(sh, 0.08));
  }
  // night glow behind characters
  if (u.tod < 1.5) { *col += base * 0.12 * exp(-length(q - vec2f(0.0, 0.2)) * 2.2); }

  let outline = vec3f(0.12, 0.1, 0.18);
  let ow = 0.045;

  if (kind == 6.0) { // robot
    let body = sdBox(q - vec2f(0.0, -0.15), vec2f(0.38, 0.33), 0.1);
    let head = sdBox(q - vec2f(0.0, 0.45), vec2f(0.34, 0.26), 0.1);
    let ant = sdSeg(q, vec2f(0.0, 0.7), vec2f(0.0, 0.9), 0.025);
    paint(col, outline, min(min(body, head), ant) - ow, aa);
    paint(col, dark, ant, aa);
    paint(col, base, body, aa);
    paint(col, light, head, aa);
    let glow = 0.6 + 0.4 * sin(t * 4.0 + phase * 10.0);
    paint(col, mix(vec3f(1.0, 0.4, 0.4), vec3f(1.0, 0.9, 0.4), glow), sdCircle(q - vec2f(0.0, 0.93), 0.07), aa);
    paint(col, vec3f(0.15, 0.15, 0.25), sdBox(q - vec2f(0.0, 0.46), vec2f(0.25, 0.13), 0.06), aa);
    let blink = select(1.0, 0.15, fract(t * 0.23 + phase) > 0.965);
    paint(col, vec3f(0.4, 1.0, 0.95), sdBox(q - vec2f(-0.11, 0.47), vec2f(0.05, 0.05 * blink), 0.02), aa);
    paint(col, vec3f(0.4, 1.0, 0.95), sdBox(q - vec2f(0.11, 0.47), vec2f(0.05, 0.05 * blink), 0.02), aa);
    paint(col, vec3f(0.4, 1.0, 0.6) * (0.6 + 0.4 * sin(t * 3.0)), sdCircle(q - vec2f(-0.12, -0.1), 0.05), aa);
    paint(col, vec3f(1.0, 0.6, 0.3) * (0.6 + 0.4 * cos(t * 2.0)), sdCircle(q - vec2f(0.05, -0.1), 0.05), aa);
    return;
  }
  if (kind == 10.0) { // star
    let d = sdStar(q - vec2f(0.0, 0.1), 0.7, 0.5);
    *col += vec3f(1.0, 0.9, 0.5) * 0.35 * exp(-max(d, 0.0) * 4.0);
    paint(col, outline, d - ow, aa);
    paint(col, base, d, aa);
    eyes(col, q, vec2f(0.0, 0.18), 0.14, 0.06, aa, t, phase);
    smile(col, q, vec2f(0.0, 0.06), 0.08, aa);
    cheeks(col, q, vec2f(0.0, 0.05), 0.22, aa);
    return;
  }
  if (kind == 11.0) { // ghost
    var d = min(sdCircle(q - vec2f(0.0, 0.25), 0.45), sdBox(q - vec2f(0.0, -0.1), vec2f(0.45, 0.35), 0.0));
    d = max(d, -(q.y + 0.42 + 0.06 * sin(q.x * 18.0 + t * 4.0)));
    *col += base * 0.25 * exp(-max(d, 0.0) * 5.0);
    paint(col, outline, d - ow, aa);
    paint(col, mix(base, vec3f(1.0), 0.4), d, aa);
    eyes(col, q, vec2f(0.0, 0.3), 0.15, 0.075, aa, t, phase);
    paint(col, vec3f(0.15, 0.08, 0.15), sdEllipse(q - vec2f(0.0, 0.1), vec2f(0.06, 0.075)), aa);
    cheeks(col, q, vec2f(0.0, 0.17), 0.26, aa);
    return;
  }
  if (kind == 7.0) { // fish
    let qq = vec2f(q.x, q.y - 0.1);
    let wig = 0.1 * sin(t * 6.0 + phase * 6.0);
    let body = sdEllipse(qq, vec2f(0.55, 0.36));
    let tail = sdTri(qq, vec2f(-0.45, 0.0), vec2f(-0.85, 0.3 + wig), vec2f(-0.85, -0.3 + wig));
    let fin = sdTri(qq, vec2f(-0.1, 0.3), vec2f(0.2, 0.3), vec2f(-0.15, 0.55));
    paint(col, outline, min(min(body, tail), fin) - ow, aa);
    paint(col, dark, min(tail, fin), aa);
    paint(col, base, body, aa);
    paint(col, light, max(body, abs(qq.x + 0.05) - 0.07), aa);
    paint(col, vec3f(0.08, 0.07, 0.12), sdCircle(qq - vec2f(0.28, 0.08), 0.07), aa);
    paint(col, vec3f(1.0), sdCircle(qq - vec2f(0.3, 0.1), 0.025), aa);
    smile(col, qq, vec2f(0.33, -0.08), 0.08, aa);
    for (var b = 0; b < 3; b++) {
      let bt = fract(t * 0.3 + f32(b) * 0.33 + phase);
      let bp = qq - vec2f(0.6 + 0.1 * sin(bt * 12.0), 0.2 + bt * 1.6);
      paint(col, mix(*col, vec3f(0.85, 0.95, 1.0), 0.6), abs(sdCircle(bp, 0.04 + bt * 0.03)) - 0.01, aa);
    }
    return;
  }
  if (kind == 13.0) { // turtle
    let shell = max(sdEllipse(q - vec2f(0.0, -0.15), vec2f(0.55, 0.5)), -(q.y + 0.2));
    let head = sdCircle(q - vec2f(0.55, -0.05), 0.2);
    let legs = min(sdEllipse(q - vec2f(-0.3, -0.3), vec2f(0.1, 0.12)), sdEllipse(q - vec2f(0.3, -0.3), vec2f(0.1, 0.12)));
    let skin = vec3f(0.6, 0.85, 0.55);
    paint(col, outline, min(min(shell, head), legs) - ow, aa);
    paint(col, skin, min(head, legs), aa);
    paint(col, base, shell, aa);
    let hex = abs(fract(q * 4.0) - 0.5);
    paint(col, dark, max(shell + 0.05, -(max(hex.x, hex.y) - 0.38)), aa * 4.0);
    paint(col, vec3f(0.08, 0.07, 0.12), sdCircle(q - vec2f(0.6, 0.0), 0.04), aa);
    smile(col, q, vec2f(0.6, -0.08), 0.06, aa);
    return;
  }

  // ---- chibi critters: head + body, kind-specific ears/extras ----
  var bodyC = base;
  var headC = base;
  var bellyC = light;
  if (kind == 9.0) { headC = vec3f(1.0, 0.82, 0.68); bellyC = mix(base, vec3f(1.0), 0.3); }
  if (kind == 4.0) { bellyC = vec3f(0.98, 0.9, 0.75); }
  if (kind == 5.0) { bellyC = vec3f(0.98, 0.9, 0.55); }

  let headP = vec2f(0.0, 0.42);
  var body = sdEllipse(q - vec2f(0.0, -0.22), vec2f(0.4, 0.36));
  var head = sdCircle(q - headP, 0.4);
  var extra = 1.0;   // drawn in dark color, behind
  var extraL = 1.0;  // drawn in base color, behind head
  var inner = 1.0;   // drawn in pink/light, on top of extraL
  var tail = 1.0;

  if (kind == 4.0) { // owl: one egg-shaped body
    head = sdEllipse(q - vec2f(0.0, 0.05), vec2f(0.5, 0.62));
    body = 1.0;
    extraL = min(sdTri(q, vec2f(-0.42, 0.45), vec2f(-0.18, 0.55), vec2f(-0.42, 0.8)),
                 sdTri(q, vec2f(0.42, 0.45), vec2f(0.18, 0.55), vec2f(0.42, 0.8)));
    let flap = 0.15 * sin(t * 3.0 + phase * 5.0);
    extra = min(sdEllipse(rot(0.3 + flap) * (q - vec2f(-0.45, -0.05)), vec2f(0.14, 0.32)),
                sdEllipse(rot(-0.3 - flap) * (q - vec2f(0.45, -0.05)), vec2f(0.14, 0.32)));
  }
  if (kind == 0.0 || kind == 3.0) { // fox, cat: pointy ears
    let w = select(0.2, 0.15, kind == 3.0);
    let hgt = select(0.42, 0.3, kind == 3.0);
    extraL = min(sdTri(q, vec2f(-0.38, 0.55), vec2f(-0.38 + w * 1.4, 0.68), vec2f(-0.36, 0.55 + hgt)),
                 sdTri(q, vec2f(0.38, 0.55), vec2f(0.38 - w * 1.4, 0.68), vec2f(0.36, 0.55 + hgt)));
    inner = min(sdTri(q, vec2f(-0.33, 0.62), vec2f(-0.33 + w * 0.9, 0.69), vec2f(-0.34, 0.5 + hgt)),
                sdTri(q, vec2f(0.33, 0.62), vec2f(0.33 - w * 0.9, 0.69), vec2f(0.34, 0.5 + hgt)));
    let sw = 0.12 * sin(t * 2.0 + phase * 4.0);
    if (kind == 0.0) { tail = sdEllipse(rot(-0.7 + sw) * (q - vec2f(0.5, -0.2)), vec2f(0.15, 0.36)); }
    else { tail = sdSeg(q, vec2f(0.3, -0.4), vec2f(0.62 + sw, 0.0), 0.06); }
  }
  if (kind == 1.0) { // bunny
    let flop = 0.08 * sin(t * 1.5 + phase * 3.0);
    extraL = min(sdEllipse(rot(0.15 + flop) * (q - vec2f(-0.17, 0.95)), vec2f(0.11, 0.36)),
                 sdEllipse(rot(-0.15) * (q - vec2f(0.17, 0.95)), vec2f(0.11, 0.36)));
    inner = min(sdEllipse(rot(0.15 + flop) * (q - vec2f(-0.17, 0.95)), vec2f(0.05, 0.26)),
                sdEllipse(rot(-0.15) * (q - vec2f(0.17, 0.95)), vec2f(0.05, 0.26)));
    tail = sdCircle(q - vec2f(0.38, -0.38), 0.12);
  }
  if (kind == 2.0 || kind == 12.0) { // bear, mouse: round ears
    let er = select(0.13, 0.22, kind == 12.0);
    let ex = select(0.3, 0.36, kind == 12.0);
    extraL = min(sdCircle(q - vec2f(-ex, 0.75), er), sdCircle(q - vec2f(ex, 0.75), er));
    inner = min(sdCircle(q - vec2f(-ex, 0.75), er * 0.55), sdCircle(q - vec2f(ex, 0.75), er * 0.55));
    if (kind == 12.0) { tail = sdSeg(q, vec2f(0.3, -0.45), vec2f(0.7, -0.3 + 0.05 * sin(t * 3.0)), 0.025); }
  }
  if (kind == 5.0) { // dragon
    let flap = 0.25 * sin(t * 3.0 + phase * 4.0);
    extra = min(sdTri(q, vec2f(-0.25, -0.05), vec2f(-0.85, 0.4 + flap), vec2f(-0.65, -0.2)),
                sdTri(q, vec2f(0.25, -0.05), vec2f(0.85, 0.4 + flap), vec2f(0.65, -0.2)));
    extraL = min(sdTri(q, vec2f(-0.3, 0.68), vec2f(-0.16, 0.74), vec2f(-0.3, 0.98)),
                 sdTri(q, vec2f(0.3, 0.68), vec2f(0.16, 0.74), vec2f(0.3, 0.98)));
    tail = min(sdSeg(q, vec2f(0.25, -0.45), vec2f(0.68, -0.38), 0.07),
               sdTri(q, vec2f(0.62, -0.28), vec2f(0.84, -0.38), vec2f(0.62, -0.48)));
  }
  if (kind == 8.0) { // unicorn
    extraL = min(sdTri(q, vec2f(-0.35, 0.6), vec2f(-0.17, 0.72), vec2f(-0.33, 0.9)),
                 sdTri(q, vec2f(0.35, 0.6), vec2f(0.17, 0.72), vec2f(0.33, 0.9)));
    tail = sdEllipse(rot(-0.6) * (q - vec2f(0.48, -0.25)), vec2f(0.12, 0.3));
  }
  if (kind == 9.0) { // child: hair cap
    extraL = max(sdCircle(q - headP - vec2f(0.0, 0.04), 0.44), -(q.y - 0.45 + 0.08 * sin(q.x * 14.0)));
  }

  let sil = min(min(min(body, head), min(extra, extraL)), tail);
  paint(col, outline, sil - ow, aa);
  paint(col, dark, extra, aa);
  if (kind == 8.0) { paint(col, vec3f(0.75, 0.6, 1.0), tail, aa); }
  else if (kind == 0.0) {
    paint(col, base, tail, aa);
    paint(col, vec3f(1.0), max(tail, -(q.x - 0.62)), aa);
  } else { paint(col, select(base, light, kind == 1.0), tail, aa); }
  if (kind == 9.0) { paint(col, bodyC, body, aa); }
  else { paint(col, bodyC, body, aa); paint(col, bellyC, sdEllipse(q - vec2f(0.0, -0.28), vec2f(0.24, 0.22)), aa); }
  if (kind == 5.0) { paint(col, vec3f(1.0, 0.85, 0.4), extraL, aa); } else if (kind != 9.0) { paint(col, base, extraL, aa); }
  paint(col, vec3f(1.0, 0.7, 0.78), inner, aa);
  paint(col, headC, head, aa);
  if (kind == 9.0) { paint(col, vec3f(0.42, 0.26, 0.16), extraL, aa); }
  if (kind == 4.0) {
    paint(col, bellyC, sdEllipse(q - vec2f(0.0, -0.22), vec2f(0.3, 0.3)), aa);
    paint(col, vec3f(1.0), sdCircle(q - vec2f(-0.17, 0.25), 0.15), aa);
    paint(col, vec3f(1.0), sdCircle(q - vec2f(0.17, 0.25), 0.15), aa);
    eyes(col, q, vec2f(0.0, 0.25), 0.17, 0.08, aa, t, phase);
    paint(col, vec3f(1.0, 0.68, 0.25), sdTri(q, vec2f(-0.06, 0.13), vec2f(0.06, 0.13), vec2f(0.0, 0.02)), aa);
    return;
  }
  if (kind == 0.0) { // fox muzzle
    paint(col, vec3f(1.0, 0.97, 0.92), sdEllipse(q - vec2f(0.0, 0.3), vec2f(0.24, 0.15)), aa);
  }
  if (kind == 2.0) { paint(col, light, sdEllipse(q - vec2f(0.0, 0.32), vec2f(0.16, 0.12)), aa); }
  if (kind == 8.0) {
    paint(col, outline, sdTri(q, vec2f(-0.07, 0.76), vec2f(0.07, 0.76), vec2f(0.0, 1.12)) - ow * 0.6, aa);
    paint(col, vec3f(1.0, 0.87, 0.4), sdTri(q, vec2f(-0.07, 0.76), vec2f(0.07, 0.76), vec2f(0.0, 1.12)), aa);
    for (var m = 0; m < 4; m++) {
      let fm = f32(m);
      let mc = mix(vec3f(0.75, 0.6, 1.0), vec3f(1.0, 0.65, 0.85), fm / 3.0);
      paint(col, mc, sdCircle(q - vec2f(-0.3 + fm * 0.05, 0.72 - fm * 0.14), 0.11), aa);
    }
  }
  eyes(col, q, headP + vec2f(0.0, 0.0), 0.15, 0.055, aa, t, phase);
  paint(col, vec3f(0.18, 0.1, 0.12), sdEllipse(q - headP - vec2f(0.0, -0.1), vec2f(0.045, 0.03)), aa);
  smile(col, q, headP + vec2f(0.0, -0.12), 0.07, aa);
  cheeks(col, q, headP + vec2f(0.0, -0.1), 0.24, aa);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let fc = vec2f(frag.x, u.res.y - frag.y);
  let p = (fc - 0.5 * u.res) / u.res.y;
  let t = u.time;
  var col = world(p, t);

  let n = u32(u.count);
  for (var i = 0u; i < n; i++) {
    drawChar(&col, p, u.chars[i], t);
  }

  // fireflies at night/dusk
  if (u.tod < 1.5 && u.setting != 2.0) {
    for (var i = 0; i < 14; i++) {
      let fi = f32(i);
      let fp = vec2f(
        (hash21(vec2f(fi, 1.0)) - 0.5) * u.res.x / u.res.y + 0.08 * sin(t * 0.5 + fi),
        -0.25 + 0.4 * hash21(vec2f(fi, 2.0)) + 0.05 * cos(t * 0.7 + fi * 2.0));
      let pulse = 0.5 + 0.5 * sin(t * 2.0 + fi * 1.7);
      col += vec3f(1.0, 0.9, 0.45) * pulse * 0.0006 / (dot(p - fp, p - fp) + 0.0004);
    }
  }
  // vignette
  col *= 1.0 - 0.35 * dot(p * 0.9, p * 0.9);
  return vec4f(pow(clamp(col, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 1.1)), 1.0);
}
`;
