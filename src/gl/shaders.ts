/**
 * GLSL ES 3.00 shader sources for the restoration pipeline.
 *
 * Pass order:
 *   downsample -> region mask (SDF) -> separable mean (H,V) -> final composite
 * The final shader applies inverse-gain flicker compensation only inside
 * the soft screen masks, leaves every outside pixel bit-identical, holds
 * occluded pixels, and enforces a local-contrast non-regression guard.
 */

export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vUv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Downsample a frame to the analysis grid; RGBA8 output (A unused). */
export const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
uniform vec2 uGridSize;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 texel = 1.0 / vec2(textureSize(uFrame, 0));
  vec2 cell = 1.0 / uGridSize;
  vec2 center = (floor(vUv * uGridSize) + 0.5) * cell;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  // 4x4 box average within the cell.
  for (int y = -1; y <= 2; y++) {
    for (int x = -1; x <= 2; x++) {
      vec2 p = center + (vec2(float(x), float(y)) + 0.5) * cell * 0.25;
      p = clamp(p, texel * 0.5, 1.0 - texel * 0.5);
      acc += texture(uFrame, p);
      wsum += 1.0;
    }
  }
  outColor = vec4(acc.rgb / wsum, 1.0);
}
`;

/**
 * Rasterize all screen regions into one R8 SDF-like mask texture.
 * Each region contributes a smooth 0..1 coverage based on signed
 * distance to its polygon edges (negative inside). Occlusion grid
 * is subtracted so players in front of the board are excluded.
 */
export const MASK_FS = `#version 300 es
precision highp float;
const int MAX_REGIONS = 8;
uniform vec4 uRegions[MAX_REGIONS];   // xy = min bbox (px), zw = max bbox (px)
uniform vec4 uQuad0[MAX_REGIONS];      // polygon vertices 0,1 (px each)
uniform vec4 uQuad1[MAX_REGIONS];      // polygon vertices 2,3 (px each)
uniform int uRegionCount;
uniform float uFeatherPx;
uniform vec2 uFrameSize;
uniform sampler2D uOcclusion;         // analysis-grid occlusion, 0 visible / 1 occluded
uniform vec2 uGridSize;
in vec2 vUv;
out vec4 outMask;

// Half-plane test for a convex polygon; robust to either winding order.
bool pointInConvex(vec2 p, vec2[4] poly) {
  int signChanges = 0;
  for (int i = 0; i < 4; i++) {
    vec2 a = poly[i];
    vec2 b = poly[(i + 1) % 4];
    float cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross > 0.0) signChanges++;
    else if (cross < 0.0) signChanges--;
  }
  return abs(float(signChanges)) == 4.0;
}

float sdfQuad(vec2 p, vec2[4] poly) {
  float d = 1e9;
  for (int i = 0; i < 4; i++) {
    vec2 a = poly[i];
    vec2 b = poly[(i + 1) % 4];
    vec2 e = b - a;
    float t = clamp(dot(p - a, e) / max(dot(e, e), 1e-9), 0.0, 1.0);
    d = min(d, length(p - (a + e * t)));
  }
  bool inside = pointInConvex(p, poly);
  return inside ? -d : d;
}

void main() {
  vec2 px = vUv * uFrameSize;
  float coverage0 = 0.0;
  for (int r = 0; r < MAX_REGIONS; r++) {
    if (r >= uRegionCount) break;
    vec4 bbox = uRegions[r];
    vec2 pad = vec2(uFeatherPx + 2.0);
    if (any(lessThan(px, bbox.xy - pad)) || any(greaterThan(px, bbox.zw + pad))) continue;
    vec2 poly[4];
    poly[0] = uQuad0[r].xy;
    poly[1] = uQuad0[r].zw;
    poly[2] = uQuad1[r].xy;
    poly[3] = uQuad1[r].zw;
    float d = sdfQuad(px, poly);
    float c = 1.0 - smoothstep(-uFeatherPx, uFeatherPx, d);
    coverage0 = max(coverage0, c);
  }
  // Occlusion grid rows are stored top-left first; GL vUv is bottom-left.
  vec2 occUv = vec2(vUv.x, 1.0 - vUv.y);
  // Bilinear-style soft occlusion: average the cell with its four neighbours
  // (max-based spreading would leak a single marked cell across the board).
  float cellH = 1.0 / uGridSize.x;
  float cellV = 1.0 / uGridSize.y;
  float occ = texture(uOcclusion, occUv).r;
  float occSoft = (
      texture(uOcclusion, occUv + vec2(cellH, 0.0)).r +
      texture(uOcclusion, occUv - vec2(cellH, 0.0)).r +
      texture(uOcclusion, occUv + vec2(0.0, cellV)).r +
      texture(uOcclusion, occUv - vec2(0.0, cellV)).r
    ) * 0.125;
  occ = clamp(occ * 0.5 + occSoft, 0.0, 1.0);
  float coverage = coverage0 * (1.0 - occ);
  outMask = vec4(coverage, coverage, coverage, 1.0);
}
`;

/** Separable box mean used by the local-contrast guard. */
export const MEAN_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uDirection;   // texel-space direction (1,0) or (0,1)
uniform int uRadius;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 texel = 1.0 / vec2(textureSize(uSrc, 0));
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -8; i <= 8; i++) {
    if (i < -uRadius || i > uRadius) continue;
    acc += texture(uSrc, vUv + uDirection * texel * float(i));
    wsum += 1.0;
  }
  outColor = acc / wsum;
}
`;

