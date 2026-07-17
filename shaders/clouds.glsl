// Volumetric-looking cloud billboards — fbm density on large camera-facing
// planes drifting high above the world.

// #VERTEX
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}

// #FRAGMENT
uniform float uTime;
uniform float uOpacity;
uniform vec3 uColor;
uniform float uSeed;
varying vec2 vUv;

float chash(vec2 p) {
  return fract(sin(dot(p, vec2(41.3, 289.1)) + uSeed) * 43758.5453);
}
float cnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(chash(i), chash(i + vec2(1, 0)), f.x),
             mix(chash(i + vec2(0, 1)), chash(i + vec2(1, 1)), f.x), f.y);
}
float cfbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * cnoise(p); p *= 2.07; a *= 0.5; }
  return s;
}

void main() {
  vec2 p = vUv * 3.0 + vec2(uTime * 0.008, 0.0);
  float d = cfbm(p);
  // Round the billboard edges off.
  vec2 c = vUv - 0.5;
  float mask = smoothstep(0.5, 0.18, length(c));
  float alpha = smoothstep(0.42, 0.72, d) * mask * uOpacity;
  gl_FragColor = vec4(uColor, alpha);
}
