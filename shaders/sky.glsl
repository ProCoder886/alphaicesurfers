// Procedural gradient sky with sun disc, atmospheric horizon glow and
// hash-based starfield that fades in at night. Rendered on an inverted
// sphere that follows the camera. Sections are parsed by AssetManager.

// #VERTEX
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_Position.z = gl_Position.w; // pin to far plane
}

// #FRAGMENT
uniform vec3 uTopColor;
uniform vec3 uHorizonColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uNight;   // 0 = day, 1 = deep night
uniform float uTime;
varying vec3 vDir;

float hash13(vec3 p) {
  p = fract(p * 443.8975);
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 dir = normalize(vDir);
  float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);

  // Base vertical gradient with a soft horizon band.
  float horizonBand = pow(1.0 - abs(dir.y), 3.0);
  vec3 col = mix(uHorizonColor, uTopColor, pow(h, 0.62));
  col += uHorizonColor * horizonBand * 0.35;

  // Sun disc + bloom halo.
  float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
  col += uSunColor * (pow(sunDot, 900.0) * 3.0 + pow(sunDot, 24.0) * 0.35 + pow(sunDot, 5.0) * 0.12);

  // Night: darken and reveal stars.
  vec3 nightCol = col * mix(1.0, 0.32, uNight);

  // Crescent moon: a bright disc with an offset shadow disc bitten out,
  // plus a soft halo. Faint by day, luminous at night.
  vec3 md = normalize(uMoonDir);
  float moonDot = max(dot(dir, md), 0.0);
  float disc = smoothstep(0.99988, 0.99996, moonDot);
  vec3 biteDir = normalize(md + vec3(0.010, 0.006, 0.0));
  float bite = smoothstep(0.99982, 0.99994, max(dot(dir, biteDir), 0.0));
  float crescent = clamp(disc - bite * 0.92, 0.0, 1.0);
  float halo = pow(moonDot, 600.0) * 0.35;
  nightCol += vec3(0.93, 0.95, 1.0) * (crescent * 1.7 + halo) * (0.25 + 0.75 * uNight);

  if (uNight > 0.02 && dir.y > -0.05) {
    vec3 cell = floor(dir * 240.0);
    float star = hash13(cell);
    float twinkle = 0.6 + 0.4 * sin(uTime * (1.0 + hash13(cell + 7.0) * 4.0) + hash13(cell + 3.0) * 40.0);
    float s = step(0.9975, star) * twinkle * smoothstep(0.0, 0.25, dir.y);
    nightCol += vec3(0.9, 0.95, 1.0) * s * uNight * 1.6;
  }

  gl_FragColor = vec4(nightCol, 1.0);
}
