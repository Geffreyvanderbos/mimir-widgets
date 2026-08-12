// Colour conversion for the /color widget. All of it is CSS Color 4 maths
// (https://www.w3.org/TR/css-color-4/), implemented here rather than pulled in
// from a library so the widget stays a single small module with no dependency
// and no CDN request (SKILL.md §8).
//
// The canonical form below is *unclamped* gamma-encoded sRGB. That matters:
// `oklch(0.9 0.4 150)` is a perfectly valid input that no sRGB hex can
// represent, and clamping at parse time would make the widget echo back an
// oklch() value the reader never typed. So nothing is clamped until the moment
// an sRGB-family string is serialised, and `inSrgbGamut` reports whether that
// serialisation lost anything.

export interface Color {
  /** Gamma-encoded sRGB, nominally 0–1 but deliberately allowed outside it. */
  r: number;
  g: number;
  b: number;
  alpha: number;
}

type Vec3 = [number, number, number];
type Matrix = [Vec3, Vec3, Vec3];

function multiply(m: Matrix, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

const LIN_SRGB_TO_XYZ_D65: Matrix = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
];

const XYZ_D65_TO_LIN_SRGB: Matrix = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];

const LIN_P3_TO_XYZ_D65: Matrix = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];

const XYZ_D65_TO_LIN_P3: Matrix = [
  [2.493496911941425, -0.9313836179191239, -0.40271078445071684],
  [-0.8294889695615747, 1.7626640603183463, 0.023624685841943577],
  [0.03584583024378447, -0.07617238926804182, 0.9568845240076872],
];

// CSS lab()/lch() are defined against D50, oklab()/oklch() against D65, so the
// Lab path needs a Bradford adaptation the OKLab path does not.
const XYZ_D65_TO_D50: Matrix = [
  [1.0479298208405488, 0.022946793341019088, -0.05019222954313557],
  [0.029627815688159344, 0.990434484573249, -0.01707382502938514],
  [-0.009243058152591178, 0.015055144896577895, 0.7518742899580008],
];

const XYZ_D50_TO_D65: Matrix = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
];

const D50_WHITE: Vec3 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

// The sRGB transfer function is applied to the magnitude and the sign put back,
// so a negative (out-of-gamut) component survives the round trip instead of
// collapsing to zero.
function toLinear(value: number): number {
  const magnitude = Math.abs(value);
  const linear =
    magnitude <= 0.04045 ? magnitude / 12.92 : ((magnitude + 0.055) / 1.055) ** 2.4;
  return Math.sign(value) * linear;
}

function toGamma(value: number): number {
  const magnitude = Math.abs(value);
  const encoded =
    magnitude <= 0.0031308 ? magnitude * 12.92 : 1.055 * magnitude ** (1 / 2.4) - 0.055;
  return Math.sign(value) * encoded;
}

function linearRgb(color: Color): Vec3 {
  return [toLinear(color.r), toLinear(color.g), toLinear(color.b)];
}

function fromLinearRgb([r, g, b]: Vec3, alpha: number): Color {
  return { r: toGamma(r), g: toGamma(g), b: toGamma(b), alpha };
}

function toXyz(color: Color): Vec3 {
  return multiply(LIN_SRGB_TO_XYZ_D65, linearRgb(color));
}

function fromXyz(xyz: Vec3, alpha: number): Color {
  return fromLinearRgb(multiply(XYZ_D65_TO_LIN_SRGB, xyz), alpha);
}

/* ---------------------------------------------------------------- OKLab --- */

const LMS_TO_OKLAB: Matrix = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];

const OKLAB_TO_LMS: Matrix = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548],
];

const LIN_SRGB_TO_LMS: Matrix = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];

const LMS_TO_LIN_SRGB: Matrix = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

export function toOklab(color: Color): Vec3 {
  const lms = multiply(LIN_SRGB_TO_LMS, linearRgb(color));
  return multiply(LMS_TO_OKLAB, [Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2])]);
}

function fromOklab(lab: Vec3, alpha: number): Color {
  const lms = multiply(OKLAB_TO_LMS, lab);
  return fromLinearRgb(
    multiply(LMS_TO_LIN_SRGB, [lms[0] ** 3, lms[1] ** 3, lms[2] ** 3]),
    alpha,
  );
}

/* ------------------------------------------------------------- CIE Lab --- */

