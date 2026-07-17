// Aurora borealis — additive scrolling curtain rendered on a huge curved
// band high above the terrain. Two-tone plasma driven by fbm noise.

// #VERTEX
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}

// #FRAGMENT
uniform float uTime;
uniform float uIntensity;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying vec2 vUv;

float ahash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float anoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = ahash(i), b = ahash(i + vec2(1.0, 0.0));
  float c = ahash(i + vec2(0.0, 1.0)), d = ahash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float afbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * anoise(p); p *= 2.13; a *= 0.5; }
  return s;
}

void main() {
  // Curtain ripples drift sideways over time.
  float x = vUv.x * 6.0 + afbm(vec2(vUv.x * 3.0, uTime * 0.05)) * 2.0;
  float wave = afbm(vec2(x, uTime * 0.11));
  // Vertical falloff: bright base, wispy top.
  float band = smoothstep(0.0, 0.15, vUv.y) * (1.0 - smoothstep(0.25, 1.0, vUv.y));
  float curtain = pow(wave, 2.2) * band;
  // Horizontal streaking.
  float streaks = 0.6 + 0.4 * anoise(vec2(vUv.x * 40.0, vUv.y * 3.0 - uTime * 0.07));
  curtain *= streaks;

  vec3 col = mix(uColorA, uColorB, vUv.y + wave * 0.35);
  float alpha = curtain * uIntensity;
  gl_FragColor = vec4(col * alpha * 1.8, alpha);
}
