// Colour math for the contrast checks: parses the colour syntaxes the product
// CSS uses (hex, rgb(), oklch()), composites translucent fills over a ground
// and computes WCAG 2 contrast ratios.

/** @typedef {{ r: number, g: number, b: number, a: number }} Rgba sRGB channels 0..1 */

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function linearToSrgb(channel) {
  const c = clamp01(channel);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function parseNumber(token, percentScale = 1) {
  const text = token.trim();
  if (text.endsWith("%")) return (Number.parseFloat(text) / 100) * percentScale;
  return Number.parseFloat(text);
}

function oklchToRgb(l, c, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  return {
    r: linearToSrgb(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    g: linearToSrgb(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    b: linearToSrgb(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  };
}

/**
 * Parses a CSS colour value. Returns null for anything it cannot evaluate
 * statically (var(), color-mix(), keywords other than black/white/transparent).
 * @returns {Rgba | null}
 */
export function parseColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (text === "black") return { r: 0, g: 0, b: 0, a: 1 };
  if (text === "white") return { r: 1, g: 1, b: 1, a: 1 };
  let match = /^#([0-9a-f]{3,8})$/.exec(text);
  if (match) {
    let hex = match[1];
    if (hex.length === 3 || hex.length === 4) {
      hex = [...hex].map((ch) => ch + ch).join("");
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    const channel = (i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return { r: channel(0), g: channel(2), b: channel(4), a: hex.length === 8 ? channel(6) : 1 };
  }
  match = /^rgba?\(([^)]+)\)$/.exec(text);
  if (match) {
    const [channels, alpha] = match[1].split("/");
    const parts = channels.includes(",") ? channels.split(",") : channels.trim().split(/\s+/);
    const values = parts.map((part) => part.trim()).filter(Boolean);
    const rgb = values.slice(0, 3).map((part) => parseNumber(part, 255) / 255);
    const a = alpha !== undefined ? parseNumber(alpha) : values[3] !== undefined ? parseNumber(values[3]) : 1;
    return { r: rgb[0], g: rgb[1], b: rgb[2], a };
  }
  match = /^oklch\(([^)]+)\)$/.exec(text);
  if (match) {
    const [channels, alpha] = match[1].split("/");
    const [l, c, h] = channels.trim().split(/\s+/);
    const rgb = oklchToRgb(parseNumber(l), parseNumber(c), parseNumber(h));
    return { ...rgb, a: alpha !== undefined ? parseNumber(alpha) : 1 };
  }
  return null;
}

/** Paints `top` (possibly translucent) over an opaque `ground`, in sRGB space as browsers do. */
export function composite(top, ground) {
  const a = top.a;
  return {
    r: top.r * a + ground.r * (1 - a),
    g: top.g * a + ground.g * (1 - a),
    b: top.b * a + ground.b * (1 - a),
    a: 1,
  };
}

export function withAlpha(color, alpha) {
  return { ...color, a: color.a * alpha };
}

export function relativeLuminance(color) {
  return (
    0.2126 * srgbToLinear(color.r) +
    0.7152 * srgbToLinear(color.g) +
    0.0722 * srgbToLinear(color.b)
  );
}

/** WCAG 2 contrast ratio of two opaque colours. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function toHex(color) {
  const channel = (value) =>
    Math.round(clamp01(value) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** Ratio rounded down to two decimals, so 4.499 never reads as a pass. */
export function formatRatio(ratio) {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
}