function toLab(color: Color): Vec3 {
  const xyz = multiply(XYZ_D65_TO_D50, toXyz(color));
  const epsilon = 216 / 24389;
  const kappa = 24389 / 27;
  const [x, y, z] = xyz.map((value, i) => {
    const ratio = value / D50_WHITE[i];
    return ratio > epsilon ? Math.cbrt(ratio) : (kappa * ratio + 16) / 116;
  }) as Vec3;
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function fromLab([l, a, b]: Vec3, alpha: number): Color {
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const fy = (l + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const xyzD50: Vec3 = [
    (fx ** 3 > epsilon ? fx ** 3 : (116 * fx - 16) / kappa) * D50_WHITE[0],
    (l > kappa * epsilon ? ((l + 16) / 116) ** 3 : l / kappa) * D50_WHITE[1],
    (fz ** 3 > epsilon ? fz ** 3 : (116 * fz - 16) / kappa) * D50_WHITE[2],
  ];
  return fromXyz(multiply(XYZ_D50_TO_D65, xyzD50), alpha);
}

/* ------------------------------------------------- polar (LCH / OKLCH) --- */

function toPolar([l, a, b]: Vec3): Vec3 {
  const chroma = Math.sqrt(a * a + b * b);
  // An achromatic colour has no meaningful hue angle; atan2 would hand back
  // whatever rounding noise is left in a and b.
  const hue = chroma < 1e-6 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return [l, chroma, hue];
}

function fromPolar([l, c, h]: Vec3): Vec3 {
  const radians = (h * Math.PI) / 180;
  return [l, c * Math.cos(radians), c * Math.sin(radians)];
}

/* --------------------------------------------------------- Display P3 --- */

function toDisplayP3(color: Color): Vec3 {
  return multiply(XYZ_D65_TO_LIN_P3, toXyz(color)).map(toGamma) as Vec3;
}

function fromDisplayP3(rgb: Vec3, alpha: number): Color {
  return fromXyz(multiply(LIN_P3_TO_XYZ_D65, rgb.map(toLinear) as Vec3), alpha);
}

/* ------------------------------------------------------------- HSL/HWB --- */

function toHsl(color: Color): Vec3 {
  const [r, g, b] = [clamp01(color.r), clamp01(color.g), clamp01(color.b)];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, lightness * 100];

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return [((hue * 60) % 360 + 360) % 360, saturation * 100, lightness * 100];
}

function fromHsl([h, s, l]: Vec3, alpha: number): Color {
  const saturation = s / 100;
  const lightness = l / 100;
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = saturation * Math.min(lightness, 1 - lightness);
    return lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { r: channel(0), g: channel(8), b: channel(4), alpha };
}

function toHwb(color: Color): Vec3 {
  const [r, g, b] = [clamp01(color.r), clamp01(color.g), clamp01(color.b)];
  const [hue] = toHsl(color);
  return [hue, Math.min(r, g, b) * 100, (1 - Math.max(r, g, b)) * 100];
}

function fromHwb([h, w, b]: Vec3, alpha: number): Color {
  let white = w / 100;
  let black = b / 100;
  if (white + black >= 1) {
    const gray = white / (white + black);
    return { r: gray, g: gray, b: gray, alpha };
  }
  const base = fromHsl([h, 100, 50], alpha);
  const apply = (value: number) => value * (1 - white - black) + white;
  return { r: apply(base.r), g: apply(base.g), b: apply(base.b), alpha };
}

/* ---------------------------------------------------------------- gamut --- */

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const GAMUT_EPSILON = 1e-5;

export function inSrgbGamut(color: Color): boolean {
  return [color.r, color.g, color.b].every(
    (value) => value >= -GAMUT_EPSILON && value <= 1 + GAMUT_EPSILON,
  );
}

export function inP3Gamut(color: Color): boolean {
  return toDisplayP3(color).every(
    (value) => value >= -GAMUT_EPSILON && value <= 1 + GAMUT_EPSILON,
  );
}

/* --------------------------------------------------------------- named --- */

// The CSS named colours, needed in both directions: to parse `rebeccapurple`,
// and to name the nearest one for a colour the reader pasted as hex.
export const NAMED_COLORS: Record<string, string> = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4',
  azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000',
  blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a',
  burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e',
  coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
  cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b',
  darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b',
  darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00',
  darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f',
  darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f',
  darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493',
  deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff',
  firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff',
  gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520',
  gray: '808080', green: '008000', greenyellow: 'adff2f', grey: '808080',
  honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c', indigo: '4b0082',
  ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5',
  lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080',
  lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3',
  lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899',
  lightslategrey: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0',
  lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6', magenta: 'ff00ff',
  maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd',
  mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371',
  mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc',
  mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa',
  mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080',
  oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23', orange: 'ffa500',
  orangered: 'ff4500', orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98',
  paleturquoise: 'afeeee', palevioletred: 'db7093', papayawhip: 'ffefd5',
  peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd',
  powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000',
  rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072',
  sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d',
  silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090',
  slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4',
  tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347',
  turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff',
  whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
};

interface NamedMatch {
  name: string;
  exact: boolean;
}

// Converting all 148 named colours on every keystroke would be wasteful, and
// the table never changes.
let namedOklab: [string, Vec3][] | null = null;