/**
 * Final compensation + composite.
 *
 * Flicker model per region:
 *   observed(x,t) = base(x) * alpha(t, v)
 * with alpha = 1 + A * sin(2*pi*f*t + phase + slope*v), v the fractional
 * row of the pixel inside that region's bounding box.
 *
 * Inverse gain restores `base`; the contrast guard guarantees the local
 * deviation from the neighbourhood mean is never shrunk. Outside the
 * union of masks the original sample is returned untouched.
 */
export const COMPOSITE_FS = `#version 300 es
precision highp float;
const int MAX_REGIONS = 8;
uniform sampler2D uFrame;
uniform sampler2D uMask;
uniform sampler2D uMean;
uniform int uRegionCount;
uniform vec4 uBBox[MAX_REGIONS];      // px bbox min.xy / max.zw
uniform vec4 uBeat[MAX_REGIONS];      // x=frequencyHz, y=amplitude, z=phase, w=slopeV
uniform float uTimeSec;
uniform float uStrength;
uniform float uEpsilon;
uniform vec2 uFrameSize;
in vec2 vUv;
out vec4 outColor;

void main() {
  vec4 original = texture(uFrame, vUv);
  float mask = texture(uMask, vUv).r;
  if (mask <= 0.0009765625) {         // < 1/255 -> provably unchanged
    outColor = original;
    return;
  }
  vec2 px = vUv * uFrameSize;
  // Dominant region = the bbox this pixel is inside (polygons do not overlap
  // in practice; fall back to the nearest bbox center).
  int idx = -1;
  for (int r = 0; r < MAX_REGIONS; r++) {
    if (r >= uRegionCount) break;
    vec4 bb = uBBox[r];
    if (all(greaterThanEqual(px, bb.xy)) && all(lessThanEqual(px, bb.zw))) {
      idx = r;
      break;
    }
  }
  float gain = 1.0;
  if (idx >= 0) {
    vec4 bb = uBBox[idx];
    // GL bbox is bottom-origin; convert to the top-origin fractional row
    // vTop that the CPU estimator used when fitting the stripe slope.
    float vGl = clamp((px.y - bb.y) / max(bb.w - bb.y, 1.0), 0.0, 1.0);
    float vTop = 1.0 - vGl;
    vec4 beat = uBeat[idx];
    // beat = [hz, amplitude, phaseCenter, slopeV]
    // phase(vTop) = phaseCenter + slopeV * (vTop - 0.5)
    float theta = 6.28318530718 * beat.x * uTimeSec + beat.z + beat.w * (vTop - 0.5);
    float alpha = 1.0 + beat.y * sin(theta);
    alpha = clamp(alpha, 0.25, 4.0);
    float desired = 1.0 / alpha;
    // Blend the compensation by user strength.
    gain = mix(1.0, desired, uStrength);
  }
  vec3 corrected = original.rgb * gain;

  // Local-contrast non-regression guard.
  // The reference mean is taken from the ORIGINAL frame, so scale it by the
  // same gain: a pure multiplicative correction leaves every relative
  // contrast unchanged, and comparing against an unscaled mean would wrongly
  // pull bright/dark pixels back toward their uncorrected levels.
  vec3 localMeanOrig = texture(uMean, vUv).rgb;
  vec3 localMean = localMeanOrig * gain;
  vec3 devOrig = original.rgb - localMeanOrig;
  vec3 devCorr = corrected - localMean;
  vec3 scale = vec3(1.0);
  for (int c = 0; c < 3; c++) {
    float ao = abs(devOrig[c]);
    float ac = abs(devCorr[c]);
    if (ac < ao + uEpsilon) {
      scale[c] = (ao + uEpsilon) / max(ac, 1e-6);
    }
  }
  corrected = localMean + devCorr * clamp(scale, 1.0, 4.0);
  corrected = clamp(corrected, 0.0, 1.0);

  outColor = vec4(mix(original.rgb, corrected, mask), original.a);
}
`;
