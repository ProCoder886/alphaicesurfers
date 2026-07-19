// Terrain surface shader extensions, injected into MeshStandardMaterial
// via onBeforeCompile. Adds per-vertex surface data (aSurf: 0..1 iciness,
// >1.1 = frozen lake), varies PBR roughness/metalness across snow and ice,
// tints icy areas, and adds view-dependent glitter sparkle.

// #VERTEX_DECL
attribute float aSurf;
varying float vSurf;
varying vec3 vWorldPos2;

// #VERTEX_MAIN
vSurf = aSurf;
vWorldPos2 = (modelMatrix * vec4(transformed, 1.0)).xyz;

// #FRAG_DECL
varying float vSurf;
varying vec3 vWorldPos2;
uniform float uTime;
uniform vec3 uIceTint;
uniform vec3 uLakeTint;
uniform vec3 uSparkleColor;
float aisHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

// #FRAG_COLOR
{
  float icy = clamp(vSurf, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uIceTint, icy * 0.85);
  if (vSurf > 1.1) diffuseColor.rgb = mix(diffuseColor.rgb, uLakeTint, 0.7);
}

// #FRAG_NORMAL
{
  // Micro-bumped snow: cheap cell-noise normal perturbation gives the
  // surface a granular, wind-packed texture instead of flat shading.
  float icyN = clamp(vSurf, 0.0, 1.0);
  vec2 gp = vWorldPos2.xz * 2.4;
  float hh0 = aisHash(vec3(floor(gp), 7.0));
  float hh1 = aisHash(vec3(floor(gp + vec2(1.0, 0.0)), 7.0));
  float hh2 = aisHash(vec3(floor(gp + vec2(0.0, 1.0)), 7.0));
  vec3 bumpN = normalize(vec3(hh0 - hh1, 1.7, hh0 - hh2));
  normal = normalize(mix(normal, normalize(normal + bumpN * 0.6), (1.0 - icyN) * 0.4));
}

// #FRAG_ROUGHNESS
{
  float icy = clamp(vSurf, 0.0, 1.0);
  roughnessFactor = mix(roughnessFactor, 0.14, icy);
  if (vSurf > 1.1) roughnessFactor = 0.06;
}

// #FRAG_METALNESS
{
  float icy = clamp(vSurf, 0.0, 1.0);
  metalnessFactor = mix(metalnessFactor, 0.25, icy);
}

// #FRAG_EMISSIVE
{
  float icy = clamp(vSurf, 0.0, 1.0);
  vec3 vd = normalize(cameraPosition - vWorldPos2);
  float g = aisHash(floor(vWorldPos2 * 11.0) + floor(vd * 37.0));
  float sparkle = step(0.986, g) * (0.28 + icy * 0.85);
  totalEmissiveRadiance += uSparkleColor * sparkle;
}