export function nearestNamed(color: Color): NamedMatch {
  namedOklab ??= Object.entries(NAMED_COLORS).map(
    ([name, hex]) => [name, toOklab(hexToColor(hex, 1))] as [string, Vec3],
  );

  const target = toOklab(color);
  let best = '';
  let bestDistance = Infinity;
  for (const [name, candidate] of namedOklab) {
    const distance =
      (target[0] - candidate[0]) ** 2 +
      (target[1] - candidate[1]) ** 2 +
      (target[2] - candidate[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return { name: best, exact: bestDistance < 1e-8 };
}

/* --------------------------------------------------------------- parse --- */

function hexToColor(hex: string, alpha: number): Color {
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
    alpha,
  };
}

// `none` is a CSS Color 4 keyword meaning "this component is missing"; for a
// converter, carrying missing-ness through every space would be a lot of
// machinery to reproduce the one behaviour CSS itself defines as "treat as
// zero" when the colour is actually used.
function componentValue(token: string, percentBasis: number): number | null {
  if (token === 'none') return 0;
  if (token.endsWith('%')) {
    const percent = Number(token.slice(0, -1));
    return Number.isFinite(percent) ? (percent / 100) * percentBasis : null;
  }
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

function angleValue(token: string): number | null {
  if (token === 'none') return 0;
  const match = /^(-?[\d.]+(?:e-?\d+)?)(deg|grad|rad|turn)?$/i.exec(token);
  if (match === null) return null;
  const value = Number(match[1]);
  switch ((match[2] ?? 'deg').toLowerCase()) {
    case 'grad': return (value * 360) / 400;
    case 'rad': return (value * 180) / Math.PI;
    case 'turn': return value * 360;
    default: return value;
  }
}

interface FunctionCall {
  name: string;
  args: string[];
  alpha: number | null;
}

function parseFunction(input: string): FunctionCall | null {
  const match = /^([a-z0-9-]+)\((.*)\)$/is.exec(input.trim());
  if (match === null) return null;

  const [body, alphaPart] = match[2].split('/');
  const args = body.trim().split(/[\s,]+/).filter((token) => token !== '');
  let alpha: number | null = null;
  if (alphaPart !== undefined) {
    alpha = componentValue(alphaPart.trim(), 1);
    if (alpha === null) return null;
  }
  // Legacy comma syntax puts alpha in the argument list instead: rgba(r,g,b,a).
  if (alpha === null && /^(rgba?|hsla?)$/i.test(match[1]) && args.length === 4) {
    alpha = componentValue(args.pop()!, 1);
    if (alpha === null) return null;
  }
  return { name: match[1].toLowerCase(), args, alpha };
}

export function parseColor(input: string): Color | null {
  const text = input.trim().toLowerCase();
  if (text === '') return null;

  if (text === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 };
  const named = NAMED_COLORS[text];
  if (named !== undefined) return hexToColor(named, 1);

  const hex = /^#?([0-9a-f]{3,8})$/.exec(text);
  if (hex !== null) {
    const digits = hex[1];
    const expand = (short: string) => short.split('').map((c) => c + c).join('');
    if (digits.length === 3) return hexToColor(expand(digits), 1);
    if (digits.length === 4) {
      return hexToColor(expand(digits.slice(0, 3)), parseInt(expand(digits[3]), 16) / 255);
    }
    if (digits.length === 6) return hexToColor(digits, 1);
    if (digits.length === 8) {
      return hexToColor(digits.slice(0, 6), parseInt(digits.slice(6), 16) / 255);
    }
    return null;
  }

  const call = parseFunction(text);
  if (call === null) return null;
  const alpha = call.alpha ?? 1;
  const { name, args } = call;

  if (name === 'rgb' || name === 'rgba') {
    if (args.length !== 3) return null;
    // rgb() is the one function whose bare numbers aren't already in the unit
    // range the rest of this module works in — they're 0–255.
    const channels = args.map((token) => {
      const value = componentValue(token, 1);
      if (value === null) return null;
      return token.endsWith('%') || token === 'none' ? value : value / 255;
    });
    if (channels.some((value) => value === null)) return null;
    const [r, g, b] = channels as number[];
    return { r, g, b, alpha };
  }

  if (name === 'hsl' || name === 'hsla' || name === 'hwb') {
    if (args.length !== 3) return null;
    const hue = angleValue(args[0]);
    const first = componentValue(args[1], 100);
    const second = componentValue(args[2], 100);
    if (hue === null || first === null || second === null) return null;
    return name === 'hwb'
      ? fromHwb([hue, first, second], alpha)
      : fromHsl([hue, first, second], alpha);
  }

  if (name === 'lab' || name === 'oklab') {
    if (args.length !== 3) return null;
    const isOk = name === 'oklab';
    const lightness = componentValue(args[0], isOk ? 1 : 100);
    const a = componentValue(args[1], isOk ? 0.4 : 125);
    const b = componentValue(args[2], isOk ? 0.4 : 125);
    if (lightness === null || a === null || b === null) return null;
    return isOk ? fromOklab([lightness, a, b], alpha) : fromLab([lightness, a, b], alpha);
  }

  if (name === 'lch' || name === 'oklch') {
    if (args.length !== 3) return null;
    const isOk = name === 'oklch';
    const lightness = componentValue(args[0], isOk ? 1 : 100);
    const chroma = componentValue(args[1], isOk ? 0.4 : 150);
    const hue = angleValue(args[2]);
    if (lightness === null || chroma === null || hue === null) return null;
    const rectangular = fromPolar([lightness, chroma, hue]);
    return isOk ? fromOklab(rectangular, alpha) : fromLab(rectangular, alpha);
  }

  if (name === 'color') {
    if (args.length !== 4) return null;
    const space = args[0];
    const channels = args.slice(1).map((token) => componentValue(token, 1));
    if (channels.some((value) => value === null)) return null;
    const rgb = channels as Vec3;
    if (space === 'srgb') return { r: rgb[0], g: rgb[1], b: rgb[2], alpha };
    if (space === 'display-p3') return fromDisplayP3(rgb, alpha);
    if (space === 'srgb-linear') return fromLinearRgb(rgb, alpha);
    if (space === 'xyz' || space === 'xyz-d65') return fromXyz(rgb, alpha);
    if (space === 'xyz-d50') return fromXyz(multiply(XYZ_D50_TO_D65, rgb), alpha);
    return null;
  }

  return null;
}

/* -------------------------------------------------------------- format --- */

function round(value: number, places: number): string {
  // toFixed then strip: keeps 0.5 as "0.5" rather than "0.500", and avoids
  // "-0" for a component that rounds to zero from below.
  const fixed = Number(value.toFixed(places));
  return String(Object.is(fixed, -0) ? 0 : fixed);
}

function alphaSuffix(alpha: number, separator = ' / '): string {
  return alpha >= 1 ? '' : `${separator}${round(alpha, 4)}`;
}

export function formatHex(color: Color): string {
  const channel = (value: number) =>
    Math.round(clamp01(value) * 255).toString(16).padStart(2, '0');
  const base = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
  return color.alpha >= 1 ? base : `${base}${channel(color.alpha)}`;
}

export function formatRgb(color: Color): string {
  const channel = (value: number) => Math.round(clamp01(value) * 255);
  return `rgb(${channel(color.r)} ${channel(color.g)} ${channel(color.b)}${alphaSuffix(color.alpha)})`;
}

export function formatHsl(color: Color): string {
  const [h, s, l] = toHsl(color);
  return `hsl(${round(h, 2)} ${round(s, 2)}% ${round(l, 2)}%${alphaSuffix(color.alpha)})`;
}

export function formatHwb(color: Color): string {
  const [h, w, b] = toHwb(color);
  return `hwb(${round(h, 2)} ${round(w, 2)}% ${round(b, 2)}%${alphaSuffix(color.alpha)})`;
}

export function formatOklch(color: Color): string {
  const [l, c, h] = toPolar(toOklab(color));
  return `oklch(${round(l * 100, 3)}% ${round(c, 5)} ${round(h, 3)}${alphaSuffix(color.alpha)})`;
}

export function formatOklab(color: Color): string {
  const [l, a, b] = toOklab(color);
  return `oklab(${round(l, 5)} ${round(a, 5)} ${round(b, 5)}${alphaSuffix(color.alpha)})`;
}

export function formatLch(color: Color): string {
  const [l, c, h] = toPolar(toLab(color));
  return `lch(${round(l, 3)}% ${round(c, 3)} ${round(h, 3)}${alphaSuffix(color.alpha)})`;
}

export function formatLab(color: Color): string {
  const [l, a, b] = toLab(color);
  return `lab(${round(l, 3)}% ${round(a, 3)} ${round(b, 3)}${alphaSuffix(color.alpha)})`;
}

export function formatDisplayP3(color: Color): string {
  const [r, g, b] = toDisplayP3(color);
  return `color(display-p3 ${round(clamp01(r), 5)} ${round(clamp01(g), 5)} ${round(clamp01(b), 5)}${alphaSuffix(color.alpha)})`;
}

/** Relative luminance (WCAG), for picking readable ink to sit on a swatch. */
export function relativeLuminance(color: Color): number {
  const [r, g, b] = linearRgb({ ...color, r: clamp01(color.r), g: clamp01(color.g), b: clamp01(color.b) });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The sRGB colour actually shown, with out-of-gamut components clipped. */
export function clipToSrgb(color: Color): Color {
  return { r: clamp01(color.r), g: clamp01(color.g), b: clamp01(color.b), alpha: color.alpha };
}
