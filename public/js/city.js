/**
 * city.js — 절차적 도시 생성기
 *
 * 설계 원칙
 *  - 모든 정적 지오메트리는 "재질 × 공간 청크" 단위로 병합한다. 수천 개의 Mesh 대신
 *    수십 개의 draw call로 도시 전체를 그리고, 청크 단위 frustum culling을 유지한다.
 *  - 파사드 텍스처는 스타일당 한 장만 만들고, UV를 실제 미터 단위로 계산해 창문 크기가
 *    건물 크기와 무관하게 일정하게 보이도록 한다.
 *  - 물리 충돌체는 블록(가로 구획)당 하나의 static Body에 여러 Box shape를 붙인다.
 *
 * 좌표계: y-up, 지면 = GROUND_Y. 우측 통행. 차량 진행 방향 h의 오른쪽 = (-h.z, 0, h.x)
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export const GROUND_Y = -5;
const CURB_H = 0.15;
const SIDEWALK_TOP = GROUND_Y + CURB_H;
const MARK_Y = GROUND_Y + 0.012;
const CHUNK = 340;
// 작은 소품/노면 재질은 공간 분할하지 않고 한 메시로 합친다 (draw call 절감)
const GLOBAL_BUCKETS = /^(sig_|lampGlow|redGlow|glassClear|water|white|yellow|tire|carPaint|carGlass|signalHousing|path|plaza|curb|roofTile|bark)/;

// ─── 난수 ──────────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── 도로망 정의 ───────────────────────────────────────────────────
export const ROAD_TYPES = {
  street:    { lanes: 2, laneW: 4.25, median: 0.6, raised: false, speed: 13 },
  avenue:    { lanes: 3, laneW: 4.0,  median: 0.6, raised: false, speed: 15 },
  boulevard: { lanes: 3, laneW: 4.0,  median: 6.0, raised: true,  speed: 16 },
  ring:      { lanes: 2, laneW: 4.5,  median: 3.0, raised: true,  speed: 19 },
};
for (const t of Object.values(ROAD_TYPES)) t.width = t.lanes * 2 * t.laneW + t.median;

// N-S 도로(x 고정)와 E-W 도로(z 고정)의 위치
const XS = [-660, -545, -430, -320, -210, -105, 0, 105, 210, 320, 430, 545, 660];
const ZS = [-660, -550, -440, -320, -215, -110, 0, 110, 215, 320, 440, 550, 660];
const CITY_EDGE = 660;

function roadTypeAt(p, arr) {
  if (p === arr[0] || p === arr[arr.length - 1]) return 'ring';
  if (p === 0) return 'boulevard';
  if (Math.abs(p) === 320) return 'avenue';
  return 'street';
}

// 센트럴파크: 이 사각형 안의 도로 구간과 교차로는 제거된다.
const PARK = { x0: -320, x1: -105, z0: 110, z1: 320 };
// 시청 광장 블록 (x: 0~105, z: -110~0)
const PLAZA = { x0: 0, x1: 105, z0: -110, z1: 0 };

// ─── 지오메트리 버킷 ───────────────────────────────────────────────
class Bucket {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = []; this.n = 0; }
}

const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const WHITE = new THREE.Color(1, 1, 1);

class Buckets {
  constructor() { this.map = new Map(); }
  get(name, x = 0, z = 0) {
    const global = GLOBAL_BUCKETS.test(name);
    const cx = global ? 0 : Math.floor(x / CHUNK), cz = global ? 0 : Math.floor(z / CHUNK);
    const key = `${name}|${cx}|${cz}`;
    let e = this.map.get(key);
    if (!e) { e = { name, b: new Bucket() }; this.map.set(key, e); }
    return e.b;
  }
}

function pushV(b, p, n, u, v, c) {
  b.pos.push(p.x, p.y, p.z); b.nor.push(n.x, n.y, n.z); b.uv.push(u, v); b.col.push(c.r, c.g, c.b);
  return b.n++;
}

/** 삼각형/사각형 폴리곤. hint가 주어지면 법선이 hint 쪽을 향하도록 winding을 맞춘다. */
function poly(b, pts, uvs, hint, c = WHITE) {
  _v0.subVectors(pts[1], pts[0]); _v1.subVectors(pts[2], pts[0]);
  _n.crossVectors(_v0, _v1).normalize();
  if (hint && _n.dot(hint) < 0) { pts = [...pts].reverse(); uvs = [...uvs].reverse(); _n.negate(); }
  const ids = pts.map((p, i) => pushV(b, p, _n, uvs[i][0], uvs[i][1], c));
  b.idx.push(ids[0], ids[1], ids[2]);
  if (pts.length === 4) b.idx.push(ids[0], ids[2], ids[3]);
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0), DOWN = V(0, -1, 0);
const PX = V(1, 0, 0), NX = V(-1, 0, 0), PZ = V(0, 0, 1), NZ = V(0, 0, -1);

/** 박스 측면 4개 — 파사드용. u/v는 tileW/tileH(미터) 기준 */
function boxSides(b, cx, y0, cz, w, h, d, tileW, tileH, uOff = 0, vOff = 0, c = WHITE) {
  const hw = w / 2, hd = d / 2, y1 = y0 + h;
  const v0 = vOff, v1 = vOff + h / tileH;
  const faces = [
    [V(cx - hw, y0, cz + hd), V(cx + hw, y0, cz + hd), w, PZ],
    [V(cx + hw, y0, cz + hd), V(cx + hw, y0, cz - hd), d, PX],
    [V(cx + hw, y0, cz - hd), V(cx - hw, y0, cz - hd), w, NZ],
    [V(cx - hw, y0, cz - hd), V(cx - hw, y0, cz + hd), d, NX],
  ];
  let u = uOff;
  for (const [a, e, len, n] of faces) {
    const u1 = u + len / tileW;
    poly(b, [a, e, V(e.x, y1, e.z), V(a.x, y1, a.z)], [[u, v0], [u1, v0], [u1, v1], [u, v1]], n, c);
    u = u1;
  }
}

function hQuad(b, x0, z0, x1, z1, y, scale = 4, c = WHITE, normal = UP) {
  poly(b, [V(x0, y, z0), V(x1, y, z0), V(x1, y, z1), V(x0, y, z1)],
    [[x0 / scale, z0 / scale], [x1 / scale, z0 / scale], [x1 / scale, z1 / scale], [x0 / scale, z1 / scale]], normal, c);
}

/** 닫힌 박스(윗면 포함, 바닥 제외) — 트림/소품용, UV는 미터/scale */
function solidBox(b, cx, y0, cz, w, h, d, scale = 2, c = WHITE, bottom = false) {
  boxSides(b, cx, y0, cz, w, h, d, scale, scale, 0, 0, c);
  hQuad(b, cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2, y0 + h, scale, c);
  if (bottom) hQuad(b, cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2, y0, scale, c, DOWN);
}

const _m3 = new THREE.Matrix3();
/** 임의의 BufferGeometry를 변환해 버킷에 추가 */
function addGeo(b, g, m, c = WHITE) {
  const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
  _m3.getNormalMatrix(m);
  const base = b.n;
  for (let i = 0; i < P.count; i++) {
    _v0.fromBufferAttribute(P, i).applyMatrix4(m);
    _v1.fromBufferAttribute(N, i).applyMatrix3(_m3).normalize();
    pushV(b, _v0, _v1, U ? U.getX(i) : 0, U ? U.getY(i) : 0, c);
  }
  if (g.index) for (let i = 0; i < g.index.count; i++) b.idx.push(base + g.index.getX(i));
  else for (let i = 0; i < P.count; i++) b.idx.push(base + i);
}

// ─── 캔버스 텍스처 ─────────────────────────────────────────────────
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function toTex(c, aniso, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}
function speckle(g, w, h, n, colors, smin, smax, rnd) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[(rnd() * colors.length) | 0];
    const s = smin + rnd() * (smax - smin);
    g.fillRect(rnd() * w, rnd() * h, s, s);
  }
}
function shade(hex, amt) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, amt);
  return `#${c.getHexString()}`;
}

const FACADES = {
  glassBlue:   { kind: 'glass',  bay: 3.0, floor: 3.8, frame: '#2b333d', top: [128, 168, 204], bot: [36, 62, 88], spandrel: '#1f2a35' },
  glassTeal:   { kind: 'glass',  bay: 3.0, floor: 3.8, frame: '#26332f', top: [128, 184, 176], bot: [30, 72, 70], spandrel: '#1b302d' },
  glassDark:   { kind: 'glass',  bay: 2.8, floor: 3.8, frame: '#15181c', top: [96, 106, 122], bot: [18, 22, 28], spandrel: '#0f1215' },
  glassBronze: { kind: 'glass',  bay: 3.2, floor: 3.8, frame: '#3a2e22', top: [164, 132, 94], bot: [52, 38, 26], spandrel: '#2b2119' },
  office:      { kind: 'grid',   bay: 3.6, floor: 3.8, wall: '#d6d1c7', top: [104, 128, 150], bot: [30, 40, 52] },
  officeDark:  { kind: 'grid',   bay: 3.6, floor: 3.8, wall: '#5d6168', top: [118, 138, 160], bot: [26, 34, 44] },
  modern:      { kind: 'ribbon', bay: 3.0, floor: 3.6, wall: '#b3b7bc', top: [128, 158, 184], bot: [35, 50, 66] },
  brickRed:    { kind: 'brick',  bay: 3.2, floor: 3.4, wall: '#8b3f2e', mortar: '#b8a38e', frame: '#ece6da', sill: '#cfc3ad', top: [110, 128, 140], bot: [24, 30, 36] },
  brickBrown:  { kind: 'brick',  bay: 3.2, floor: 3.4, wall: '#6d4b36', mortar: '#a8977f', frame: '#e4ddd0', sill: '#c2b59c', top: [110, 128, 140], bot: [24, 30, 36] },
  stone:       { kind: 'stone',  bay: 3.4, floor: 4.0, wall: '#d8cbb0', frame: '#3b342c', top: [110, 130, 146], bot: [26, 32, 40] },
  stuccoWhite: { kind: 'stucco', bay: 3.4, floor: 3.0, wall: '#ece8df', frame: '#ffffff', top: [120, 140, 156], bot: [30, 38, 46] },
  stuccoWarm:  { kind: 'stucco', bay: 3.4, floor: 3.0, wall: '#e3c9a2', frame: '#f7f1e6', top: [120, 140, 156], bot: [30, 38, 46] },
};
for (const f of Object.values(FACADES)) { f.tileW = f.bay * 8; f.tileH = f.floor * 8; }

