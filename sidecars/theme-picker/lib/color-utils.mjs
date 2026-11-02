// Small, dependency-free color helpers used for theme mapping, previews and
// "distinct theme" selection.

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Returns true for #rgb, #rgba, #rrggbb and #rrggbbaa strings. */
export function isHexColor(value) {
  return typeof value === 'string' && HEX_RE.test(value.trim());
}

/** Parses a hex color into {r,g,b,a} with r/g/b in 0..255 and a in 0..1. */
export function parseHex(value) {
  if (!isHexColor(value)) return null;
  let h = value.trim().slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

const to2 = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');

/** Formats {r,g,b,a} as #rrggbb (or #rrggbbaa when translucent). */
export function toHex({ r, g, b, a = 1 }) {
  const base = `#${to2(r)}${to2(g)}${to2(b)}`;
  return a >= 0.999 ? base : base + to2(a * 255);
}

/** Normalizes any supported hex string to lowercase #rrggbb / #rrggbbaa. */
export function normalizeHex(value) {
  const c = parseHex(value);
  return c ? toHex(c) : null;
}

/** Alpha-composites `fg` over an opaque `bg`. Returns opaque #rrggbb. */
export function composite(fg, bg) {
  const f = typeof fg === 'string' ? parseHex(fg) : fg;
  const b = typeof bg === 'string' ? parseHex(bg) : bg;
  if (!f) return b ? toHex({ ...b, a: 1 }) : null;
  if (!b || f.a >= 0.999) return toHex({ ...f, a: 1 });
  const a = f.a;
  return toHex({ r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a), a: 1 });
}

/** Linear interpolation between two colors (t = 0 → a, t = 1 → b). */
export function mix(a, b, t) {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x) return b;
  if (!y) return a;
  return toHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
    a: x.a + (y.a - x.a) * t,
  });
}

/** Returns the color with a new alpha (0..1). */
export function withAlpha(value, alpha) {
  const c = parseHex(value);
  return c ? toHex({ ...c, a: alpha }) : value;
}

function channel(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance(value) {
  const c = typeof value === 'string' ? parseHex(value) : value;
  if (!c) return 0;
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG contrast ratio between two opaque colors (1..21). */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDark(value) {
  return luminance(value) < 0.18;
}

/**
 * Picks a foreground for `bg`: `preferred` when it is readable enough,
 * otherwise whichever of near-white / near-black contrasts more.
 */
export function readableOn(bg, preferred, minRatio = 4.5) {
  if (preferred && parseHex(preferred) && contrast(composite(preferred, bg), bg) >= minRatio) return preferred;
  const light = '#f8f8f2';
  const dark = '#1b1b1b';
  return contrast(light, bg) >= contrast(dark, bg) ? light : dark;
}

/** Converts an opaque hex color to CIE L*a*b* (D65). */
export function toLab(value) {
  const c = parseHex(value);
  if (!c) return [0, 0, 0];
  const [r, g, b] = [c.r, c.g, c.b].map(channel);
  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 color difference; ~2.3 is a just-noticeable difference. */
export function deltaE(a, b) {
  const [l1, a1, b1] = Array.isArray(a) ? a : toLab(a);
  const [l2, a2, b2] = Array.isArray(b) ? b : toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Chroma (colorfulness) in Lab space, useful to find a theme's accent. */
export function chroma(value) {
  const [, a, b] = toLab(value);
  return Math.hypot(a, b);
}
