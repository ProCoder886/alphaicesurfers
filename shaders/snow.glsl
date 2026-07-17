// GPU snowfall — a static cloud of particles wrapped in a box around the
// camera; all motion (falling, wind drift, flutter) is computed in the
// vertex shader so the CPU cost is zero regardless of particle count.

// #VERTEX
attribute vec3 aSeed;     // per-particle random values in [0,1)
uniform float uTime;
uniform vec3 uCamPos;
uniform vec2 uWind;       // world-space wind XZ (m/s)
uniform float uRange;     // half-size of the wrap box
uniform float uFallSpeed;
uniform float uSize;
varying float vFade;

void main() {
  float range2 = uRange * 2.0;
  // Base position within the box, offset by fall + wind, wrapped around camera.
  vec3 p;
  float fall = uTime * uFallSpeed * (0.6 + aSeed.y * 0.8);
  p.x = aSeed.x * range2 + uWind.x * uTime * (0.5 + aSeed.z * 0.8);
  p.z = aSeed.z * range2 + uWind.y * uTime * (0.5 + aSeed.x * 0.8);
  p.y = aSeed.y * range2 - fall;
  // Sideways flutter.
  p.x += sin(uTime * (1.0 + aSeed.y * 2.0) + aSeed.x * 40.0) * 0.6;

  p.x = mod(p.x - uCamPos.x + uRange, range2) - uRange + uCamPos.x;
  p.y = mod(p.y - uCamPos.y + uRange, range2) - uRange + uCamPos.y;
  p.z = mod(p.z - uCamPos.z + uRange, range2) - uRange + uCamPos.z;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  vFade = smoothstep(uRange, uRange * 0.55, dist);
  gl_PointSize = uSize * (0.5 + aSeed.z) * (140.0 / max(dist, 1.0));
  gl_Position = projectionMatrix * mv;
}

// #FRAGMENT
uniform float uOpacity;
varying float vFade;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float alpha = smoothstep(0.5, 0.12, d) * uOpacity * vFade;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(0.95, 0.97, 1.0, alpha);
}
