/*
 * Glyph Tide
 *
 *   const tide = GlyphTide.mount(el, { calm: '.card' });
 *   tide.set({ windSpeed: 60 });
 *   tide.ripple(x, y);
 *   tide.destroy();
 *
 * Needs WebGL2. Colours come from the element's `color` and `--tide-glow`.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    cell: 6.5,        // px
    rowRatio: 2,
    size: 9,          // px
    charset: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    font: null,
    weight: 300,
    ink: null,
    glow: null,
    rest: 0.03,
    peak: 0.8,
    windSpeed: 36,    // px/s
    windAngle: -0.3,
    gustSize: 420,    // px
    flick: 1.2,       // glyph changes/s
    friction: 0.6,
    ripple: 1,
    trail: 1,
    calm: null,       // selector or element
    budget: 180,      // s of motion after last input, 0 = forever
    fps: 25
  };

  var MAX_RIPPLES = 8;
  var MAX_TRAIL = 32;
  var RIPPLE_LIFE = 7;
  var TRAIL_LIFE = 2;
  var ATLAS_COLS = 16;
  var SEQ_LEN = 256;
  var ROUSE_STEPS = 6;
  var SETTLE_S = 8;
  var RESUME_S = 3;

  var VERT = [
    '#version 300 es',
    'void main() {',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // 1x2 samples per cell. r: brightness, g: glow, b: rouse
  var FIELD = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'uniform uint uSeed;',
    'uniform vec2 uSampleCss, uOriginCss;',
    'uniform float uClock, uNow, uWindSpeed, uGust;',
    'uniform vec2 uWindDir;',
    'uniform vec4 uCalm;',
    'uniform int uRippleCount, uTrailCount;',
    'uniform vec4 uRipples[' + MAX_RIPPLES + '];',
    'uniform vec4 uTrail[' + MAX_TRAIL + '];',
    'out vec4 o;',
    '',
    'uint mixu(uint x) {',
    '  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;',
    '  return x;',
    '}',
    'float h3(ivec3 c) {',
    '  return float(mixu(uint(c.x) ^ mixu(uint(c.y) ^ mixu(uint(c.z) ^ uSeed)))) / 4294967295.0;',
    '}',
    'float vnoise(vec3 p) {',
    '  vec3 fl = floor(p), f = p - fl;',
    '  ivec3 i = ivec3(fl) + 65536;',
    '  vec3 u = f * f * (3.0 - 2.0 * f);',
    '  float a = h3(i), b = h3(i + ivec3(1, 0, 0)), c = h3(i + ivec3(0, 1, 0)), d = h3(i + ivec3(1, 1, 0));',
    '  float e = h3(i + ivec3(0, 0, 1)), g = h3(i + ivec3(1, 0, 1)), h = h3(i + ivec3(0, 1, 1)), k = h3(i + ivec3(1, 1, 1));',
    '  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);',
    '}',
    'float fbm(vec3 p) {',
    '  float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 0.0); a *= 0.5; }',
    '  return s / 0.9375;',
    '}',
    '',
    // (x^2 + y^2 - 1)^3 = x^2 y^3
    'float heartReach(vec2 dir) {',
    '  vec2 v = vec2(dir.x, -dir.y);',
    '  float lo = 0.0, hi = 1.6;',
    '  for (int i = 0; i < 12; i++) {',
    '    float t = 0.5 * (lo + hi);',
    '    vec2 q = v * t;',
    '    float r = dot(q, q) - 1.0;',
    '    if (r * r * r - q.x * q.x * q.y * q.y * q.y > 0.0) hi = t; else lo = t;',
    '  }',
    '  return max(0.5 * (lo + hi), 0.2);',
    '}',
    '',
    'void main() {',
    '  ivec2 s = ivec2(gl_FragCoord.xy);',
    '  ivec2 cell = ivec2(s.x, s.y >> 1);',
    '  vec2 pos = uOriginCss + (vec2(s) + 0.5) * uSampleCss;',
    '',
    '  vec2 push = vec2(0.0);',
    '  float lift = 0.0, glow = 0.0, rouse = 0.0;',
    '  for (int i = 0; i < ' + MAX_RIPPLES + '; i++) {',
    '    if (i >= uRippleCount) break;',
    '    vec4 r = uRipples[i];',
    '    float age = uNow - r.z;',
    '    if (age < 0.0) continue;',
    '    vec2 away = pos - r.xy;',
    '    float d = length(away);',
    '    vec2 dir = away / max(d, 1.0);',
    '    float reach = r.w < 0.0 ? d / heartReach(dir) : d;',
    '    float radius = 760.0 * (1.0 - exp(-age / 1.25));',
    '    float x = reach - radius;',
    '    float width = 46.0 + 55.0 * age;',
    '    float env = exp(-x * x / (width * width)) * exp(-age / 1.7) * abs(r.w);',
    '    env *= 1.0 - smoothstep(0.0, 0.7 * width, x);',
    '    float wave = cos(x * 0.055);',
    '    push += dir * env * 26.0 * wave;',
    '    lift += env * wave;',
    '    glow += env * max(wave, 0.0);',
    '    rouse += smoothstep(0.6 * width, -0.6 * width, x) * exp(-age / 1.9) * abs(r.w);',
    '  }',
    '',
    '  float warm = 0.0;',
    '  for (int i = 0; i < ' + MAX_TRAIL + '; i++) {',
    '    if (i >= uTrailCount) break;',
    '    vec4 t = uTrail[i];',
    '    vec2 dv = pos - t.xy;',
    '    warm += t.w * exp(-(uNow - t.z) / 0.55) * exp(-dot(dv, dv) / 3000.0);',
    '  }',
    '  warm = 1.0 - exp(-1.4 * warm);',
    '',
    '  vec2 p = pos - push;',
    '  vec2 wp = vec2(dot(p, uWindDir), dot(p, vec2(-uWindDir.y, uWindDir.x)));',
    '  float travel = uWindSpeed * uClock;',
    '  vec3 q = vec3((wp.x - travel) / (uGust * 1.6), wp.y / uGust, uClock * 0.05);',
    '  vec3 wq = q * 1.7 + vec3(0.0, 0.0, uClock * 0.08);',
    '  q.xy += 0.6 * vec2(fbm(wq), fbm(wq + vec3(5.2, 1.3, 2.1))) - 0.3;',
    '  float gust = smoothstep(0.5, 0.8, fbm(q));',
    '  float streak = vnoise(vec3((wp.x - travel * 1.3) / 60.0, wp.y / 9.0, uClock * 0.3));',
    '  gust *= 0.7 + 0.6 * streak;',
    '  gust *= 0.75 + 0.5 * h3(ivec3(cell, 7));',
    '',
    '  if (uCalm.z > 0.0) {',
    '    vec2 out_ = max(abs(pos - (uCalm.xy + 0.5 * uCalm.zw)) - 0.5 * uCalm.zw, 0.0);',
    '    gust *= mix(0.2, 1.0, smoothstep(0.0, 140.0, length(out_)));',
    '  }',
    '',
    '  float bright = clamp(gust + 0.9 * lift + 0.5 * warm, -1.0, 1.0);',
    '  glow = (glow * 0.9 + 0.35 * warm) * (0.65 + 0.35 * h3(ivec3(cell, 11)));',
    '  o = vec4(bright * 0.5 + 0.5, clamp(glow, 0.0, 1.0), clamp(rouse, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');

  var DRAW = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'uniform sampler2D uAtlas, uSeq, uField;',
    'uniform uint uSeed;',
    'uniform vec2 uViewPx, uOriginPx, uWindDir;',
    'uniform ivec2 uCellPx, uGrid;',
    'uniform int uAtlasCols;',
    'uniform vec3 uInk, uGlow;',
    'uniform float uRest, uPeak, uReveal, uClock, uFlick, uFriction;',
    'out vec4 o;',
    'uint mixu(uint x) {',
    '  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;',
    '  return x;',
    '}',
    'float unit(uint x) { return float(x >> 8) / 16777216.0; }',
    'ivec4 slotBox;',
    'float inkAt(ivec2 at) { return texelFetch(uAtlas, clamp(at, slotBox.xy, slotBox.zw), 0).r; }',
    'void main() {',
    '  vec2 cellPx = vec2(uCellPx), grid = vec2(uGrid);',
    '  vec2 p = vec2(gl_FragCoord.x, uViewPx.y - gl_FragCoord.y) - uOriginPx;',
    '  ivec2 cell = ivec2(floor(p / cellPx));',
    '  o = vec4(0.0);',
    '  if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, uGrid))) return;',
    '',
    '  uint h = mixu(uint(cell.x) * 0x9e3779b9u ^ mixu(uint(cell.y) ^ uSeed));',
    '  float steps = floor(uClock * uFlick * (0.6 + 0.8 * unit(h)) + ' + SEQ_LEN + '.0 * unit(mixu(h)));',
    '  float rouse = texture(uField, (vec2(cell) + 0.5) / grid).b;',
    '  steps += floor(' + ROUSE_STEPS + '.0 * rouse + unit(mixu(h ^ 0x5bd1e995u)));',
    '  int idx = int(texelFetch(uSeq, ivec2(int(mod(steps, ' + SEQ_LEN + '.0)), 0), 0).r * 255.0 + 0.5);',
    '  ivec2 slot = ivec2(idx % uAtlasCols, idx / uAtlasCols) * uCellPx;',
    '  slotBox = ivec4(slot, slot + uCellPx - 1);',
    '  ivec2 at = slot + ivec2(p - vec2(cell) * cellPx);',
    '  float cover = inkAt(at);',
    '  if (cover <= 0.0) return;',
    '',
    '  vec4 f = texture(uField, p / cellPx / grid);',
    '  vec2 rise = vec2(inkAt(at + ivec2(1, 0)) - inkAt(at - ivec2(1, 0)), inkAt(at + ivec2(0, 1)) - inkAt(at - ivec2(0, 1)));',
    '  float steep = length(rise);',
    '  float facing = steep > 0.02 ? max(0.0, dot(rise / steep, uWindDir)) : 0.35;',
    '  float caught = mix(1.0, 0.45 + 1.1 * facing, uFriction);',
    '  float bright = f.r * 2.0 - 1.0;',
    '  float a = bright >= 0.0 ? mix(uRest, uPeak, min(1.0, bright * caught)) : uRest * (1.0 + bright);',
    '  a = max(a, f.g * uPeak);',
    '  a *= cover * uReveal;',
    '  o = vec4(mix(uInk, uGlow, f.g) * a, a);',
    '}'
  ].join('\n');

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (src) for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  function parseColor(css, fallback) {
    var c = document.createElement('canvas').getContext('2d');
    c.fillStyle = fallback;
    if (css) c.fillStyle = css;
    c.fillRect(0, 0, 1, 1);
    var d = c.getImageData(0, 0, 1, 1).data;
    return [d[0] / 255, d[1] / 255, d[2] / 255];
  }

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function link(gl, fs, names) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    var u = {};
    names.forEach(function (n) { u[n] = gl.getUniformLocation(p, n); });
    return { program: p, u: u };
  }

  function texture(gl, internal, format, w, h, data, filter) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.UNSIGNED_BYTE, data);
    return t;
  }

  function buildAtlas(chars, cw, ch, size, family, weight) {
    var rows = Math.ceil(chars.length / ATLAS_COLS);
    var c = document.createElement('canvas');
    c.width = ATLAS_COLS * cw;
    c.height = rows * ch;
    var x = c.getContext('2d', { willReadFrequently: true });
    x.font = weight + ' 100px ' + family;
    var ratio = x.measureText('0').width / 100 || 0.6;
    var px = Math.max(4, Math.floor(Math.min(size, ch * 0.75, cw / ratio)));
    x.font = weight + ' ' + px + 'px ' + family;
    x.textBaseline = 'alphabetic';
    x.fillStyle = '#fff';
    var m = x.measureText('Hg');
    var asc = m.actualBoundingBoxAscent || px * 0.75;
    var desc = m.actualBoundingBoxDescent || px * 0.2;
    var base = Math.round((ch + asc - desc) / 2);
    chars.forEach(function (g, i) {
      var sx = (i % ATLAS_COLS) * cw, sy = Math.floor(i / ATLAS_COLS) * ch;
      x.fillText(g, sx + Math.round((cw - x.measureText(g).width) / 2), sy + base);
    });
    var rgba = x.getImageData(0, 0, c.width, c.height).data;
    var cover = new Uint8Array(c.width * c.height);
    for (var i = 0; i < cover.length; i++) cover[i] = rgba[i * 4 + 3];
    return { width: c.width, height: c.height, data: cover };
  }

  function buildSequence(count) {
    var seq = new Uint8Array(SEQ_LEN);
    for (var i = 0; i < SEQ_LEN; i++) {
      var g;
      do { g = (Math.random() * count) | 0; } while (count > 1 && i > 0 && g === seq[i - 1]);
      seq[i] = g;
    }
    return seq;
  }

  function mount(container, options) {
    var opts = assign({}, DEFAULTS, options);
    var noop = { set: function () {}, ripple: function () {}, destroy: function () {} };
    if (!container) return noop;

    var canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;z-index:0;opacity:1';
    var gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) return noop;

    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.insertBefore(canvas, container.firstChild);

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    var seed = (Math.random() * 4294967295) >>> 0;
    var chars = Array.from(opts.charset);
    var t0 = performance.now();
    var ripples = [], trail = [], lastTrail = null;
    var field, draw, vao, atlasTex, seqTex, fieldTex, fbo;
    var grid = null, atlasKey = '', ink = [0, 0, 0], glow = [0.18, 0.48, 1];
    var raf = 0, lastFrame = 0, destroyed = false;
    var clock = 0, energy = 1, awakeUntil = opts.budget;
    var rippleData = new Float32Array(MAX_RIPPLES * 4);
    var trailData = new Float32Array(MAX_TRAIL * 4);

    function now() { return (performance.now() - t0) / 1000; }

    function readColors() {
      var cs = getComputedStyle(container);
      ink = parseColor(opts.ink || cs.color, '#000');
      glow = parseColor(opts.glow || cs.getPropertyValue('--tide-glow').trim(), '#2f7bff');
    }

    function initGL() {
      field = link(gl, FIELD, ['uSeed', 'uSampleCss', 'uOriginCss', 'uClock', 'uNow', 'uWindSpeed', 'uGust', 'uWindDir', 'uCalm', 'uRippleCount', 'uTrailCount', 'uRipples', 'uTrail']);
      draw = link(gl, DRAW, ['uAtlas', 'uSeq', 'uField', 'uSeed', 'uViewPx', 'uOriginPx', 'uWindDir', 'uCellPx', 'uGrid', 'uAtlasCols', 'uInk', 'uGlow', 'uRest', 'uPeak', 'uReveal', 'uClock', 'uFlick', 'uFriction']);
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      grid = null;
      atlasKey = '';
    }

    function layout() {
      var dpr = window.devicePixelRatio || 1;
      var w = Math.max(1, Math.round(container.clientWidth * dpr));
      var h = Math.max(1, Math.round(container.clientHeight * dpr));
      var cw = Math.max(4, Math.round(opts.cell * dpr));
      var ch = Math.max(6, Math.round(cw * opts.rowRatio));
      var family = opts.font || getComputedStyle(container).fontFamily || 'monospace';

      var size = opts.size * dpr;
      var key = [cw, ch, size, family, opts.weight, opts.charset].join('|');
      if (key !== atlasKey) {
        var nextChars = Array.from(opts.charset).slice(0, 256);
        var atlas = buildAtlas(nextChars, cw, ch, size, family, opts.weight);
        if (atlasTex) gl.deleteTexture(atlasTex);
        atlasTex = texture(gl, gl.R8, gl.RED, atlas.width, atlas.height, atlas.data);
        if (!seqTex || nextChars.length !== chars.length) {
          if (seqTex) gl.deleteTexture(seqTex);
          seqTex = texture(gl, gl.R8, gl.RED, SEQ_LEN, 1, buildSequence(nextChars.length));
        }
        chars = nextChars;
        atlasKey = key;
        grid = null;
      }

      canvas.width = w;
      canvas.height = h;
      var cols = Math.ceil(w / cw), rows = Math.ceil(h / ch);
      if (grid && grid.cols === cols && grid.rows === rows && grid.cw === cw) return;

      grid = { cols: cols, rows: rows, cw: cw, ch: ch, dpr: dpr, ox: Math.floor((w - cols * cw) / 2), oy: Math.floor((h - rows * ch) / 2) };
      if (fieldTex) gl.deleteTexture(fieldTex);
      fieldTex = texture(gl, gl.RGBA8, gl.RGBA, cols, rows * 2, null, gl.LINEAR);
      if (fbo) gl.deleteFramebuffer(fbo);
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fieldTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    function calmRect() {
      var el = typeof opts.calm === 'string' ? container.querySelector(opts.calm) : opts.calm;
      if (!el || !el.getBoundingClientRect) return [0, 0, 0, 0];
      var a = el.getBoundingClientRect(), b = container.getBoundingClientRect();
      return [a.left - b.left, a.top - b.top, a.width, a.height];
    }

    function render(t, reveal) {
      if (!grid) return;
      var dpr = grid.dpr;
      ripples = ripples.filter(function (r) { return t - r[2] < RIPPLE_LIFE; });
      trail = trail.filter(function (p) { return t - p[2] < TRAIL_LIFE; });
      rippleData.fill(0);
      ripples.forEach(function (r, i) { rippleData.set(r, i * 4); });
      trailData.fill(0);
      trail.forEach(function (p, i) { trailData.set(p, i * 4); });

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, grid.cols, grid.rows * 2);
      gl.useProgram(field.program);
      var u = field.u;
      var wx = Math.cos(opts.windAngle), wy = Math.sin(opts.windAngle);
      gl.uniform1ui(u.uSeed, seed);
      gl.uniform2f(u.uSampleCss, grid.cw / dpr, grid.ch / dpr / 2);
      gl.uniform2f(u.uOriginCss, grid.ox / dpr, grid.oy / dpr);
      gl.uniform1f(u.uClock, clock);
      gl.uniform1f(u.uNow, t);
      gl.uniform1f(u.uWindSpeed, opts.windSpeed);
      gl.uniform1f(u.uGust, Math.max(40, opts.gustSize));
      gl.uniform2f(u.uWindDir, wx, wy);
      gl.uniform4fv(u.uCalm, calmRect());
      gl.uniform1i(u.uRippleCount, ripples.length);
      gl.uniform1i(u.uTrailCount, trail.length);
      gl.uniform4fv(u.uRipples, rippleData);
      gl.uniform4fv(u.uTrail, trailData);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(draw.program);
      u = draw.u;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, seqTex);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, fieldTex);
      gl.uniform1i(u.uAtlas, 0);
      gl.uniform1i(u.uSeq, 1);
      gl.uniform1i(u.uField, 2);
      gl.uniform1ui(u.uSeed, seed);
      gl.uniform2f(u.uViewPx, canvas.width, canvas.height);
      gl.uniform2f(u.uOriginPx, grid.ox, grid.oy);
      gl.uniform2f(u.uWindDir, wx, wy);
      gl.uniform2i(u.uCellPx, grid.cw, grid.ch);
      gl.uniform2i(u.uGrid, grid.cols, grid.rows);
      gl.uniform1i(u.uAtlasCols, ATLAS_COLS);
      gl.uniform3fv(u.uInk, ink);
      gl.uniform3fv(u.uGlow, glow);
      gl.uniform1f(u.uRest, opts.rest);
      gl.uniform1f(u.uPeak, opts.peak);
      gl.uniform1f(u.uReveal, reveal);
      gl.uniform1f(u.uClock, clock);
      gl.uniform1f(u.uFlick, opts.flick);
      gl.uniform1f(u.uFriction, opts.friction);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
    }

    function busy(t) {
      return ripples.some(function (r) { return t - r[2] < RIPPLE_LIFE; }) ||
        trail.some(function (p) { return t - p[2] < 1.2; });
    }

    function still() {
      clock = 18;
      render(now() + RIPPLE_LIFE, 1);
    }

    function frame(ms) {
      raf = requestAnimationFrame(frame);
      var t = now();
      var rippling = busy(t);
      if (!rippling && ms - lastFrame < 1000 / opts.fps - 2) return;
      var elapsed = Math.min(1, (ms - lastFrame) / 1000);
      var dt = Math.min(0.1, elapsed);
      lastFrame = ms;
      var awake = !opts.budget || t < awakeUntil;
      energy = awake ? Math.min(1, energy + elapsed / RESUME_S) : Math.max(0, energy - elapsed / SETTLE_S);
      clock += dt * energy;
      var r = Math.min(1, t / 2);
      render(t, r * r * (3 - 2 * r));
      if (energy === 0 && !rippling) { cancelAnimationFrame(raf); raf = 0; }
    }

    function start() {
      cancelAnimationFrame(raf);
      raf = 0;
      if (destroyed || gl.isContextLost()) return;
      if (reduceMotion.matches) { still(); return; }
      lastFrame = performance.now();
      raf = requestAnimationFrame(frame);
    }

    function wake() {
      awakeUntil = now() + opts.budget;
      if (!raf && grid && !reduceMotion.matches) start();
    }

    function ripple(x, y, strength) {
      if (reduceMotion.matches || !opts.ripple) return;
      var s = (strength == null ? 1 : strength) * opts.ripple;
      ripples.push([x, y, now(), s]);
      if (ripples.length > MAX_RIPPLES) ripples.shift();
      wake();
    }

    var IGNORE = 'a,button,input,select,textarea,label,summary,[contenteditable],[role="button"],[data-tide-ignore]';

    function local(e) {
      var b = container.getBoundingClientRect();
      return [e.clientX - b.left, e.clientY - b.top];
    }

    function onDown(e) {
      if (e.button !== 0 || (e.target.closest && e.target.closest(IGNORE))) return;
      var p = local(e);
      var heart = e.shiftKey || e.altKey;
      if (heart) e.preventDefault();
      ripple(p[0], p[1], heart ? -1.15 : 1);
    }

    function onMove(e) {
      wake();
      if (!opts.trail || reduceMotion.matches) return;
      var p = local(e), t = now();
      if (lastTrail) {
        var dx = p[0] - lastTrail[0], dy = p[1] - lastTrail[1];
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 14) return;
        var speed = dist / Math.max(0.016, t - lastTrail[2]);
        trail.push([p[0], p[1], t, opts.trail * Math.min(1, Math.max(0.15, speed / 800))]);
        if (trail.length > MAX_TRAIL) trail.shift();
      }
      lastTrail = [p[0], p[1], t];
    }

    function onLeave() { lastTrail = null; }
    function onVisible() { if (!document.hidden) wake(); }

    var resizeObs = new ResizeObserver(function () {
      if (gl.isContextLost()) return;
      layout();
      if (reduceMotion.matches) still();
      else if (!raf) render(now(), 1);
    });
    var themeObs = new MutationObserver(readColors);
    var darkMq = window.matchMedia('(prefers-color-scheme: dark)');

    function onLost(e) { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; }
    function onRestored() { initGL(); layout(); start(); }

    container.addEventListener('pointerdown', onDown);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerleave', onLeave);
    document.addEventListener('visibilitychange', onVisible);
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    darkMq.addEventListener('change', readColors);
    reduceMotion.addEventListener('change', start);

    function boot() {
      if (destroyed) return;
      readColors();
      initGL();
      layout();
      resizeObs.observe(container);
      start();
    }

    var family = opts.font || getComputedStyle(container).fontFamily;
    if (document.fonts && document.fonts.load) {
      document.fonts.load(opts.weight + ' 16px ' + family).then(boot, boot);
    } else {
      boot();
    }

    return {
      canvas: canvas,
      ripple: ripple,
      set: function (next) {
        assign(opts, next);
        readColors();
        if (grid) layout();
        if (reduceMotion.matches) still();
        else wake();
      },
      destroy: function () {
        destroyed = true;
        cancelAnimationFrame(raf);
        resizeObs.disconnect();
        themeObs.disconnect();
        darkMq.removeEventListener('change', readColors);
        reduceMotion.removeEventListener('change', start);
        container.removeEventListener('pointerdown', onDown);
        container.removeEventListener('pointermove', onMove);
        container.removeEventListener('pointerleave', onLeave);
        document.removeEventListener('visibilitychange', onVisible);
        var lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        canvas.remove();
      }
    };
  }

  root.GlyphTide = { mount: mount, defaults: DEFAULTS };
})(typeof window !== 'undefined' ? window : this);
