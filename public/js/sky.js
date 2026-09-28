/**
 * sky.js — 그라디언트 하늘 + 태양 + 구름 셰이더, 그리고 PBR 반사용 환경맵
 * 지평선 색 = 안개 색으로 맞춰 먼 건물이 하늘에 자연스럽게 녹아들게 한다.
 */
import * as THREE from 'three';

export const SKY = {
  top: new THREE.Color(0x3b78c4),
  horizon: new THREE.Color(0xc3d6e6),
  ground: new THREE.Color(0x8d9687),
  sunDir: new THREE.Vector3(-0.5, 0.92, 0.42).normalize(),
};

function skyMaterial(clouds) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: SKY.top },
      horizon: { value: SKY.horizon },
      ground: { value: SKY.ground },
      sunDir: { value: SKY.sunDir },
      clouds: { value: clouds ? 1 : 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vDir = wp.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * wp;
        gl_Position.z = gl_Position.w; // 항상 가장 먼 곳
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 top, horizon, ground, sunDir;
      uniform float clouds;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = h > 0.0 ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(horizon, ground, clamp(-h * 6.0, 0.0, 1.0));
        float s = max(dot(d, sunDir), 0.0);
        col += vec3(1.0, 0.92, 0.75) * (pow(s, 900.0) * 6.0 + pow(s, 24.0) * 0.28 + pow(s, 4.0) * 0.08);
        if (clouds > 0.5 && h > 0.0) {
          vec2 uv = d.xz / (h + 0.12) * 1.6;
          float c = smoothstep(0.52, 0.82, fbm(uv + vec2(3.0, 1.0)));
          float lit = 0.8 + 0.2 * pow(s, 3.0);
          col = mix(col, vec3(1.0) * lit, c * smoothstep(0.0, 0.25, h) * 0.85);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <encodings_fragment>
      }`,
  });
}

export function createSky(scene, renderer) {
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMaterial(true));
  sky.scale.setScalar(2000);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  // 환경맵: 구름 없는 하늘 + 지면 반구
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMaterial(false));
  envSky.scale.setScalar(50);
  envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(envScene, 0.02);
  pmrem.dispose();
  scene.environment = envTarget.texture;

  return {
    mesh: sky,
    envMap: envTarget.texture,
    fogColor: SKY.horizon.clone(),
    sunDir: SKY.sunDir.clone(),
    follow(camera) { sky.position.copy(camera.position); },
  };
}