function drawFacade(spec, seed, aniso) {
  const S = 1024, RS = 256, k = RS / S;
  const c = mkCanvas(S, S), g = c.getContext('2d');
  const rc = mkCanvas(RS, RS), rg = rc.getContext('2d');
  const rnd = mulberry32(seed);
  const P = (x, y, w, h, fill, rough, metal) => {
    g.fillStyle = fill; g.fillRect(x, y, w, h);
    if (rough != null) {
      rg.fillStyle = `rgb(255,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
      rg.fillRect(x * k, y * k, w * k, h * k);
    }
  };
  const glass = (x, y, w, h, jit = 16, metal = 0.85) => {
    const t = spec.top, bt = spec.bot, d = (rnd() - 0.5) * jit;
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, `rgb(${t[0] + d | 0},${t[1] + d | 0},${t[2] + d | 0})`);
    gr.addColorStop(1, `rgb(${bt[0] + d | 0},${bt[1] + d | 0},${bt[2] + d | 0})`);
    P(x, y, w, h, gr, 0.06, metal);
    if (rnd() < 0.14) P(x, y, w, h * (0.2 + rnd() * 0.5), 'rgba(214,208,196,0.9)', 0.7, 0);
  };
  const bw = S / 8, fh = S / 8;

  if (spec.kind === 'glass') {
    P(0, 0, S, S, spec.frame, 0.45, 0.8);
    for (let f = 0; f < 8; f++) for (let bb = 0; bb < 8; bb++) {
      const x = bb * bw, y = f * fh;
      P(x + 3, y + fh * 0.74, bw - 6, fh * 0.26 - 3, spec.spandrel, 0.3, 0.75);
      glass(x + 3, y + 3, bw - 6, fh * 0.74 - 6);
      P(x + bw / 2 - 1.5, y + 3, 3, fh * 0.74 - 6, spec.frame, 0.45, 0.8);
    }
  } else if (spec.kind === 'grid') {
    P(0, 0, S, S, spec.wall, 0.85, 0);
    speckle(g, S, S, 9000, ['rgba(0,0,0,0.05)', 'rgba(255,255,255,0.06)'], 1, 3, rnd);
    for (let f = 0; f < 8; f++) for (let bb = 0; bb < 8; bb++) {
      const x = bb * bw, y = f * fh;
      glass(x + bw * 0.14, y + fh * 0.2, bw * 0.72, fh * 0.58, 16, 0.7);
      P(x + bw * 0.14, y + fh * 0.2, bw * 0.72, 5, 'rgba(0,0,0,0.35)');
      P(x + bw * 0.14, y + fh * 0.2, 4, fh * 0.58, 'rgba(0,0,0,0.2)');
    }
  } else if (spec.kind === 'ribbon') {
    P(0, 0, S, S, spec.wall, 0.55, 0.25);
    for (let f = 0; f < 8; f++) {
      const y = f * fh;
      for (let bb = 0; bb < 8; bb++) {
        const x = bb * bw;
        glass(x, y + fh * 0.28, bw, fh * 0.46, 8, 0.8);
        P(x - 1.5, y + fh * 0.28, 3, fh * 0.46, '#2b2f35', 0.4, 0.7);
      }
      P(0, y + fh * 0.74, S, 4, 'rgba(0,0,0,0.18)');
    }
  } else if (spec.kind === 'brick') {
    P(0, 0, S, S, spec.mortar, 0.9, 0);
    for (let row = 0, y = 0; y < S; row++, y += 6) {
      for (let x = -(row % 2) * 8; x < S; x += 16) P(x, y, 15, 5, shade(spec.wall, (rnd() - 0.5) * 0.08));
    }
    for (let f = 0; f < 8; f++) for (let bb = 0; bb < 8; bb++) {
      const x = bb * bw, y = f * fh;
      P(x + bw * 0.2, y + fh * 0.1, bw * 0.6, 9, spec.sill, 0.8, 0);
      P(x + bw * 0.22, y + fh * 0.16, bw * 0.56, fh * 0.6, spec.frame, 0.6, 0);
      glass(x + bw * 0.22 + 5, y + fh * 0.16 + 5, bw * 0.56 - 10, fh * 0.6 - 10, 18, 0.5);
      P(x + bw / 2 - 2, y + fh * 0.16 + 5, 4, fh * 0.6 - 10, spec.frame, 0.6, 0);
      P(x + bw * 0.22 + 5, y + fh * 0.37, bw * 0.56 - 10, 4, spec.frame, 0.6, 0);
      P(x + bw * 0.19, y + fh * 0.76, bw * 0.62, 7, spec.sill, 0.8, 0);
    }
  } else if (spec.kind === 'stone') {
    P(0, 0, S, S, spec.wall, 0.85, 0);
    speckle(g, S, S, 7000, ['rgba(0,0,0,0.04)', 'rgba(255,255,255,0.05)'], 1, 3, rnd);
    for (let y = 0, r = 0; y < S; y += fh / 3, r++) {
      P(0, y, S, 1.5, 'rgba(0,0,0,0.16)');
      for (let x = (r % 2) * 32; x < S; x += 64) P(x, y, 1.5, fh / 3, 'rgba(0,0,0,0.1)');
    }
    for (let f = 0; f < 8; f++) for (let bb = 0; bb < 8; bb++) {
      const x = bb * bw, y = f * fh;
      P(x + bw * 0.26 - 5, y + fh * 0.1 - 5, bw * 0.48 + 10, fh * 0.72 + 10, 'rgba(0,0,0,0.12)');
      P(x + bw * 0.26, y + fh * 0.1, bw * 0.48, fh * 0.72, spec.frame, 0.5, 0.4);
      glass(x + bw * 0.26 + 4, y + fh * 0.1 + 4, bw * 0.48 - 8, fh * 0.72 - 8, 16, 0.55);
      P(x + bw * 0.26, y + fh * 0.32, bw * 0.48, 4, spec.frame, 0.5, 0.4);
      P(x + bw * 0.24, y + fh * 0.83, bw * 0.52, 6, shade(spec.wall, 0.06), 0.8, 0);
    }
  } else if (spec.kind === 'stucco') {
    P(0, 0, S, S, spec.wall, 0.92, 0);
    speckle(g, S, S, 8000, ['rgba(0,0,0,0.035)', 'rgba(255,255,255,0.05)'], 1, 3, rnd);
    for (let f = 0; f < 8; f++) for (let bb = 0; bb < 8; bb++) {
      const x = bb * bw, y = f * fh;
      P(x + bw * 0.24, y + fh * 0.16, bw * 0.52, fh * 0.56, spec.frame, 0.6, 0);
      glass(x + bw * 0.24 + 5, y + fh * 0.16 + 5, bw * 0.52 - 10, fh * 0.56 - 10, 18, 0.5);
      P(x + bw / 2 - 2, y + fh * 0.16 + 5, 4, fh * 0.56 - 10, spec.frame, 0.6, 0);
      if (bb % 2 === 0 && rnd() < 0.55) {
        P(x + bw * 0.08, y + fh * 0.8, bw * 0.84, 7, '#b9b1a4', 0.8, 0);
        P(x + bw * 0.08, y + fh * 0.58, bw * 0.84, 3, '#3f444a', 0.5, 0.6);
        for (let xx = x + bw * 0.08; xx < x + bw * 0.92; xx += 7) P(xx, y + fh * 0.58, 2, fh * 0.22, '#3f444a', 0.5, 0.6);
      }
    }
  }
  // 풍화 얼룩 (유리 파사드 제외)
  if (spec.kind !== 'glass') {
    for (let i = 0; i < 40; i++) {
      const x = rnd() * S, w = 6 + rnd() * 30, gr = g.createLinearGradient(0, 0, 0, S);
      gr.addColorStop(0, 'rgba(40,35,30,0.07)'); gr.addColorStop(1, 'rgba(40,35,30,0)');
      g.fillStyle = gr; g.fillRect(x, 0, w, S * (0.3 + rnd() * 0.7));
    }
  }
  return { map: toTex(c, aniso), rm: toTex(rc, aniso, false) };
}

function drawStorefront(aniso) {
  const W = 1024, H = 256, k = 0.25;
  const c = mkCanvas(W, H), g = c.getContext('2d');
  const rc = mkCanvas(W * k, H * k), rg = rc.getContext('2d');
  const rnd = mulberry32(99);
  const P = (x, y, w, h, fill, rough, metal) => {
    g.fillStyle = fill; g.fillRect(x, y, w, h);
    if (rough != null) {
      rg.fillStyle = `rgb(255,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
      rg.fillRect(x * k, y * k, w * k, h * k);
    }
  };
  const signs = ['#b3261e', '#1f5aa6', '#1e7a46', '#e0a100', '#6b2c91', '#d9480f', '#0b7285', '#222222'];
  P(0, 0, W, H, '#5a5550', 0.8, 0);
  for (let s = 0; s < 4; s++) {
    const x0 = s * 256;
    const sc = signs[(rnd() * signs.length) | 0];
    P(x0, 0, 256, 44, sc, 0.45, 0.1);
    for (let i = 0, x = x0 + 30 + rnd() * 30; i < 5 + rnd() * 3 && x < x0 + 220; i++) {
      const w = 10 + rnd() * 14;
      P(x, 16, w, 14, 'rgba(255,250,235,0.92)', 0.4, 0); x += w + 5;
    }
    const awning = rnd() < 0.55;
    if (awning) {
      for (let x = x0 + 8; x < x0 + 248; x += 16) P(x, 44, 8, 30, shade(sc, 0.08), 0.9, 0);
      for (let x = x0 + 16; x < x0 + 248; x += 16) P(x, 44, 8, 30, '#f1ede4', 0.9, 0);
      P(x0 + 8, 74, 240, 4, 'rgba(0,0,0,0.35)');
    } else {
      P(x0 + 8, 44, 240, 10, '#2b2e33', 0.4, 0.7);
    }
    const gy = awning ? 78 : 54;
    const gr = g.createLinearGradient(0, gy, 0, 228);
    gr.addColorStop(0, '#3a4450'); gr.addColorStop(1, '#141a20');
    P(x0 + 14, gy, 228, 228 - gy, gr, 0.05, 0.6);
    for (let i = 0; i < 6; i++) {
      const hue = [30, 40, 200, 350, 120][(rnd() * 5) | 0];
      g.fillStyle = `hsla(${hue},45%,55%,0.28)`;
      g.fillRect(x0 + 20 + rnd() * 150, gy + 40 + rnd() * 90, 20 + rnd() * 40, 10 + rnd() * 50);
    }
    P(x0 + 14, 160, 228, 3, 'rgba(255,240,210,0.25)');
    P(x0 + 90, gy, 4, 228 - gy, '#2a2d31', 0.4, 0.7);
    P(x0 + 170, gy + 8, 60, 220 - gy, '#0e1216', 0.05, 0.5);
    P(x0 + 168, gy + 6, 64, 4, '#9aa0a6', 0.35, 0.9);
    P(x0 + 168, gy + 6, 3, 222 - gy, '#9aa0a6', 0.35, 0.9);
    P(x0 + 229, gy + 6, 3, 222 - gy, '#9aa0a6', 0.35, 0.9);
    P(x0, 228, 256, 28, '#2e2c2a', 0.6, 0.1);
    P(x0, 0, 14, 256, '#6e6760', 0.85, 0);
    P(x0 + 242, 0, 14, 256, '#6e6760', 0.85, 0);
  }
  return { map: toTex(c, aniso), rm: toTex(rc, aniso, false) };
}

function simpleTex(size, aniso, draw, srgb = true) {
  const c = mkCanvas(size, size), g = c.getContext('2d');
  draw(g, size);
  return toTex(c, aniso, srgb);
}

function makeTextures(aniso) {
  const r = mulberry32(7);
  const t = {};
  t.asphalt = simpleTex(512, aniso, (g, S) => {
    g.fillStyle = '#4b4b4d'; g.fillRect(0, 0, S, S);
    speckle(g, S, S, 26000, ['rgba(255,255,255,0.06)', 'rgba(0,0,0,0.14)', 'rgba(120,110,100,0.08)'], 1, 2.2, r);
    for (let i = 0; i < 14; i++) {
      g.fillStyle = `rgba(0,0,0,${0.03 + r() * 0.05})`;
      g.beginPath(); g.ellipse(r() * S, r() * S, 20 + r() * 60, 10 + r() * 40, r() * 3, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = 'rgba(15,15,15,0.18)'; g.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      g.beginPath(); let x = r() * S, y = r() * S; g.moveTo(x, y);
      for (let j = 0; j < 8; j++) { x += (r() - 0.5) * 40; y += (r() - 0.5) * 40; g.lineTo(x, y); }
      g.stroke();
    }
  });
  t.sidewalk = simpleTex(512, aniso, (g, S) => {
    const n = 4, s = S / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      g.fillStyle = shade('#bab5ac', (r() - 0.5) * 0.05); g.fillRect(i * s, j * s, s, s);
    }
    speckle(g, S, S, 12000, ['rgba(0,0,0,0.06)', 'rgba(255,255,255,0.08)'], 1, 2, r);
    g.fillStyle = 'rgba(70,65,60,0.45)';
    for (let i = 0; i <= n; i++) { g.fillRect(i * s - 1.5, 0, 3, S); g.fillRect(0, i * s - 1.5, S, 3); }
    for (let i = 0; i < 5; i++) {
      g.fillStyle = 'rgba(60,55,50,0.06)'; g.beginPath();
      g.arc(r() * S, r() * S, 10 + r() * 40, 0, Math.PI * 2); g.fill();
    }
  });
  t.grass = simpleTex(512, aniso, (g, S) => {
    g.fillStyle = '#4c7a31'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 20; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '90,120,40' : '40,80,30'},0.18)`;
      g.beginPath(); g.arc(r() * S, r() * S, 30 + r() * 80, 0, Math.PI * 2); g.fill();
    }
    speckle(g, S, S, 30000, ['rgba(120,160,60,0.35)', 'rgba(30,60,20,0.35)', 'rgba(160,170,80,0.2)'], 1, 2.5, r);
  });
  t.plaza = simpleTex(512, aniso, (g, S) => {
    const n = 8, s = S / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      g.fillStyle = (i + j) % 2 ? shade('#c9c1b3', (r() - 0.5) * 0.04) : shade('#a9a399', (r() - 0.5) * 0.04);
      g.fillRect(i * s, j * s, s, s);
    }
    speckle(g, S, S, 10000, ['rgba(0,0,0,0.07)', 'rgba(255,255,255,0.08)'], 1, 2, r);
    g.fillStyle = 'rgba(60,55,50,0.35)';
    for (let i = 0; i <= n; i++) { g.fillRect(i * s - 1, 0, 2, S); g.fillRect(0, i * s - 1, S, 2); }
  });
  t.gravel = simpleTex(256, aniso, (g, S) => {
    g.fillStyle = '#65635f'; g.fillRect(0, 0, S, S);
    speckle(g, S, S, 9000, ['rgba(0,0,0,0.18)', 'rgba(255,255,255,0.1)', 'rgba(90,80,70,0.2)'], 1, 2.5, r);
  });
  t.path = simpleTex(256, aniso, (g, S) => {
    g.fillStyle = '#c4ae86'; g.fillRect(0, 0, S, S);
    speckle(g, S, S, 7000, ['rgba(0,0,0,0.1)', 'rgba(255,255,255,0.15)'], 1, 2.5, r);
  });
  t.roofTile = simpleTex(256, aniso, (g, S) => {
    g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, S, S);
    for (let row = 0, y = 0; y < S; row++, y += 16) {
      const gr = g.createLinearGradient(0, y, 0, y + 16);
      gr.addColorStop(0, 'rgba(255,255,255,0.1)'); gr.addColorStop(1, 'rgba(0,0,0,0.35)');
      g.fillStyle = gr; g.fillRect(0, y, S, 16);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      for (let x = (row % 2) * 12; x < S; x += 24) g.fillRect(x, y, 2, 16);
    }
  });
  t.leaf = simpleTex(256, aniso, (g, S) => {
    g.fillStyle = '#c4c4c4'; g.fillRect(0, 0, S, S);
    g.filter = 'blur(1.2px)';
    speckle(g, S, S, 2500, ['rgba(255,255,255,0.18)', 'rgba(0,0,0,0.16)', 'rgba(60,60,60,0.12)'], 4, 10, r);
    g.filter = 'none';
  });
  t.concrete = simpleTex(256, aniso, (g, S) => {
    g.fillStyle = '#b3aea5'; g.fillRect(0, 0, S, S);
    speckle(g, S, S, 6000, ['rgba(0,0,0,0.06)', 'rgba(255,255,255,0.07)'], 1, 3, r);
  });
  return t;
}

// ─── 재질 ──────────────────────────────────────────────────────────
function makeMaterials(tex, facadeTex, storefront) {
  const M = {};
  const std = (o) => new THREE.MeshStandardMaterial(o);
  for (const [name, ft] of Object.entries(facadeTex)) {
    M[name] = std({ map: ft.map, roughnessMap: ft.rm, metalnessMap: ft.rm, roughness: 1, metalness: 1 });
  }
  M.storefront = std({ map: storefront.map, roughnessMap: storefront.rm, metalnessMap: storefront.rm, roughness: 1, metalness: 1 });
  M.asphalt = std({ map: tex.asphalt, roughness: 0.95, envMapIntensity: 0.5 });
  M.sidewalk = std({ map: tex.sidewalk, roughness: 0.88 });
  M.curb = std({ map: tex.concrete, color: 0xd6d2ca, roughness: 0.8 });
  M.grass = std({ map: tex.grass, roughness: 0.95 });
  M.plaza = std({ map: tex.plaza, roughness: 0.7 });
  M.path = std({ map: tex.path, roughness: 0.95 });
  M.roof = std({ map: tex.gravel, roughness: 1, envMapIntensity: 0.6 });
  M.trim = std({ map: tex.concrete, roughness: 0.8 });
  M.trimDark = std({ color: 0x3a3f46, roughness: 0.45, metalness: 0.6 });
  M.roofTile = std({ map: tex.roofTile, vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
  M.foliage = std({ map: tex.leaf, vertexColors: true, roughness: 0.85 });
  M.bark = std({ color: 0x5b4636, roughness: 0.95 });
  M.prop = std({ vertexColors: true, roughness: 0.75, metalness: 0.1 });
  M.propMetal = std({ vertexColors: true, roughness: 0.4, metalness: 0.7 });
  M.lampGlow = std({ color: 0xfff6e0, emissive: 0xfff0cc, emissiveIntensity: 1.2 });
  M.redGlow = std({ color: 0xff2020, emissive: 0xff1010, emissiveIntensity: 2 });
  const mark = (color) => std({ color, roughness: 0.65, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  M.white = mark(0xefefe9);
  M.yellow = mark(0xe3b21e);
  M.water = std({ color: 0x2c5866, roughness: 0.06, metalness: 0.4 });
  M.glassClear = std({ color: 0x9fb8c8, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.35, depthWrite: false });
  M.carPaint = std({ vertexColors: true, roughness: 0.28, metalness: 0.55 });
  M.carGlass = std({ color: 0x14181d, roughness: 0.08, metalness: 0.7 });
  M.tire = std({ color: 0x1b1b1b, roughness: 0.9 });
  M.signalHousing = std({ color: 0x1d2023, roughness: 0.5, metalness: 0.5 });
  M.water.envMapIntensity = 1.2;
  return M;
}

const SHADOW_CASTERS = new Set([
  ...Object.keys(FACADES), 'storefront', 'trim', 'trimDark', 'roofTile', 'foliage', 'bark', 'prop', 'propMetal',
  'signalHousing', 'carPaint', 'carGlass',
]);

// ─── 공용 프리미티브 ───────────────────────────────────────────────
const PRIM = {
  cyl: new THREE.CylinderGeometry(1, 1, 1, 10),
  cylHi: new THREE.CylinderGeometry(1, 1, 1, 20),
  cone: new THREE.ConeGeometry(1, 1, 10),
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.SphereGeometry(1, 10, 6),
  disc: new THREE.CylinderGeometry(1, 1, 1, 8),
  hemi: new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
};
// 나무 수관: 노이즈로 변형한 구 3종
PRIM.canopy = [0, 1, 2].map((s) => {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const rnd = mulberry32(100 + s);
  const p = g.attributes.position;
  const bumps = Array.from({ length: 6 }, () => [V(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), 0.12 + rnd() * 0.12]);
  for (let i = 0; i < p.count; i++) {
    _v0.fromBufferAttribute(p, i);
    const dir = _v0.clone().normalize();
    let f = 1;
    for (const [bd, a] of bumps) f += a * Math.max(0, dir.dot(bd)) ** 2;
    _v0.multiplyScalar(f);
    p.setXYZ(i, _v0.x, _v0.y, _v0.z);
  }
  // 비인덱스 지오메트리라 computeVertexNormals()는 면마다 각진 음영을 만든다.
  // 방사 방향 법선을 쓰면 수관이 부드럽게 보인다.
  const nrm = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    _v0.fromBufferAttribute(p, i).normalize();
    nrm.setXYZ(i, _v0.x, _v0.y * 0.8 + 0.2, _v0.z);
  }
  return g;
});

const ROT_X90 = new THREE.Matrix4().makeRotationX(Math.PI / 2);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
function trs(x, y, z, sx, sy, sz, rotY = 0) {
  _q.setFromAxisAngle(UP, rotY);
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

// ─── 메인 생성 함수 ────────────────────────────────────────────────
export function createCity({ scene, world, renderer, groundMaterial }) {
  const t0 = performance.now();
  const rnd = mulberry32(20240613);
  const R = (a, b) => a + (b - a) * rnd();
  const pick = (arr) => arr[(rnd() * arr.length) | 0];

  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tex = makeTextures(aniso);
  const facadeTex = {};
  let seed = 1;
  for (const [name, spec] of Object.entries(FACADES)) facadeTex[name] = drawFacade(spec, seed++, aniso);
  const M = makeMaterials(tex, facadeTex, drawStorefront(aniso));
  const B = new Buckets();
  const root = new THREE.Group();
  root.name = 'City';
  scene.add(root);

  // ── 정적 충돌체 헬퍼 ──
  function staticBody(cx, cz) {
    const body = new CANNON.Body({ mass: 0, material: groundMaterial });
    body.position.set(cx, GROUND_Y, cz);
    body.userData = { cx, cz };
    return body;
  }
  function addBoxShape(body, x, y0, z, w, h, d, rotY = 0) {
    const q = new CANNON.Quaternion();
    q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotY);
    body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)),
      new CANNON.Vec3(x - body.position.x, y0 + h / 2 - GROUND_Y, z - body.position.z), q);
  }

  // ── 도로 그래프 ──
  const xType = XS.map((p) => roadTypeAt(p, XS));
  const zType = ZS.map((p) => roadTypeAt(p, ZS));
  const xW = xType.map((t) => ROAD_TYPES[t].width);
  const zW = zType.map((t) => ROAD_TYPES[t].width);
  const inPark = (x, z) => x > PARK.x0 && x < PARK.x1 && z > PARK.z0 && z < PARK.z1;

  const nodes = [];
  const nodeAt = (i, j) => nodes[i * ZS.length + j];
  for (let i = 0; i < XS.length; i++) for (let j = 0; j < ZS.length; j++) {
    nodes.push({ i, j, x: XS[i], z: ZS[j], hx: xW[i] / 2, hz: zW[j] / 2, legs: {}, exists: false });
  }
  const segments = [];
  function addSegment(a, b, axis) {
    // axis 'z' = N-S 도로(z 방향으로 뻗음), 'x' = E-W 도로
    const type = axis === 'z' ? xType[a.i] : zType[a.j];
    const def = ROAD_TYPES[type];
    const seg = { id: segments.length, a, b, axis, type, def };
    if (axis === 'z') {
      seg.p = a.x; seg.s0 = a.z + a.hz; seg.s1 = b.z - b.hz;
      a.legs.S = seg; b.legs.N = seg;          // N = -z 방향, S = +z 방향
    } else {
      seg.p = a.z; seg.s0 = a.x + a.hx; seg.s1 = b.x - b.hx;
      a.legs.E = seg; b.legs.W = seg;          // E = +x, W = -x
    }
    seg.len = seg.s1 - seg.s0;
    a.exists = b.exists = true;
    segments.push(seg);
  }
  for (let i = 0; i < XS.length; i++) for (let j = 0; j < ZS.length - 1; j++) {
    const a = nodeAt(i, j), b = nodeAt(i, j + 1);
    if (inPark(a.x, (a.z + b.z) / 2)) continue;
    addSegment(a, b, 'z');
  }
  for (let j = 0; j < ZS.length; j++) for (let i = 0; i < XS.length - 1; i++) {
    const a = nodeAt(i, j), b = nodeAt(i + 1, j);
    if (inPark((a.x + b.x) / 2, a.z)) continue;
    addSegment(a, b, 'x');
  }

  // 세그먼트 위의 점: s = 도로 축 좌표, off = 도로 중심선으로부터의 횡방향 좌표(+x 또는 +z)
  const segPoint = (seg, s, off) => (seg.axis === 'z' ? V(seg.p + off, 0, s) : V(s, 0, seg.p + off));

  // ── 지면 ──
  const EDGE = CITY_EDGE + ROAD_TYPES.ring.width / 2;
  {
    const size = EDGE * 2 + 2;
    const g = new THREE.PlaneGeometry(size, size);
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * size / 9, uv.getY(i) * size / 9);
    const asphalt = new THREE.Mesh(g, M.asphalt);
    asphalt.position.y = GROUND_Y;
    asphalt.receiveShadow = true;
    root.add(asphalt);

    const gg = new THREE.PlaneGeometry(9000, 9000);
    gg.rotateX(-Math.PI / 2);
    const guv = gg.attributes.uv;
    for (let i = 0; i < guv.count; i++) guv.setXY(i, guv.getX(i) * 900, guv.getY(i) * 900);
    const grass = new THREE.Mesh(gg, M.grass);
    grass.position.y = GROUND_Y - 0.04;
    grass.receiveShadow = true;
    root.add(grass);
  }

  // ── 노면 표시 ──
  function markRect(mat, seg, sA, sB, offA, offB) {
    const p0 = segPoint(seg, sA, offA), p1 = segPoint(seg, sB, offB);
    const b = B.get(mat, (p0.x + p1.x) / 2, (p0.z + p1.z) / 2);
    hQuad(b, Math.min(p0.x, p1.x), Math.min(p0.z, p1.z), Math.max(p0.x, p1.x), Math.max(p0.z, p1.z), MARK_Y, 1);
  }
  const CROSSWALK = 4.2;
  function buildRoads() {
  for (const seg of segments) {
    const d = seg.def, half = d.width / 2, med = d.median / 2;
    const a = seg.s0 + CROSSWALK + 1.2, e = seg.s1 - CROSSWALK - 1.2;
    // 중앙선
    if (!d.raised) {
      markRect('yellow', seg, a - 1, e + 1, -0.28, -0.14);
      markRect('yellow', seg, a - 1, e + 1, 0.14, 0.28);
    }
    // 차선 구분 점선
    for (const side of [-1, 1]) {
      for (let k = 1; k < d.lanes; k++) {
        const off = side * (med + d.laneW * k);
        for (let s = a + 2; s < e - 3; s += 9) markRect('white', seg, s, Math.min(s + 3, e), off - 0.07, off + 0.07);
      }
      // 가장자리 실선
      const eo = side * (half - 0.45);
      markRect('white', seg, a - 1, e + 1, eo - 0.08, eo + 0.08);
    }
    // 횡단보도 + 정지선
    for (const end of [0, 1]) {
      const sEdge = end === 0 ? seg.s0 : seg.s1;
      const dir = end === 0 ? 1 : -1;
      const c0 = sEdge + dir * 0.6, c1 = sEdge + dir * (0.6 + CROSSWALK - 0.6);
      for (let off = -half + 1.0; off < half - 0.9; off += 1.3) markRect('white', seg, Math.min(c0, c1), Math.max(c0, c1), off, off + 0.65);
      // 정지선: 이 끝으로 진입하는 차로(우측 통행) 쪽에만
      const stopS = sEdge + dir * (CROSSWALK + 0.8);
      // end 0(=s0)으로 들어오는 차량은 -축 방향 진행 → 오른쪽은 +off (axis z일 때 heading -z의 오른쪽은 +x)
      // axis x에서 heading -x의 오른쪽은 -z → -off
      const sideSign = seg.axis === 'z' ? (end === 0 ? 1 : -1) : (end === 0 ? -1 : 1);
      const o0 = sideSign > 0 ? med : -half + 0.3, o1 = sideSign > 0 ? half - 0.3 : -med;
      markRect('white', seg, Math.min(stopS, stopS + dir * 0.5), Math.max(stopS, stopS + dir * 0.5), o0, o1);
    }
    // 중앙분리대(대로/순환도로)
    if (d.raised) {
      const body = staticBody(...(seg.axis === 'z' ? [seg.p, (a + e) / 2] : [(a + e) / 2, seg.p]));
      const w = d.median - 0.6;
      const p0 = segPoint(seg, a + 2, -w / 2), p1 = segPoint(seg, e - 2, w / 2);
      const x0 = Math.min(p0.x, p1.x), x1 = Math.max(p0.x, p1.x), z0 = Math.min(p0.z, p1.z), z1 = Math.max(p0.z, p1.z);
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      boxSides(B.get('curb', cx, cz), cx, GROUND_Y, cz, x1 - x0, CURB_H + 0.05, z1 - z0, 1, 1);
      hQuad(B.get(seg.type === 'boulevard' ? 'grass' : 'curb', cx, cz), x0, z0, x1, z1, SIDEWALK_TOP + 0.05, 6);
      addBoxShape(body, cx, GROUND_Y - 1, cz, x1 - x0, 1 + CURB_H + 0.05, z1 - z0);
      if (seg.type === 'boulevard') {
        for (let s = a + 8; s < e - 6; s += 14) {
          const p = segPoint(seg, s, 0);
          tree(p.x, p.z, SIDEWALK_TOP + 0.05, body, 'street');
        }
        for (let s = a + 15; s < e - 6; s += 28) {
          const p = segPoint(seg, s, 0);
          streetLampDouble(p.x, p.z, seg.axis, SIDEWALK_TOP + 0.05, body);
        }
      }
      world.addBody(body);
    }
  }
  }

  // ── 가드레일 (도시 외곽) ──
  {
    const body = new CANNON.Body({ mass: 0, material: groundMaterial });
    const G = EDGE + 0.8;
    const railB = (x, z) => B.get('propMetal', x, z);
    const rail = new THREE.Color(0xb8bcc0), post = new THREE.Color(0x70757a);
    for (const [ax, sign] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]]) {
      const cx = ax === 'x' ? sign * G : 0, cz = ax === 'z' ? sign * G : 0;
      const w = ax === 'x' ? 0.3 : G * 2, d = ax === 'x' ? G * 2 : 0.3;
      body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2 + 0.2, 2, d / 2 + 0.2)), new CANNON.Vec3(cx, GROUND_Y + 1, cz));
      for (let t = -G; t < G; t += 40) {
        const x = ax === 'x' ? cx : t + 20, z = ax === 'z' ? cz : t + 20;
        solidBox(railB(x, z), x, GROUND_Y + 0.55, z, ax === 'x' ? 0.12 : 40, 0.32, ax === 'x' ? 40 : 0.12, 2, rail);
      }
      for (let t = -G; t <= G; t += 4) {
        const x = ax === 'x' ? cx + sign * 0.12 : t, z = ax === 'z' ? cz + sign * 0.12 : t;
        solidBox(railB(x, z), x, GROUND_Y, z, 0.14, 0.9, 0.14, 1, post);
      }
    }
    world.addBody(body);
  }

  // ── 가로 시설물 ──
  function tree(x, z, y, body, kind = 'street', scale = 1) {
    const h = (kind === 'park' ? R(3.2, 5.5) : R(2.6, 3.6)) * scale;
    const cr = (kind === 'park' ? R(2.4, 4.2) : R(1.9, 2.8)) * scale;
    addGeo(B.get('bark', x, z), PRIM.cyl, trs(x, y + h / 2, z, 0.16 * scale + 0.06, h, 0.16 * scale + 0.06));
    const col = new THREE.Color().setHSL(R(0.22, 0.32), R(0.35, 0.55), R(0.22, 0.34));
    const n = kind === 'park' ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const ox = i === 0 ? 0 : R(-0.5, 0.5) * cr, oz = i === 0 ? 0 : R(-0.5, 0.5) * cr;
      const s = cr * (i === 0 ? 1 : R(0.6, 0.8));
      addGeo(B.get('foliage', x, z), pick(PRIM.canopy), trs(x + ox, y + h + s * 0.7 + (i ? R(-0.3, 0.6) : 0), z + oz, s, s * R(0.85, 1.1), s, R(0, 6)), col);
    }
    if (body) addBoxShape(body, x, GROUND_Y, z, 0.5, 5, 0.5);
  }
  function conifer(x, z, y, body) {
    const h = R(7, 12), r = h * R(0.22, 0.3);
    addGeo(B.get('bark', x, z), PRIM.cyl, trs(x, y + 1, z, 0.22, 2, 0.22));
    const col = new THREE.Color().setHSL(R(0.3, 0.38), R(0.35, 0.5), R(0.14, 0.2));
    for (let i = 0; i < 3; i++) {
      const s = r * (1 - i * 0.25);
      addGeo(B.get('foliage', x, z), PRIM.cone, trs(x, y + 1.5 + i * h * 0.25 + h * 0.2, z, s, h * 0.45, s), col);
    }
    if (body) addBoxShape(body, x, GROUND_Y, z, 0.5, 5, 0.5);
  }

  const lampCol = new THREE.Color(0x3b3f44);
  /** 보도 가로등. toRoad = 도로 쪽 단위벡터 */
  function streetLamp(x, z, toRoad, y, body) {
    const rot = Math.atan2(-toRoad.z, toRoad.x); // 로컬 +x를 toRoad로
    const b = B.get('propMetal', x, z);
    addGeo(b, PRIM.cyl, trs(x, y + 4.5, z, 0.11, 9, 0.11), lampCol);
    addGeo(b, PRIM.cyl, trs(x, y + 0.4, z, 0.2, 0.8, 0.2), lampCol);
    const ax = x + toRoad.x * 1.4, az = z + toRoad.z * 1.4;
    addGeo(b, PRIM.box, trs(ax, y + 8.85, az, 2.8, 0.1, 0.1, rot), lampCol);
    const hx = x + toRoad.x * 2.7, hz = z + toRoad.z * 2.7;
    addGeo(b, PRIM.box, trs(hx, y + 8.8, hz, 1.0, 0.18, 0.42, rot), lampCol);
    addGeo(B.get('lampGlow', x, z), PRIM.box, trs(hx, y + 8.7, hz, 0.8, 0.04, 0.3, rot));
    if (body) addBoxShape(body, x, GROUND_Y, z, 0.35, 6, 0.35);
  }
  function streetLampDouble(x, z, axis, y, body) {
    const b = B.get('propMetal', x, z);
    addGeo(b, PRIM.cyl, trs(x, y + 4.5, z, 0.13, 9, 0.13), lampCol);
    const across = axis === 'z' ? PX : PZ;
    const rot = axis === 'z' ? 0 : Math.PI / 2;
    addGeo(b, PRIM.box, trs(x, y + 8.85, z, 5.2, 0.1, 0.1, rot), lampCol);
    for (const s of [-1, 1]) {
      const hx = x + across.x * 2.6 * s, hz = z + across.z * 2.6 * s;
      addGeo(b, PRIM.box, trs(hx, y + 8.8, hz, 1.0, 0.18, 0.42, rot), lampCol);
      addGeo(B.get('lampGlow', x, z), PRIM.box, trs(hx, y + 8.7, hz, 0.8, 0.04, 0.3, rot));
    }
    if (body) addBoxShape(body, x, GROUND_Y, z, 0.4, 6, 0.4);
  }
  function parkLamp(x, z, y, body) {
    const b = B.get('propMetal', x, z);
    addGeo(b, PRIM.cyl, trs(x, y + 2, z, 0.07, 4, 0.07), new THREE.Color(0x2b2f2c));
    addGeo(B.get('lampGlow', x, z), PRIM.sphere, trs(x, y + 4.15, z, 0.28, 0.28, 0.28));
    if (body) addBoxShape(body, x, GROUND_Y, z, 0.25, 5, 0.25);
  }
  function bench(x, z, y, rotY) {
    const b = B.get('prop', x, z);
    const wood = new THREE.Color(0x7a5536), iron = new THREE.Color(0x2a2c2e);
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    let [px, pz] = at(0, 0);
    addGeo(b, PRIM.box, trs(px, y + 0.45, pz, 1.8, 0.07, 0.5, rotY), wood);
    [px, pz] = at(0, 0.24);
    addGeo(b, PRIM.box, trs(px, y + 0.75, pz, 1.8, 0.4, 0.06, rotY), wood);
    for (const lx of [-0.8, 0.8]) { [px, pz] = at(lx, 0); addGeo(b, PRIM.box, trs(px, y + 0.22, pz, 0.06, 0.45, 0.5, rotY), iron); }
  }
  function hydrant(x, z, y) {
    const b = B.get('prop', x, z), red = new THREE.Color(0xb3211b);
    addGeo(b, PRIM.cyl, trs(x, y + 0.35, z, 0.16, 0.7, 0.16), red);
    addGeo(b, PRIM.sphere, trs(x, y + 0.72, z, 0.17, 0.12, 0.17), red);
    addGeo(b, PRIM.cyl, trs(x, y + 0.45, z, 0.07, 0.5, 0.07).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)), red);
  }
  function trashBin(x, z, y) {
    addGeo(B.get('prop', x, z), PRIM.cyl, trs(x, y + 0.5, z, 0.3, 1.0, 0.3), new THREE.Color(0x2f4a3a));
  }
  function busStop(x, z, y, toRoad, body) {
    const rot = Math.atan2(-toRoad.z, toRoad.x) + Math.PI / 2;
    const along = V(-toRoad.z, 0, toRoad.x);
    const b = B.get('propMetal', x, z), frame = new THREE.Color(0x4a4f55);
    addGeo(b, PRIM.box, trs(x, y + 2.6, z, 5, 0.12, 1.8, rot), frame);
    for (const s of [-1, 1]) {
      const px = x + along.x * s * 2.4 - toRoad.x * 0.8, pz = z + along.z * s * 2.4 - toRoad.z * 0.8;
      addGeo(b, PRIM.box, trs(px, y + 1.3, pz, 0.08, 2.6, 0.08, rot), frame);
    }
    const bx = x - toRoad.x * 0.85, bz = z - toRoad.z * 0.85;
    addGeo(B.get('glassClear', x, z), PRIM.box, trs(bx, y + 1.4, bz, 4.8, 2.2, 0.05, rot));
    addGeo(B.get('prop', x, z), PRIM.box, trs(bx + toRoad.x * 0.35, y + 0.45, bz + toRoad.z * 0.35, 3.5, 0.08, 0.45, rot), new THREE.Color(0x6b7075));
    if (body) addBoxShape(body, bx, GROUND_Y, bz, Math.abs(along.x) * 4.8 + 0.2, 4, Math.abs(along.z) * 4.8 + 0.2);
  }

  // ── 신호등 ──
  const signalMats = {};
  for (const axis of ['ns', 'ew']) {
    signalMats[axis] = {};
    for (const [c, hex] of [['r', 0xff2a1a], ['y', 0xffb300], ['g', 0x19e37a]]) {
      signalMats[axis][c] = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: hex, emissiveIntensity: 0.05, roughness: 0.3 });
      M[`sig_${axis}_${c}`] = signalMats[axis][c];
    }
  }
  const signalHeads = []; // AI 참고용: { node, heading, stop }
  function trafficSignal(node, D, body) {
    // D: 노드에서 다리(leg) 방향 단위벡터. 접근 차량 진행 방향 h = -D
    const h = D.clone().negate();
    const r = V(-h.z, 0, h.x);
    const alongHalf = D.x !== 0 ? node.hx : node.hz;
    const legHalf = D.x !== 0 ? node.hz : node.hx;
    const px = node.x + D.x * (alongHalf + 1.2) + r.x * (legHalf + 1.4);
    const pz = node.z + D.z * (alongHalf + 1.2) + r.z * (legHalf + 1.4);
    const y = SIDEWALK_TOP;
    const col = new THREE.Color(0x2e3237);
    const b = B.get('propMetal', px, pz);
    addGeo(b, PRIM.cyl, trs(px, y + 3.6, pz, 0.16, 7.2, 0.16), col);
    const armLen = legHalf - 1.5;
    const rot = Math.atan2(r.z, -r.x); // 로컬 +x → -r (도로 쪽)
    const ax = px - r.x * armLen / 2, az = pz - r.z * armLen / 2;
    addGeo(b, PRIM.box, trs(ax, y + 6.9, az, armLen, 0.16, 0.16, rot), col);
    const axis = D.z !== 0 ? 'ns' : 'ew';
    const heads = [armLen * 0.95, armLen * 0.45];
    for (const dist of heads) {
      const hx = px - r.x * dist, hz = pz - r.z * dist;
      addGeo(B.get('signalHousing', hx, hz), PRIM.box, trs(hx, y + 6.1, hz, 0.45, 1.25, 0.42, rot));
      const fx = hx - h.x * 0.23, fz = hz - h.z * 0.23;
      for (const [c, dy] of [['r', 0.38], ['y', 0], ['g', -0.38]]) {
        addGeo(B.get(`sig_${axis}_${c}`, hx, hz), PRIM.disc, trs(fx, y + 6.1 + dy, fz, 0.16, 0.06, 0.16, rot).multiply(ROT_X90));
      }
    }
    // 보행자 버튼 기둥 주변 소화전 (가끔)
    // 신호등 기둥에서 교차로 반대쪽(보도 안쪽)으로 떨어진 위치. h 방향은 교차로 쪽이라 차도가 된다.
    if (rnd() < 0.25) hydrant(px - h.x * 3, pz - h.z * 3, y);
    if (body) addBoxShape(body, px, GROUND_Y, pz, 0.4, 8, 0.4);
    signalHeads.push({ node, heading: h, axis });
  }

  // ── 건물 헬퍼 ──
  const facadeNames = {
    glass: ['glassBlue', 'glassTeal', 'glassDark', 'glassBronze'],
    downtownAll: ['glassBlue', 'glassTeal', 'glassDark', 'glassBronze', 'glassBlue', 'office', 'officeDark', 'modern'],
    midtown: ['brickRed', 'brickBrown', 'stone', 'office', 'modern', 'officeDark', 'brickRed', 'stone'],
    residential: ['stuccoWhite', 'stuccoWarm', 'brickRed', 'brickBrown', 'stuccoWhite'],
  };
  function walls(style, cx, y0, cz, w, h, d, vOffMeters = 0, uOffBays = null) {
    const f = FACADES[style];
    const uOff = (uOffBays ?? ((rnd() * 8) | 0)) / 8;
    boxSides(B.get(style, cx, cz), cx, y0, cz, w, h, d, f.tileW, f.tileH, uOff, vOffMeters / f.tileH);
  }
  function storefront(cx, y0, cz, w, d) {
    boxSides(B.get('storefront', cx, cz), cx, y0, cz, w, 5, d, 32, 5, (rnd() * 4 | 0) / 4, 0);
    solidBox(B.get('trimDark', cx, cz), cx, y0 + 5, cz, w + 0.5, 0.35, d + 0.5, 2);
  }
  function roof(cx, y, cz, w, d, mat = 'roof') {
    hQuad(B.get(mat, cx, cz), cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2, y, 5);
  }
  function parapet(cx, y, cz, w, d, h = 1.1, mat = 'trim', t = 0.35) {
    const b = B.get(mat, cx, cz);
    solidBox(b, cx, y, cz - d / 2 + t / 2, w, h, t, 2);
    solidBox(b, cx, y, cz + d / 2 - t / 2, w, h, t, 2);
    solidBox(b, cx - w / 2 + t / 2, y, cz, t, h, d - 2 * t, 2);
    solidBox(b, cx + w / 2 - t / 2, y, cz, t, h, d - 2 * t, 2);
  }
  const acCol = new THREE.Color(0xa7aaad);
  function acUnits(cx, y, cz, w, d, n) {
    for (let i = 0; i < n; i++) {
      const x = cx + R(-0.35, 0.35) * w, z = cz + R(-0.35, 0.35) * d;
      const sx = R(1.4, 2.6), sz = R(1.2, 2.0);
      solidBox(B.get('prop', x, z), x, y, z, sx, R(0.9, 1.5), sz, 1, acCol);
    }
  }
  function waterTank(x, y, z) {
    const wood = new THREE.Color(0x7d5a3c), dark = new THREE.Color(0x3a3634);
    const b = B.get('prop', x, z);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      addGeo(b, PRIM.cyl, trs(x + Math.cos(a) * 1.3, y + 1.4, z + Math.sin(a) * 1.3, 0.1, 2.8, 0.1), dark);
    }
    addGeo(b, PRIM.cylHi, trs(x, y + 4.2, z, 1.9, 2.8, 1.9), wood);
    addGeo(b, PRIM.cone, trs(x, y + 6.1, z, 2.0, 1.0, 2.0), dark);
  }
  function spire(x, y, z, h) {
    addGeo(B.get('propMetal', x, z), PRIM.cyl, trs(x, y + h / 2, z, 0.35, h, 0.35), new THREE.Color(0xb0b4b8));
    addGeo(B.get('propMetal', x, z), PRIM.cyl, trs(x, y + h * 0.15, z, 1.2, h * 0.3, 1.2), new THREE.Color(0x6e7378));
    addGeo(B.get('redGlow', x, z), PRIM.sphere, trs(x, y + h + 0.3, z, 0.4, 0.4, 0.4));
  }
  function pyramidRoof(mat, cx, y, cz, w, d, h) {
    const b = B.get(mat, cx, cz);
    const apex = V(cx, y + h, cz);
    const c = [V(cx - w / 2, y, cz - d / 2), V(cx + w / 2, y, cz - d / 2), V(cx + w / 2, y, cz + d / 2), V(cx - w / 2, y, cz + d / 2)];
    const f = FACADES[mat] || { tileW: 8, tileH: 8 };
    for (let i = 0; i < 4; i++) {
      const a = c[i], e = c[(i + 1) % 4];
      const mid = V((a.x + e.x) / 2 - cx, 0.3, (a.z + e.z) / 2 - cz);
      const len = a.distanceTo(e) / f.tileW, sl = Math.hypot(h, Math.max(w, d) / 2) / f.tileH;
      poly(b, [a, e, apex], [[0, 0], [len, 0], [len / 2, sl]], mid);
    }
  }

  function gableHouse(cx, cz, w, d, wallH, style, roofCol, ridgeAlongX) {
    const f = FACADES[style];
    walls(style, cx, SIDEWALK_TOP, cz, w, wallH, d, 0.4);
    const oh = 0.55, ph = R(2.2, 3.2);
    // 로컬 좌표 (a: 용마루 방향, b: 가로 방향)
    const A = ridgeAlongX ? w : d, Bh = (ridgeAlongX ? d : w) / 2;
    const map = (a, y, bb) => (ridgeAlongX ? V(cx + a, y, cz + bb) : V(cx + bb, y, cz + a));
    const top = SIDEWALK_TOP + wallH;
    const eaveY = top - ph * oh / (Bh + oh);
    const ridgeY = eaveY + ph;
    const rb = B.get('roofTile', cx, cz);
    const slope = Math.hypot(ph, Bh + oh) / 4, run = (A + 2 * oh) / 4;
    for (const s of [-1, 1]) {
      const p0 = map(-A / 2 - oh, eaveY, s * (Bh + oh)), p1 = map(A / 2 + oh, eaveY, s * (Bh + oh));
      const p2 = map(A / 2 + oh, ridgeY, 0), p3 = map(-A / 2 - oh, ridgeY, 0);
      const hint = ridgeAlongX ? V(0, 1, s) : V(s, 1, 0);
      poly(rb, [p0, p1, p2, p3], [[0, 0], [run, 0], [run, slope], [0, slope]], hint, roofCol);
    }
    const wb = B.get(style, cx, cz);
    for (const s of [-1, 1]) {
      const a0 = map(s * A / 2, top, -Bh), a1 = map(s * A / 2, top, Bh), ap = map(s * A / 2, ridgeY, 0);
      const hint = ridgeAlongX ? V(s, 0, 0) : V(0, 0, s);
      poly(wb, [a0, a1, ap], [[0, 0], [2 * Bh / f.tileW, 0], [Bh / f.tileW, (ridgeY - top) / f.tileH]], hint);
    }
    // 처마 밑면 막기용 천장
    hQuad(B.get('trim', cx, cz), cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2, top - 0.01, 3, WHITE, DOWN);
    if (rnd() < 0.4) {
      const off = R(-0.3, 0.3) * A;
      const p = map(off, 0, Bh * 0.4);
      solidBox(B.get('prop', p.x, p.z), p.x, top, p.z, 0.8, ph + 0.6, 0.8, 1, new THREE.Color(0x7b5a4a));
    }
  }

  // ── 차량(주차) ──
  const carColors = [0xf2f2f2, 0x1b1d20, 0x9aa1a8, 0x6b0f14, 0x1c3f7a, 0x2f3b30, 0xc9c1a8, 0x5c6168, 0xd9d9d9, 0x0e2a4a];
  function parkedCar(x, z, rotY, body) {
    const col = new THREE.Color(pick(carColors));
    const suv = rnd() < 0.3;
    const L = suv ? 4.8 : 4.5, W = 1.9, H = suv ? 0.95 : 0.75;
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const y = SIDEWALK_TOP;
    addGeo(B.get('carPaint', x, z), PRIM.box, trs(x, y + 0.35 + H / 2, z, W, H, L, rotY), col);
    const cabL = suv ? 3.0 : 2.4;
    let [px, pz] = at(0, suv ? 0.3 : 0.15);
    addGeo(B.get('carGlass', x, z), PRIM.box, trs(px, y + 0.35 + H + 0.33, pz, W * 0.86, 0.66, cabL, rotY));
    addGeo(B.get('carPaint', x, z), PRIM.box, trs(px, y + 0.35 + H + 0.68, pz, W * 0.8, 0.06, cabL * 0.92, rotY), col);
    for (const [lx, lz] of [[-0.85, 1.4], [0.85, 1.4], [-0.85, -1.4], [0.85, -1.4]]) {
      [px, pz] = at(lx, lz);
      addGeo(B.get('tire', x, z), PRIM.cyl, trs(px, y + 0.36, pz, 0.36, 0.25, 0.36, rotY).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)));
    }
    if (body) addBoxShape(body, x, GROUND_Y, z, Math.abs(c) * W + Math.abs(s) * L, 2.2, Math.abs(s) * W + Math.abs(c) * L);
  }

  // ── 블록 생성 ──
  const blocks = [];
  function districtOf(cx, cz) {
    const r = Math.hypot(cx, cz * 1.1) + (rnd() - 0.5) * 60;
    if (r < 250) return 'downtown';
    if (r < 470) return 'midtown';
    return 'residential';
  }

  for (let i = 0; i < XS.length - 1; i++) for (let j = 0; j < ZS.length - 1; j++) {
    const x0 = XS[i] + xW[i] / 2, x1 = XS[i + 1] - xW[i + 1] / 2;
    const z0 = ZS[j] + zW[j] / 2, z1 = ZS[j + 1] - zW[j + 1] / 2;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    if (inPark(cx, cz)) continue;
    let kind = districtOf(cx, cz);
    if (XS[i] === PLAZA.x0 && ZS[j] === PLAZA.z0) kind = 'plaza';
    blocks.push({ x0, x1, z0, z1, cx, cz, kind });
  }
  // 센트럴파크 (4개 블록 병합)
  {
    const i0 = XS.indexOf(PARK.x0), i1 = XS.indexOf(PARK.x1), j0 = ZS.indexOf(PARK.z0), j1 = ZS.indexOf(PARK.z1);
    const x0 = PARK.x0 + xW[i0] / 2, x1 = PARK.x1 - xW[i1] / 2, z0 = PARK.z0 + zW[j0] / 2, z1 = PARK.z1 - zW[j1] / 2;
    blocks.push({ x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, kind: 'park' });
  }
  // 주차장/소공원 몇 곳 지정
  for (const b of blocks) {
    if (b.kind === 'midtown' && rnd() < 0.07) b.kind = 'parking';
    else if (b.kind === 'residential' && rnd() < 0.08) b.kind = 'pocketpark';
  }


  function buildBlock(blk) {
    const { x0, x1, z0, z1, cx, cz } = blk;
    const body = staticBody(cx, cz);
    // 보도 슬래브
    addBoxShape(body, cx, GROUND_Y - 1, cz, x1 - x0, 1 + CURB_H, z1 - z0);
    hQuad(B.get('sidewalk', cx, cz), x0, z0, x1, z1, SIDEWALK_TOP, 4);
    boxSides(B.get('curb', cx, cz), cx, GROUND_Y, cz, x1 - x0, CURB_H, z1 - z0, 1, 1);
    const cb = B.get('curb', cx, cz);
    hQuad(cb, x0, z0, x1, z0 + 0.3, SIDEWALK_TOP + 0.004, 1);
    hQuad(cb, x0, z1 - 0.3, x1, z1, SIDEWALK_TOP + 0.004, 1);
    hQuad(cb, x0, z0 + 0.3, x0 + 0.3, z1 - 0.3, SIDEWALK_TOP + 0.004, 1);
    hQuad(cb, x1 - 0.3, z0 + 0.3, x1, z1 - 0.3, SIDEWALK_TOP + 0.004, 1);

    const SW = blk.kind === 'downtown' || blk.kind === 'plaza' ? 6 : blk.kind === 'residential' ? 4 : 5;
    blockFurniture(blk, body, SW);
    const inner = { x0: x0 + SW, x1: x1 - SW, z0: z0 + SW, z1: z1 - SW };

    if (blk.kind === 'park') buildPark(inner, body);
    else if (blk.kind === 'pocketpark') buildPocketPark(inner, body);
    else if (blk.kind === 'plaza') buildPlaza(inner, body);
    else if (blk.kind === 'parking') buildParking(inner, body);
    else for (const lot of subdivide(inner, blk.kind)) buildLot(lot, blk.kind, body);
    world.addBody(body);
  }

  function blockFurniture(blk, body, SW) {
    const { x0, x1, z0, z1, kind } = blk;
    const y = SIDEWALK_TOP;
    const edges = [
      { a: V(x0, 0, z0), b: V(x1, 0, z0), toRoad: NZ },
      { a: V(x1, 0, z1), b: V(x0, 0, z1), toRoad: PZ },
      { a: V(x0, 0, z1), b: V(x0, 0, z0), toRoad: NX },
      { a: V(x1, 0, z0), b: V(x1, 0, z1), toRoad: PX },
    ];
    const treeGap = kind === 'downtown' ? 16 : kind === 'residential' ? 11 : 13;
    for (const e of edges) {
      // 도시 외곽(순환도로 바깥)은 없음 — 블록은 모두 안쪽이므로 그대로 진행
      const len = e.a.distanceTo(e.b);
      const dir = V().subVectors(e.b, e.a).normalize();
      const inward = e.toRoad.clone().negate();
      const at = (t, off) => V(e.a.x + dir.x * t + inward.x * off, 0, e.a.z + dir.z * t + inward.z * off);
      const margin = 9;
      // 가로등 30m 간격
      for (let t = margin + 4; t < len - margin; t += 30) {
        const p = at(t, 0.8);
        streetLamp(p.x, p.z, e.toRoad, y, body);
      }
      // 가로수: 가로등 사이
      if (kind !== 'park' && kind !== 'plaza') {
        for (let t = margin + 4 + treeGap / 2; t < len - margin; t += treeGap) {
          if (((t - margin - 4) % 30) < 3 || ((t - margin - 4) % 30) > 27) continue;
          const p = at(t, 1.9);
          addGeo(B.get('trim', p.x, p.z), PRIM.box, trs(p.x, y + 0.004, p.z, 1.4, 0.01, 1.4), new THREE.Color(0x6a5e52));
          tree(p.x, p.z, y, body, 'street', kind === 'downtown' ? 0.9 : 1);
        }
      }
      if (rnd() < 0.5) { const p = at(R(12, len - 12), SW - 0.8); trashBin(p.x, p.z, y); }
      if (kind === 'downtown' && rnd() < 0.5) { const p = at(R(12, len - 12), SW - 0.9); bench(p.x, p.z, y, Math.atan2(e.toRoad.x, e.toRoad.z)); }
    }
    // 버스 정류장 (애비뉴/대로 접한 면)
    if (rnd() < 0.35 && kind !== 'park') {
      const e = pick(edges);
      const len = e.a.distanceTo(e.b);
      const dir = V().subVectors(e.b, e.a).normalize();
      const t = len * 0.5, inward = e.toRoad.clone().negate();
      busStop(e.a.x + dir.x * t + inward.x * 2.2, e.a.z + dir.z * t + inward.z * 2.2, y, e.toRoad, body);
    }
  }

  function subdivide(r, kind) {
    const W = r.x1 - r.x0, D = r.z1 - r.z0;
    if (W < 6 || D < 6) return [];
    const alongX = W >= D;
    const L = alongX ? W : D, depth = alongX ? D : W;
    const rows = depth > (kind === 'residential' ? 34 : 46) ? 2 : 1;
    const range = kind === 'downtown' ? [30, 56] : kind === 'midtown' ? [15, 30] : [14, 22];
    const lots = [];
    for (let row = 0; row < rows; row++) {
      const d0 = (depth / rows) * row, d1 = (depth / rows) * (row + 1);
      let pos = 0;
      while (pos < L - 1) {
        let w = R(range[0], range[1]);
        if (L - pos - w < range[0] * 0.75) w = L - pos;
        const a0 = pos, a1 = pos + w;
        const lot = alongX
          ? { x0: r.x0 + a0, x1: r.x0 + a1, z0: r.z0 + d0, z1: r.z0 + d1 }
          : { x0: r.x0 + d0, x1: r.x0 + d1, z0: r.z0 + a0, z1: r.z0 + a1 };
        // 도로를 향한 방향 (정면)
        lot.front = alongX ? (row === 0 ? NZ : PZ) : (row === 0 ? NX : PX);
        lot.rows = rows;
        lots.push(lot);
        pos = a1;
      }
    }
    return lots;
  }

  function insetLot(l, front, side, back) {
    // 정면(front 벡터 방향)은 front만큼, 반대편은 back, 좌우는 side만큼 들여쓰기
    const o = { x0: l.x0 + side, x1: l.x1 - side, z0: l.z0 + side, z1: l.z1 - side };
    if (l.front === NZ) { o.z0 = l.z0 + front; o.z1 = l.z1 - back; }
    if (l.front === PZ) { o.z1 = l.z1 - front; o.z0 = l.z0 + back; }
    if (l.front === NX) { o.x0 = l.x0 + front; o.x1 = l.x1 - back; }
    if (l.front === PX) { o.x1 = l.x1 - front; o.x0 = l.x0 + back; }
    if (l.rows === 1) {
      // 단일 열이면 뒤쪽도 도로에 면함
      if (l.front === NZ || l.front === PZ) { o.z0 = l.z0 + front; o.z1 = l.z1 - front; }
      else { o.x0 = l.x0 + front; o.x1 = l.x1 - front; }
    }
    return o;
  }

  function buildLot(lot, kind, body) {
    if (kind === 'downtown') tower(lot, body);
    else if (kind === 'midtown') midrise(lot, body);
    else residential(lot, body);
  }

  function rectInfo(r) { return { cx: (r.x0 + r.x1) / 2, cz: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0 }; }

  function tower(lot, body) {
    const f = insetLot(lot, R(0, 1.5), R(1, 3.5), R(1, 3));
    const { cx, cz, w, d } = rectInfo(f);
    if (w < 10 || d < 10) return;
    const dist = Math.hypot(cx, cz);
    const H = 55 + 190 * Math.max(0, 1 - dist / 270) ** 1.2 * R(0.45, 1.05) + R(0, 30);
    const style = pick(facadeNames.downtownAll);
    const podStyle = rnd() < 0.5 ? style : pick(['stone', 'office', 'officeDark', 'glassDark']);
    const y0 = SIDEWALK_TOP;
    const podiumH = 5 + (rnd() < 0.8 ? Math.floor(R(1, 4)) * 3.8 : 0);
    storefront(cx, y0, cz, w, d);
    if (podiumH > 5) walls(podStyle, cx, y0 + 5, cz, w, podiumH - 5, d, 0);
    roof(cx, y0 + podiumH, cz, w, d);
    parapet(cx, y0 + podiumH, cz, w, d, 1.0, 'trim', 0.3);
    addBoxShape(body, cx, GROUND_Y, cz, w, Math.min(H, 40), d);

    let inset = Math.min(w, d) > 26 ? R(2, Math.min(w, d) * 0.16) : 0;
    let tw = w - 2 * inset, td = d - 2 * inset;
    const tiers = rnd() < 0.45 ? (rnd() < 0.5 ? 2 : 3) : 1;
    const fracs = tiers === 1 ? [1] : tiers === 2 ? [0.68, 0.32] : [0.55, 0.28, 0.17];
    let y = y0 + podiumH;
    const remaining = H - podiumH;
    const uOff = (rnd() * 8) | 0;
    for (let t = 0; t < tiers; t++) {
      const th = remaining * fracs[t];
      walls(style, cx, y, cz, tw, th, td, y - y0, uOff);
      y += th;
      roof(cx, y, cz, tw, td);
      if (t < tiers - 1) { parapet(cx, y, cz, tw, td, 1.1, 'trimDark', 0.3); tw *= R(0.7, 0.85); td *= R(0.7, 0.85); }
    }
    const crown = rnd();
    if (crown < 0.22) {
      parapet(cx, y, cz, tw, td, 1.2, 'trimDark', 0.3);
      spire(cx, y, cz, R(18, 45));
      acUnits(cx, y, cz, tw, td, 3);
    } else if (crown < 0.42 && FACADES[style].kind === 'glass') {
      pyramidRoof(style, cx, y, cz, tw, td, Math.min(tw, td) * R(0.3, 0.55));
    } else if (crown < 0.75) {
      parapet(cx, y, cz, tw, td, 1.2, 'trimDark', 0.3);
      const mw = tw * R(0.35, 0.6), md = td * R(0.35, 0.6), mh = R(4, 8);
      walls(pick(['officeDark', 'glassDark']), cx, y, cz, mw, mh, md, 0);
      roof(cx, y + mh, cz, mw, md);
      acUnits(cx, y, cz, tw, td, 4);
    } else {
      parapet(cx, y, cz, tw, td, 1.2, 'trimDark', 0.3);
      // 헬리패드
      const hp = Math.min(tw, td) * 0.35;
      addGeo(B.get('trimDark', cx, cz), PRIM.cylHi, trs(cx, y + 0.3, cz, hp, 0.6, hp));
      addGeo(B.get('white', cx, cz), PRIM.box, trs(cx, y + 0.61, cz, hp * 0.9, 0.02, hp * 0.18));
      addGeo(B.get('white', cx, cz), PRIM.box, trs(cx - hp * 0.35, y + 0.61, cz, hp * 0.12, 0.02, hp * 0.9));
      addGeo(B.get('white', cx, cz), PRIM.box, trs(cx + hp * 0.35, y + 0.61, cz, hp * 0.12, 0.02, hp * 0.9));
    }
  }

  function midrise(lot, body) {
    const attached = rnd() < 0.6;
    const f = insetLot(lot, R(0, 0.8), attached ? 0.05 : R(1, 3), R(1, 4));
    const { cx, cz, w, d } = rectInfo(f);
    if (w < 7 || d < 7) return;
    const dist = Math.hypot(cx, cz);
    const style = pick(facadeNames.midtown);
    const spec = FACADES[style];
    const floors = Math.round(R(3, 14) * Math.max(0.45, 1.25 - dist / 520));
    const H = 5 + Math.max(2, floors) * spec.floor;
    const y0 = SIDEWALK_TOP;
    const shop = rnd() < 0.85;
    if (shop) storefront(cx, y0, cz, w, d); else walls(style, cx, y0, cz, w, 5, d, spec.floor - 5);
    walls(style, cx, y0 + 5, cz, w, H - 5, d, 0);
    const top = y0 + H;
    roof(cx, top, cz, w, d);
    if (spec.kind === 'brick' || spec.kind === 'stone') {
      parapet(cx, top - 0.2, cz, w + 0.8, d + 0.8, 1.1, 'trim', 0.7); // 돌출 코니스
      if (spec.kind === 'brick' && rnd() < 0.45) waterTank(cx + R(-0.25, 0.25) * w, top + 0.7, cz + R(-0.25, 0.25) * d);
    } else {
      parapet(cx, top, cz, w, d, 1.0, 'trim', 0.3);
    }
    acUnits(cx, top, cz, w, d, 1 + (rnd() * 4 | 0));
    if (rnd() < 0.5) {
      const bw = R(3, 5), bd = R(3, 5);
      solidBox(B.get('trim', cx, cz), cx + R(-0.2, 0.2) * w, top, cz + R(-0.2, 0.2) * d, bw, R(2.5, 3.5), bd, 2);
    }
    addBoxShape(body, cx, GROUND_Y, cz, w, Math.min(H, 30), d);
  }

  const roofCols = [0xa4553a, 0x4f555d, 0x6d4c3d, 0x8a3b2c, 0x3f4650];
  function residential(lot, body) {
    const L = rectInfo(lot);
    const isHouse = rnd() < (Math.hypot(L.cx, L.cz) > 560 ? 0.7 : 0.45);
    const y = SIDEWALK_TOP;
    if (isHouse) {
      hQuad(B.get('grass', L.cx, L.cz), lot.x0, lot.z0, lot.x1, lot.z1, y + 0.01, 8);
      const f = insetLot(lot, R(4.5, 6.5), R(1.8, 3), R(3, 6));
      const fi = rectInfo(f);
      const w = Math.min(fi.w, R(8, 12)), d = Math.min(fi.d, R(8, 11));
      if (w < 6 || d < 6) return;
      // 정면 쪽으로 붙인다
      let hx = fi.cx, hz = fi.cz;
      if (lot.front === NZ) hz = f.z0 + d / 2; if (lot.front === PZ) hz = f.z1 - d / 2;
      if (lot.front === NX) hx = f.x0 + w / 2; if (lot.front === PX) hx = f.x1 - w / 2;
      gableHouse(hx, hz, w, d, R(5.6, 6.4), pick(['stuccoWhite', 'stuccoWarm', 'stuccoWhite', 'brickBrown']),
        new THREE.Color(pick(roofCols)), rnd() < 0.5 ? w >= d : w < d);
      addBoxShape(body, hx, GROUND_Y, hz, w, 8, d);
      // 생울타리 (정면)
      const hedgeCol = new THREE.Color().setHSL(0.28, 0.45, 0.2);
      const fb = B.get('foliage', L.cx, L.cz);
      const along = lot.front === NZ || lot.front === PZ;
      const edge = lot.front === NZ ? lot.z0 + 0.6 : lot.front === PZ ? lot.z1 - 0.6 : lot.front === NX ? lot.x0 + 0.6 : lot.x1 - 0.6;
      const span = along ? L.w : L.d;
      const seg = (span - 2.5) / 2;
      for (const s of [-1, 1]) {
        const c = (seg / 2 + 1.25) * s;
        if (along) addGeo(fb, PRIM.box, trs(L.cx + c, y + 0.5, edge, seg, 1.0, 0.8), hedgeCol);
        else addGeo(fb, PRIM.box, trs(edge, y + 0.5, L.cz + c, 0.8, 1.0, seg), hedgeCol);
      }
      // 뒷마당 나무
      const back = lot.front.clone().negate();
      const tx = L.cx + back.x * (along ? 0 : L.w * 0.32) + (along ? R(-0.3, 0.3) * L.w : 0);
      const tz = L.cz + back.z * (along ? L.d * 0.32 : 0) + (along ? 0 : R(-0.3, 0.3) * L.d);
      if (rnd() < 0.8) tree(tx, tz, y, body, 'park', 0.8);
    } else {
      const f = insetLot(lot, R(2, 4), R(1.5, 3), R(2, 4));
      const { cx, cz, w, d } = rectInfo(f);
      if (w < 8 || d < 8) return;
      hQuad(B.get('grass', L.cx, L.cz), lot.x0, lot.z0, lot.x1, lot.z1, y + 0.01, 8);
      const style = pick(facadeNames.residential);
      const H = Math.round(R(3, 7)) * FACADES[style].floor + 0.8;
      walls(style, cx, y, cz, w, H, d, 0.8);
      roof(cx, y + H, cz, w, d);
      parapet(cx, y + H, cz, w, d, 0.9, 'trim', 0.3);
      acUnits(cx, y + H, cz, w, d, 2);
      addBoxShape(body, cx, GROUND_Y, cz, w, Math.min(H, 25), d);
    }
  }

  function buildPark(r, body) {
    const { cx, cz, w, d } = rectInfo(r);
    const y = SIDEWALK_TOP;
    hQuad(B.get('grass', cx, cz), r.x0, r.z0, r.x1, r.z1, y + 0.01, 10);
    // 호수
    const lake = { x: cx + w * 0.18, z: cz - d * 0.12, r: 26 };
    addGeo(B.get('water', lake.x, lake.z), new THREE.CircleGeometry(lake.r, 64).rotateX(-Math.PI / 2), trs(lake.x, y + 0.03, lake.z, 1, 1, 1));
    addGeo(B.get('curb', lake.x, lake.z), new THREE.TorusGeometry(lake.r, 0.45, 8, 72).rotateX(Math.PI / 2), trs(lake.x, y + 0.05, lake.z, 1, 0.6, 1));
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
      addBoxShape(body, lake.x + Math.cos(a) * lake.r, GROUND_Y, lake.z + Math.sin(a) * lake.r, 7, 5.6, 7, -a);
    }
    // 산책로: 외곽 루프 + 대각선
    const pathQuad = (x0, z0, x1, z1, wdt) => {
      const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(-(z1 - z0), x1 - x0);
      addGeo(B.get('path', x0, z0), PRIM.box, trs((x0 + x1) / 2, y + 0.02, (z0 + z1) / 2, len, 0.02, wdt, ang));
    };
    const m = 14;
    pathQuad(r.x0 + m, r.z0 + m, r.x1 - m, r.z0 + m, 4); pathQuad(r.x0 + m, r.z1 - m, r.x1 - m, r.z1 - m, 4);
    pathQuad(r.x0 + m, r.z0 + m, r.x0 + m, r.z1 - m, 4); pathQuad(r.x1 - m, r.z0 + m, r.x1 - m, r.z1 - m, 4);
    pathQuad(r.x0 + m, r.z1 - m, lake.x - lake.r * 0.8, lake.z + lake.r * 0.8, 3.5);
    pathQuad(r.x0 + m, r.z0 + m, cx - 10, cz, 3.5);
    pathQuad(cx - 10, cz, r.x1 - m, r.z1 - m, 3.5);
    // 원형 광장 + 분수
    fountain(cx - 10, cz, y, body, 7);
    // 나무 숲
    let placed = 0;
    for (let k = 0; k < 900 && placed < 170; k++) {
      const x = R(r.x0 + 4, r.x1 - 4), z = R(r.z0 + 4, r.z1 - 4);
      if (Math.hypot(x - lake.x, z - lake.z) < lake.r + 5) continue;
      if (Math.hypot(x - (cx - 10), z - cz) < 16) continue;
      const nearEdgePath = [x - (r.x0 + m), (r.x1 - m) - x, z - (r.z0 + m), (r.z1 - m) - z].some((v) => Math.abs(v) < 3.5);
      if (nearEdgePath) continue;
      if (rnd() < 0.25) conifer(x, z, y, body); else tree(x, z, y, body, 'park');
      placed++;
    }
    for (let t = 0; t < 1; t += 0.08) {
      const x = r.x0 + m + (r.x1 - r.x0 - 2 * m) * t;
      parkLamp(x, r.z0 + m + 2.6, y, body);
      bench(x + 4, r.z0 + m + 2.8, y, Math.PI);
      parkLamp(x, r.z1 - m - 2.6, y, body);
      bench(x + 4, r.z1 - m - 2.8, y, 0);
    }
  }

  function fountain(x, z, y, body, rad) {
    const stone = new THREE.Color(0xd9d2c3);
    addGeo(B.get('plaza', x, z), new THREE.CircleGeometry(rad + 6, 48).rotateX(-Math.PI / 2), trs(x, y + 0.025, z, 1, 1, 1));
    addGeo(B.get('prop', x, z), PRIM.cylHi, trs(x, y + 0.4, z, rad, 0.8, rad), stone);
    addGeo(B.get('water', x, z), new THREE.CircleGeometry(rad - 0.4, 48).rotateX(-Math.PI / 2), trs(x, y + 0.72, z, 1, 1, 1));
    addGeo(B.get('prop', x, z), PRIM.cylHi, trs(x, y + 1.6, z, 0.6, 2.4, 0.6), stone);
    addGeo(B.get('prop', x, z), PRIM.cylHi, trs(x, y + 2.9, z, 2.2, 0.3, 2.2), stone);
    addGeo(B.get('glassClear', x, z), PRIM.cone, trs(x, y + 3.9, z, 1.6, 1.8, 1.6));
    if (body) addBoxShape(body, x, GROUND_Y, z, rad * 1.6, 6, rad * 1.6);
  }

  function buildPocketPark(r, body) {
    const { cx, cz, w, d } = rectInfo(r);
    const y = SIDEWALK_TOP;
    hQuad(B.get('grass', cx, cz), r.x0, r.z0, r.x1, r.z1, y + 0.01, 10);
    addGeo(B.get('path', cx, cz), PRIM.box, trs(cx, y + 0.02, cz, w, 0.02, 3.5));
    addGeo(B.get('path', cx, cz), PRIM.box, trs(cx, y + 0.02, cz, 3.5, 0.02, d));
    for (let k = 0; k < 30; k++) {
      const x = R(r.x0 + 3, r.x1 - 3), z = R(r.z0 + 3, r.z1 - 3);
      if (Math.abs(x - cx) < 4 || Math.abs(z - cz) < 4) continue;
      tree(x, z, y, body, 'park');
    }
    // 놀이터 느낌의 소품
    for (const s of [-1, 1]) bench(cx + s * 6, cz + 3, y, 0);
    parkLamp(cx + 3, cz + 3, y, body); parkLamp(cx - 3, cz - 3, y, body);
  }

  function buildPlaza(r, body) {
    const { cx, cz, w, d } = rectInfo(r);
    const y = SIDEWALK_TOP;
    hQuad(B.get('plaza', cx, cz), r.x0, r.z0, r.x1, r.z1, y + 0.01, 6);
    // 시청: 광장의 뒤쪽(-z) 절반
    const hw = w * 0.7, hd = d * 0.34, hx = cx, hz = r.z0 + hd / 2 + 2;
    const hh = 18;
    // 기단
    solidBox(B.get('trim', hx, hz), hx, y, hz, hw + 6, 1.2, hd + 6, 3);
    walls('stone', hx, y + 1.2, hz, hw, hh, hd, 0);
    solidBox(B.get('trim', hx, hz), hx, y + 1.2 + hh, hz, hw + 1.2, 1.4, hd + 1.2, 3);
    roof(hx, y + 2.6 + hh, hz, hw + 1.2, hd + 1.2);
    // 열주 포르티코
    const pz = hz + hd / 2 + 3.5;
    solidBox(B.get('trim', hx, pz), hx, y + 1.2 + hh - 1.8, pz, hw * 0.5, 1.8, 7.5, 3);
    for (let k = -3; k <= 3; k++) {
      addGeo(B.get('trim', hx, pz), PRIM.cylHi, trs(hx + k * hw * 0.5 / 7, y + 1.2 + (hh - 1.8) / 2, pz + 2.8, 0.55, hh - 1.8, 0.55));
    }
    pyramidRoof('trim', hx, y + 1.2 + hh, pz, hw * 0.5, 7.5, 3.2);
    // 돔
    addGeo(B.get('trim', hx, hz), PRIM.cylHi, trs(hx, y + 2.6 + hh, hz, 7.5, 6, 7.5));
    addGeo(B.get('propMetal', hx, hz), PRIM.hemi, trs(hx, y + 8.6 + hh, hz, 7.8, 8, 7.8), new THREE.Color(0x5f8f84));
    spire(hx, y + 16.4 + hh, hz, 6);
    addBoxShape(body, hx, GROUND_Y, hz, hw + 6, 30, hd + 6);
    // 광장: 분수, 가로수 그리드, 국기봉
    fountain(cx, r.z1 - d * 0.28, y, body, 8);
    for (let ix = -2; ix <= 2; ix++) for (const s of [-1, 1]) {
      const x = cx + ix * w * 0.18, z = r.z1 - d * 0.28 + s * 15;
      if (Math.abs(ix) < 1 && s > 0) continue;
      tree(x, z, y, body, 'street', 0.95);
    }
    for (let k = -1; k <= 1; k++) {
      const x = cx + k * 5, z = hz + hd / 2 + 10;
      addGeo(B.get('propMetal', x, z), PRIM.cyl, trs(x, y + 7, z, 0.08, 14, 0.08), new THREE.Color(0xd0d4d8));
      addGeo(B.get('prop', x, z), PRIM.box, trs(x + 1.2, y + 12.5, z, 2.2, 1.4, 0.03), new THREE.Color([0xb22234, 0x1f4aa8, 0xf0f0f0][k + 1]));
    }
  }

  function buildParking(r, body) {
    const { cx, cz, w, d } = rectInfo(r);
    const y = SIDEWALK_TOP;
    const b = B.get('asphalt', cx, cz);
    hQuad(b, r.x0, r.z0, r.x1, r.z1, y + 0.01, 9);
    // 주차 칸: x 방향으로 열
    for (let z = r.z0 + 3; z + 5.5 < r.z1 - 3; z += 17) {
      for (const [rowZ, rot] of [[z + 2.7, 0], [z + 11.3, Math.PI]]) {
        if (rowZ + 3 > r.z1 - 3) continue;
        for (let x = r.x0 + 3; x + 2.8 < r.x1 - 3; x += 2.8) {
          hQuad(B.get('white', x, rowZ), x - 0.06, rowZ - 2.6, x + 0.06, rowZ + 2.6, y + 0.02, 1);
          if (rnd() < 0.62) parkedCar(x + 1.4, rowZ, rot, body);
        }
      }
    }
    // 관리 부스
    solidBox(B.get('trim', r.x0 + 4, r.z0 + 4), r.x0 + 4, y, r.z0 + 4, 3, 2.8, 3, 2);
  }

  // ── 실제 생성 (모든 헬퍼/상수 정의 이후에 실행) ──
  buildRoads();
  for (const blk of blocks) buildBlock(blk);

  // ── 교차로: 신호등 ──
  const intersections = nodes.filter((n) => n.exists);
  for (const n of intersections) {
    const legs = Object.keys(n.legs);
    if (legs.length < 3 && !(legs.length === 2 && ((n.legs.N && n.legs.S) || (n.legs.E && n.legs.W)))) {
      // 순환도로 모서리: 신호 없음
      n.signal = false;
      continue;
    }
    n.signal = true;
    // 교차로 네 모서리 중 해당 블록 Body를 찾기 어려우므로 모서리마다 소형 Body 사용
    const body = staticBody(n.x, n.z);
    for (const [k, D] of [['N', NZ], ['S', PZ], ['E', PX], ['W', NX]]) if (n.legs[k]) trafficSignal(n, D, body);
    world.addBody(body);
  }

  // ── 교외 숲 (순환도로 바깥) ──
  for (let c = 0; c < 70; c++) {
    const ang = R(0, Math.PI * 2), dist = R(EDGE + 40, 1250);
    const cx = Math.cos(ang) * dist, cz = Math.sin(ang) * dist;
    if (Math.abs(cx) < EDGE + 25 && Math.abs(cz) < EDGE + 25) continue;
    const n = 4 + (rnd() * 12 | 0);
    for (let k = 0; k < n; k++) {
      const x = cx + R(-30, 30), z = cz + R(-30, 30);
      if (Math.abs(x) < EDGE + 20 && Math.abs(z) < EDGE + 20) continue;
      if (rnd() < 0.4) conifer(x, z, GROUND_Y, null); else tree(x, z, GROUND_Y, null, 'park', 1.2);
    }
  }

  // ── 먼 산맥 (안개에 묻혀 대기 원근감을 준다) ──
  {
    const segA = 240, segR = 14;
    const pos = [], col = [], idx = [];
    const hn = mulberry32(5);
    const grid = new Float32Array(64 * 64).map(() => hn());
    const vnoise = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const at = (i, j) => grid[((i & 63) * 64) + (j & 63)];
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
    };
    const ridge = (x, y) => {
      let h = 0, amp = 1, f = 1;
      for (let o = 0; o < 5; o++) { h += amp * (1 - Math.abs(vnoise(x * f, y * f) * 2 - 1)); amp *= 0.5; f *= 2.1; }
      return h / 1.9;
    };
    for (let ir = 0; ir <= segR; ir++) {
      const t = ir / segR, rr = 1450 + t * 1900;
      for (let ia = 0; ia <= segA; ia++) {
        const a = (ia / segA) * Math.PI * 2;
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        const env = Math.min(1, t * 3) * (1 - t * 0.35);
        const h = ridge(x / 520 + 10, z / 520 + 10) ** 2.2 * 620 * env + t * 60;
        pos.push(x, GROUND_Y - 3 + h, z);
        const c = new THREE.Color().setHSL(0.3 + t * 0.12, 0.2 - t * 0.08, 0.2 + h / 3000 + t * 0.1);
        col.push(c.r, c.g, c.b);
      }
    }
    for (let ir = 0; ir < segR; ir++) for (let ia = 0; ia < segA; ia++) {
      const a = ir * (segA + 1) + ia, b = a + segA + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const hills = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, envMapIntensity: 0.3 }));
    hills.name = 'Mountains';
    root.add(hills);
  }

  // ── 버킷 → Mesh ──
  let tris = 0;
  const trisBy = {};
  for (const { name, b } of B.map.values()) {
    if (!b.n) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    g.setIndex(b.n > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
    g.computeBoundingSphere();
    const mat = M[name];
    if (!mat) { console.warn('city: 재질 없음', name); continue; }
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = SHADOW_CASTERS.has(name);
    mesh.receiveShadow = !name.startsWith('sig_') && name !== 'lampGlow' && name !== 'redGlow';
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);
    tris += b.idx.length / 3;
    trisBy[name] = (trisBy[name] || 0) + b.idx.length / 3;
  }
  const top = Object.entries(trisBy).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([n, t]) => `${n}:${(t / 1000).toFixed(0)}k`).join(' ');

  // ── 신호 주기 ──
  const CYCLE = 32;
  function signalState(axis, time) {
    const t = ((time % CYCLE) + CYCLE) % CYCLE;
    if (axis === 'ns') return t < 13 ? 'g' : t < 16 ? 'y' : 'r';
    return t >= 16 && t < 29 ? 'g' : t >= 29 ? 'y' : 'r';
  }
  const lampColor = { r: 0xff2a1a, y: 0xffb300, g: 0x19e37a };
  let lastState = '';
  function update(time) {
    const ns = signalState('ns', time), ew = signalState('ew', time);
    const key = ns + ew;
    if (key === lastState) return;
    lastState = key;
    for (const [axis, st] of [['ns', ns], ['ew', ew]]) {
      for (const c of ['r', 'y', 'g']) {
        const m = signalMats[axis][c], on = c === st;
        m.emissiveIntensity = on ? 3.2 : 0.04;
        m.color.setHex(on ? lampColor[c] : 0x1a1a1a);
      }
    }
  }
  update(0);

  console.log(`🏙️ 도시 생성: ${blocks.length}개 블록, ${segments.length}개 도로, ${(tris / 1000).toFixed(0)}k 삼각형, ${root.children.length} 메시, ${(performance.now() - t0).toFixed(0)}ms (상위: ${top})`);

  // 스폰: 대로(x=0) 우측 2차로, -z 방향
  const bl = ROAD_TYPES.boulevard;
  const spawn = { x: bl.median / 2 + bl.laneW * 1.5, z: 55, yaw: 0 };
  // 여러 플레이어가 같은 자리에 겹쳐 스폰되지 않도록 3개 차로 × 3열의 슬롯
  const spawnPoints = [];
  for (const zz of [55, 72, 89]) for (let k = 0; k < bl.lanes; k++) spawnPoints.push({ x: bl.median / 2 + bl.laneW * (k + 0.5), z: zz, yaw: 0 });

  return {
    root,
    update,
    signalState,
    spawn,
    spawnPoints,
    nodes: intersections,
    segments,
    blocks,
    bounds: EDGE,
    materials: M,
  };
}
