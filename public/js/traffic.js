/**
 * traffic.js — 도로망 위를 달리는 AI 차량
 *
 *  - 차선 추종: 세그먼트(교차로 사이 구간) + 차로 번호 + 진행 거리 u로 위치를 표현
 *  - 교차로: 직진/우회전 위주로 선택(좌회전은 다른 길이 없을 때만)하고 2차 베지어로 회전
 *  - 신호 준수: 적색/황색이면 정지선 앞에서 정지(황색에 이미 늦었으면 통과)
 *  - 차간 거리: 진행 방향 앞쪽의 AI 차량·플레이어를 감지해 감속
 *  - 물리: 키네마틱 바디로 플레이어 차량과 충돌한다
 * 각 클라이언트가 독립적으로 시뮬레이션한다(멀티플레이 동기화 대상 아님).
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GROUND_Y } from './city.js';

const CROSS_STOP = 5.3;   // 세그먼트 끝에서 정지선까지 거리
const ACCEL = 2.6, DECEL = 4.5, HARD_DECEL = 9;

const DIRS = { N: new THREE.Vector3(0, 0, -1), S: new THREE.Vector3(0, 0, 1), E: new THREE.Vector3(1, 0, 0), W: new THREE.Vector3(-1, 0, 0) };
const keyOf = (v) => (Math.abs(v.z) > 0.5 ? (v.z < 0 ? 'N' : 'S') : (v.x > 0 ? 'E' : 'W'));

// ─── 차량 지오메트리 ───────────────────────────────────────────────
function part(geo, x, y, z, rx = 0, rz = 0) {
  const g = geo.clone();
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}
const RB = (w, h, d, r = 0.15) => new RoundedBoxGeometry(w, h, d, 2, r);
const BOX = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const WHEEL = (r, w) => new THREE.CylinderGeometry(r, r, w, 16);

function carShape({ L, W, H, cabinH, cabinL, cabinZ, wheelR = 0.36, box = false }) {
  const bodyY = wheelR * 0.85 + H / 2;
  const paint = [part(RB(W, H, L, 0.2), 0, bodyY, 0)];
  const glass = [];
  const dark = [];
  const top = bodyY + H / 2;
  if (box) {
    // 박스형(트럭/버스): 캐빈이 차체와 같은 폭
    glass.push(part(BOX(W * 1.002, cabinH * 0.55, cabinL), 0, top - cabinH * 0.35, cabinZ));
  } else {
    glass.push(part(RB(W * 0.84, cabinH, cabinL, 0.14), 0, top + cabinH / 2 - 0.05, cabinZ));
    paint.push(part(RB(W * 0.8, 0.08, cabinL * 0.9, 0.03), 0, top + cabinH - 0.05, cabinZ));
  }
  dark.push(part(BOX(W * 1.01, 0.24, 0.22), 0, wheelR * 0.9, L / 2 - 0.08));
  dark.push(part(BOX(W * 1.01, 0.24, 0.22), 0, wheelR * 0.9, -L / 2 + 0.08));
  const wz = L / 2 - Math.max(0.9, L * 0.18);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    dark.push(part(WHEEL(wheelR, 0.28), sx * (W / 2 - 0.12), wheelR, sz * wz, 0, Math.PI / 2));
  }
  if (L > 8) for (const sx of [-1, 1]) dark.push(part(WHEEL(wheelR, 0.28), sx * (W / 2 - 0.12), wheelR, -wz + 1.4, 0, Math.PI / 2));
  const head = [], tail = [];
  for (const sx of [-1, 1]) {
    head.push(part(BOX(0.42, 0.13, 0.06), sx * (W / 2 - 0.32), bodyY + H * 0.2, L / 2 + 0.01));
    tail.push(part(BOX(0.46, 0.12, 0.06), sx * (W / 2 - 0.3), bodyY + H * 0.25, -L / 2 - 0.01));
  }
  return {
    L, W,
    parts: {
      paint: mergeGeometries(paint),
      glass: mergeGeometries(glass),
      dark: mergeGeometries(dark),
      head: mergeGeometries(head),
      tail: mergeGeometries(tail),
    },
  };
}

const TYPES = {
  sedan: { weight: 44, shape: () => carShape({ L: 4.6, W: 1.9, H: 0.72, cabinH: 0.62, cabinL: 2.4, cabinZ: -0.2 }), colors: [0xf2f2f2, 0x1b1d20, 0x9aa1a8, 0x6b0f14, 0x1c3f7a, 0x5c6168, 0xd9d9d9, 0x0e2a4a, 0x2e4d3a] },
  suv:   { weight: 26, shape: () => carShape({ L: 4.9, W: 2.0, H: 0.95, cabinH: 0.72, cabinL: 3.0, cabinZ: -0.35, wheelR: 0.42 }), colors: [0x1b1d20, 0xf2f2f2, 0x3b4148, 0x7a7f86, 0x2a2f45, 0x5a3b2a] },
  taxi:  { weight: 12, shape: () => carShape({ L: 4.7, W: 1.9, H: 0.72, cabinH: 0.62, cabinL: 2.4, cabinZ: -0.2 }), colors: [0xf2b705], sign: true },
  van:   { weight: 10, shape: () => carShape({ L: 6.4, W: 2.25, H: 2.4, cabinH: 1.2, cabinL: 1.6, cabinZ: 2.2, wheelR: 0.45, box: true }), colors: [0xf4f4f4, 0xe8e8e8, 0x274a8a, 0xb21e1e] },
  bus:   { weight: 5, shape: () => carShape({ L: 11.5, W: 2.55, H: 2.7, cabinH: 1.6, cabinL: 11.2, cabinZ: 0, wheelR: 0.5, box: true }), colors: [0x1f6fb2, 0x2b8a3e, 0xc92a2a] },
};

// ─── 교통 시스템 ───────────────────────────────────────────────────
export function createTraffic({ scene, world, city, count = 70, avoid }) {
  const rnd = Math.random;
  const mats = {
    paint: new THREE.MeshStandardMaterial({ roughness: 0.28, metalness: 0.55 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.08, metalness: 0.75 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x191a1b, roughness: 0.8 }),
    head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dd, emissiveIntensity: 1.2 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 0.9 }),
  };

  // 유형별 InstancedMesh 준비
  const typeNames = Object.keys(TYPES);
  const totalW = typeNames.reduce((s, n) => s + TYPES[n].weight, 0);
  const assigned = [];
  for (let i = 0; i < count; i++) {
    let r = rnd() * totalW, t = typeNames[0];
    for (const n of typeNames) { r -= TYPES[n].weight; if (r <= 0) { t = n; break; } }
    assigned.push(t);
  }
  const groups = {};
  for (const name of typeNames) {
    const n = assigned.filter((t) => t === name).length;
    if (!n) continue;
    const shape = TYPES[name].shape();
    const meshes = {};
    for (const [p, geo] of Object.entries(shape.parts)) {
      const m = new THREE.InstancedMesh(geo, mats[p], n);
      m.castShadow = p !== 'head' && p !== 'tail';
      m.receiveShadow = p === 'paint';
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
      meshes[p] = m;
    }
    if (TYPES[name].sign) {
      const sg = part(BOX(0.7, 0.22, 0.25), 0, 0.36 * 0.85 + 0.72 + 0.62 + 0.1, -0.2);
      const m = new THREE.InstancedMesh(sg, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe9a0, emissiveIntensity: 0.6 }), n);
      m.frustumCulled = false;
      scene.add(m);
      meshes.sign = m;
    }
    groups[name] = { shape, meshes, used: 0 };
  }

  // 레인 기하
  function laneOffset(seg, dir, k) {
    const d = seg.def;
    const mag = d.median / 2 + d.laneW * (k + 0.5);
    // 진행 방향 오른쪽 부호: z축 도로 → -dir, x축 도로 → +dir
    return (seg.axis === 'z' ? -dir : dir) * mag;
  }
  function lanePos(seg, dir, k, u, out) {
    const s = (dir > 0 ? seg.s0 : seg.s1) + dir * u;
    const off = laneOffset(seg, dir, k);
    return seg.axis === 'z' ? out.set(seg.p + off, 0, s) : out.set(s, 0, seg.p + off);
  }
  function heading(seg, dir, out) { return seg.axis === 'z' ? out.set(0, 0, dir) : out.set(dir, 0, 0); }

  const cars = [];
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();

  function spawnCar(typeName, id) {
    const g = groups[typeName];
    const colors = TYPES[typeName].colors;
    for (let attempt = 0; attempt < 60; attempt++) {
      const seg = city.segments[(rnd() * city.segments.length) | 0];
      if (typeName === 'bus' && seg.type === 'street') continue;
      if (seg.len < 30) continue;
      const dir = rnd() < 0.5 ? 1 : -1;
      const k = (rnd() * seg.def.lanes) | 0;
      const u = 8 + rnd() * (seg.len - 20);
      const pos = lanePos(seg, dir, k, u, new THREE.Vector3());
      if (avoid && pos.distanceTo(avoid) < 45) continue;
      if (cars.some((c) => c.pos.distanceTo(pos) < 16)) continue;
      const L = g.shape.L;
      const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
      body.addShape(new CANNON.Box(new CANNON.Vec3(g.shape.W / 2, 0.8, L / 2)));
      body.collisionFilterGroup = 2;
      body.collisionFilterMask = 1;
      world.addBody(body);
      const car = {
        id, type: typeName, idx: g.used++, seg, dir, k, u, mode: 'lane', turn: null,
        speed: 0, pos, h: heading(seg, dir, new THREE.Vector3()), halfL: L / 2,
        body, drive: 0.85 + rnd() * 0.25, committed: false, leader: null, stuck: 0,
      };
      const col = new THREE.Color(colors[(rnd() * colors.length) | 0]);
      g.meshes.paint.setColorAt(car.idx, col);
      cars.push(car);
      return;
    }
  }
  assigned.forEach((t, i) => spawnCar(t, i));
  for (const g of Object.values(groups)) {
    if (g.meshes.paint.instanceColor) g.meshes.paint.instanceColor.needsUpdate = true;
    for (const m of Object.values(g.meshes)) m.count = g.used;
  }

  function arrivalNode(car) { return car.dir > 0 ? car.seg.b : car.seg.a; }

  function planTurn(car) {
    const node = arrivalNode(car);
    const h = car.h;
    const back = keyOf(tmpA.copy(h).negate());
    const right = new THREE.Vector3(-h.z, 0, h.x);
    const opts = [];
    for (const [key, seg] of Object.entries(node.legs)) {
      if (key === back) continue;
      const h2 = DIRS[key];
      const kind = h2.dot(h) > 0.5 ? 'straight' : h2.dot(right) > 0.5 ? 'right' : 'left';
      if (car.type === 'bus' && seg.type === 'street' && opts.length) continue;
      opts.push({ key, seg, h2, kind, w: kind === 'straight' ? 0.6 : kind === 'right' ? 0.4 : 0.02 });
    }
    // 좌회전은 다른 선택지가 없을 때만
    const noLeft = opts.filter((o) => o.kind !== 'left');
    const pool = noLeft.length ? noLeft : opts;
    let r = rnd() * pool.reduce((s, o) => s + o.w, 0);
    let o = pool[0];
    for (const c of pool) { r -= c.w; if (r <= 0) { o = c; break; } }
    const seg2 = o.seg;
    const dir2 = seg2.axis === 'z' ? o.h2.z : o.h2.x;
    const lanes2 = seg2.def.lanes;
    const k2 = o.kind === 'straight' ? Math.min(car.k, lanes2 - 1) : o.kind === 'right' ? lanes2 - 1 : 0;
    const p0 = lanePos(car.seg, car.dir, car.k, car.seg.len, new THREE.Vector3());
    const p3 = lanePos(seg2, dir2, k2, 0, new THREE.Vector3());
    const ctrl = o.kind === 'straight'
      ? p0.clone().lerp(p3, 0.5)
      : p0.clone().addScaledVector(h, tmpB.subVectors(p3, p0).dot(h));
    // 호 길이 근사
    let len = 0; const prev = p0.clone();
    for (let i = 1; i <= 10; i++) { bez(p0, ctrl, p3, i / 10, tmpC); len += tmpC.distanceTo(prev); prev.copy(tmpC); }
    return { p0, ctrl, p3, len, kind: o.kind, next: { seg: seg2, dir: dir2, k: k2 } };
  }
  function bez(a, c, b, t, out) {
    const it = 1 - t;
    return out.set(it * it * a.x + 2 * it * t * c.x + t * t * b.x, 0, it * it * a.z + 2 * it * t * c.z + t * t * b.z);
  }

  const obstacles = [];
  let time = 0;
  const q = new THREE.Quaternion(), m4 = new THREE.Matrix4(), scl = new THREE.Vector3(1, 1, 1), p4 = new THREE.Vector3();
  const UPV = new THREE.Vector3(0, 1, 0);

  function update(dt, simTime, others = []) {
    time = simTime;
    dt = Math.min(dt, 0.1);
    obstacles.length = 0;
    for (const o of others) obstacles.push(o);

    for (const car of cars) {
      // 목표 속도
      let vmax = car.seg.def.speed * car.drive;
      if (car.mode === 'turn') vmax = car.turn.kind === 'straight' ? vmax : 7;

      // 신호
      if (car.mode === 'lane') {
        const node = arrivalNode(car);
        const distToEnd = car.seg.len - car.u;
        // 회전 예정이면 미리 감속
        if (distToEnd < 30) vmax = Math.min(vmax, 7 + distToEnd * 0.45);
        if (node.signal) {
          const st = city.signalState(car.seg.axis === 'z' ? 'ns' : 'ew', time);
          const distToStop = car.seg.len - CROSS_STOP - car.halfL - car.u;
          if (st === 'g') car.committed = false;
          else if (distToStop > -0.5 && !car.committed) {
            const brakeDist = (car.speed * car.speed) / (2 * DECEL);
            if (st === 'y' && distToStop < brakeDist * 0.8) car.committed = true;
            else vmax = Math.min(vmax, Math.sqrt(2 * DECEL * Math.max(0, distToStop - 0.4)));
          }
        }
      }

      // 선행 차량/플레이어
      const h = car.h, rx = -h.z, rz = h.x;
      car.leader = null;
      let limit = Infinity;
      const consider = (px, pz, halfL, ref) => {
        const dx = px - car.pos.x, dz = pz - car.pos.z;
        const d = dx * h.x + dz * h.z;
        if (d <= 0 || d > 45) return;
        const lat = Math.abs(dx * rx + dz * rz);
        if (lat > 2.4) return;
        const gap = d - car.halfL - halfL - 2.2;
        const v = Math.sqrt(2 * DECEL * Math.max(0, gap));
        if (v < limit) { limit = v; car.leader = ref; }
      };
      for (const o of cars) {
        if (o === car) continue;
        if (Math.abs(o.pos.x - car.pos.x) > 46 || Math.abs(o.pos.z - car.pos.z) > 46) continue;
        if (o.h.dot(h) < -0.3) continue; // 마주 오는 차
        if (o.leader === car && o.id < car.id) continue; // 교착 방지
        consider(o.pos.x, o.pos.z, o.halfL, o);
      }
      for (const o of obstacles) consider(o.x, o.z, 2.6, null);
      vmax = Math.min(vmax, limit);

      // 속도 적분
      if (car.speed < vmax) car.speed = Math.min(vmax, car.speed + ACCEL * dt);
      else car.speed = Math.max(vmax, car.speed - (vmax < car.speed - 4 ? HARD_DECEL : DECEL) * dt);
      car.speed = Math.max(0, car.speed);

      // 전진
      const step = car.speed * dt;
      if (car.mode === 'lane') {
        car.u += step;
        if (car.u >= car.seg.len) {
          car.turn = planTurn(car);
          car.turn.t = car.u - car.seg.len;
          car.mode = 'turn';
        } else {
          lanePos(car.seg, car.dir, car.k, car.u, car.pos);
        }
      } else {
        car.turn.t += step;
      }
      if (car.mode === 'turn') {
        const tr = car.turn;
        if (tr.t >= tr.len) {
          Object.assign(car, tr.next);
          car.u = tr.t - tr.len;
          car.mode = 'lane';
          car.turn = null;
          car.committed = false;
          heading(car.seg, car.dir, car.h);
          lanePos(car.seg, car.dir, car.k, car.u, car.pos);
        } else {
          const t = tr.t / tr.len;
          bez(tr.p0, tr.ctrl, tr.p3, t, car.pos);
          bez(tr.p0, tr.ctrl, tr.p3, Math.min(1, t + 0.02), tmpA);
          tmpA.sub(car.pos);
          if (tmpA.lengthSq() > 1e-6) car.h.copy(tmpA.normalize());
        }
      }

      // 물리/렌더 반영
      const yaw = Math.atan2(car.h.x, car.h.z);
      q.setFromAxisAngle(UPV, yaw);
      car.body.position.set(car.pos.x, GROUND_Y + 0.9, car.pos.z);
      car.body.quaternion.set(q.x, q.y, q.z, q.w);
      car.body.velocity.set(car.h.x * car.speed, 0, car.h.z * car.speed);
      const g = groups[car.type];
      m4.compose(p4.set(car.pos.x, GROUND_Y, car.pos.z), q, scl);
      for (const m of Object.values(g.meshes)) m.setMatrixAt(car.idx, m4);
    }
    for (const g of Object.values(groups)) for (const m of Object.values(g.meshes)) m.instanceMatrix.needsUpdate = true;
  }

  return { update, cars };
}
