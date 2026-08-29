// markers.js — the QA map's marker shapes, in one place.
//
// Each issue layer is drawn in its own colour AND its own silhouette. The shape
// is not decoration: colour alone cannot separate seven categories for someone
// with a colour vision deficiency. Measured across several candidate palettes,
// every one left at least one pair of layers below the confusable threshold
// under deuteranopia (which affects roughly 1 in 12 men), because seven
// categorical hues is simply more than dichromatic vision can hold apart.
// Shape is the channel that survives all three common deficiencies intact, so
// the two run together: colour for grouping, shape for identity.
//
// Every shape is defined ONCE here as a unit-space path (centred on 0,0,
// radius 1) and rendered three ways from that single definition:
//   • map pins   — rasterised to an ImageData icon for a MapLibre symbol layer
//   • legend and work-list dots — inline SVG at small sizes
//   • the popup's outlet dots   — same SVG helper
// so a shape can never disagree between the map and the UI that explains it.

// Unit-space outlines, centred on the origin with an approximate radius of 1.
// `null` marks a shape drawn as a true circle (arc, not a polygon).
const PATHS = {
  circle: null,
  square: [[-0.88, -0.88], [0.88, -0.88], [0.88, 0.88], [-0.88, 0.88]],
  triangle: [[0, -1.12], [1.02, 0.72], [-1.02, 0.72]],
  diamond: [[0, -1.2], [1.2, 0], [0, 1.2], [-1.2, 0]],
  // Five-pointed star, generated rather than hand-listed so the points stay
  // exactly even; outer radius 1.25 keeps its visual weight near the others,
  // since a star encloses much less area than a square of the same radius.
  star: Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? 0.52 : 1.25;
    const a = -Math.PI / 2 + i * Math.PI / 5;
    return [r * Math.cos(a), r * Math.sin(a)];
  }),
  // A Greek cross. The arms run to 1.3 rather than 1 because a plus encloses
  // far less area than a square of the same radius, and would otherwise read
  // as the smallest marker on the map rather than a system-scale one.
  plus: (() => {
    const t = 0.44, o = 1.3;
    return [[-t,-o],[t,-o],[t,-t],[o,-t],[o,t],[t,t],[t,o],[-t,o],[-t,t],[-o,t],[-o,-t],[-t,-t]];
  })(),
  // An isosceles trapezoid, wide edge down. Distinct from the triangle at a
  // glance because the apex is cut flat, and from the square because the sides
  // rake — both differences survive at 4 px.
  trapezoid: [[-0.62, -0.86], [0.62, -0.86], [1.06, 0.82], [-1.06, 0.82]],
  // Point-down triangle. Reads as the mirror of Missing's point-up triangle,
  // which suits a layer that is about the same census data seen from the
  // system side rather than the branch side.
  triangleDown: [[0, 1.12], [-1.02, -0.72], [1.02, -0.72]]
};

// The two system-scale layers draw as outlines: they mark a whole system's
// area, not one building, and the hollow form says so at a glance.
const HOLLOW = {
  hollowSquare: 'square', hollowTriangle: 'triangle',
  hollowPlus: 'plus', hollowTrapezoid: 'trapezoid',
  hollowTriangleDown: 'triangleDown'
};

export const isHollow = shape => shape in HOLLOW;
const outlineOf = shape => PATHS[HOLLOW[shape] ?? shape] ?? null;

// ---- Canvas rasterisation (map icons) --------------------------------------

// MapLibre wants premultiplied RGBA pixels at the device's resolution. Icons
// are drawn once at the largest size any zoom uses and scaled down per zoom by
// icon-size, so a pin stays crisp when the map zooms in.
const ICON_R = 16;          // unit radius in px within the icon bitmap
const PAD = 6;              // room for the stroke and a ring

// Draw one marker into a canvas and hand back an ImageData for map.addImage().
// `ratio` is devicePixelRatio: the icon is rasterised at that density and
// registered with a matching pixelRatio, so it is sharp on HiDPI screens.
export function markerImage(shape, { fill, stroke, strokeWidth = 1.5, hollow = false, ratio = 1 }) {
  const size = Math.round((ICON_R + PAD) * 2 * ratio);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.scale(ratio, ratio);
  const mid = (ICON_R + PAD);

  ctx.beginPath();
  const pts = outlineOf(shape);
  if (!pts) {
    ctx.arc(mid, mid, ICON_R, 0, Math.PI * 2);
  } else {
    pts.forEach(([x, y], i) => {
      const px = mid + x * ICON_R, py = mid + y * ICON_R;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
  }
  ctx.lineJoin = 'round';
  // Hollow markers are a translucent wash with a solid outline in their own
  // colour; solid ones are opaque with a contrasting keyline.
  ctx.fillStyle = fill;
  ctx.globalAlpha = hollow ? 0.15 : 1;
  ctx.fill();
  ctx.globalAlpha = 1;
  if (strokeWidth > 0) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, size, size);
}

// ---- SVG (legend, work list, popups) ---------------------------------------

// The same outline as an inline <svg>, for the HTML that explains the map.
// `px` is the box size; the marker is drawn to fill it with room for the stroke.
export function markerSvg(shape, color, px = 12, { hollow = null, ring = null } = {}) {
  const isH = hollow ?? isHollow(shape);
  // Match the map icon's proportions exactly. markerImage draws at ICON_R = 16
  // unit radius with a 2 px hollow / 1.5 px solid outline, so the stroke is a
  // fixed fraction of the marker's own scale — reproduce that fraction here
  // instead of a fixed pixel width, which made a 12 px chip wear the same
  // outline as a 32 px icon and read as a much heavier shape.
  //
  // `unit` is this glyph's equivalent of ICON_R: the radius the unit-space path
  // is multiplied by. The stroke then lands at the same visual weight the pin
  // has on the map, at any size.
  const strokeAtIcon = isH ? 2 : 1.5;
  const sw0 = strokeAtIcon / ICON_R;          // stroke per unit of radius
  // Solve for the drawing radius so the shape plus half its stroke fills the
  // box: unit * (1 + sw0 / 2) = px / 2.
  const unit = (px / 2) / (1 + sw0 / 2);
  const sw = Math.max(0.6, unit * sw0) * (ring ? 1.8 : 1);
  const r = unit;
  const mid = px / 2;
  const pts = outlineOf(shape);
  const body = !pts
    ? `<circle cx="${mid}" cy="${mid}" r="${r}"`
    : `<polygon points="${pts.map(([x, y]) =>
        `${(mid + x * r).toFixed(2)},${(mid + y * r).toFixed(2)}`).join(' ')}" stroke-linejoin="round"`;
  const fill = isH
    ? `fill="${color}" fill-opacity="0.18" stroke="${color}"`
    : `fill="${color}" stroke="${ring || '#ffffff'}"`;
  return `<svg class="qm-mark" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" aria-hidden="true">` +
    `${body} ${fill} stroke-width="${sw.toFixed(2)}"/></svg>`;
}
