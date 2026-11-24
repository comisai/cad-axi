// Text as stored in a drawing, and as a person reads it (design §8.3):
// - MTEXT formatting codes are removed;
// - \U+XXXX escapes and %%c, %%d and %%p are decoded;
// - DOS Hebrew in legacy stroke text is decoded and put in reading order;
// - Hebrew typed on the Latin keys of the Israeli keyboard, for a Hebrew
//   stroke (SHX) font, is decoded when it reads as Hebrew, and marked so.
// The stored text is kept beside the decoded text. The style's backwards
// flag is reported separately.
//
// The keyboard and DOS Hebrew rules come from drawing-axi, where they were
// tuned on real plots.

/** `%%C`, `%%D`, `%%P`, `%%U`, `%%O`, `%%%` and `%%nnn`. */
export function controlCodes(raw: string): string {
  return raw.replace(/%%(\d{3}|[A-Za-z%])/g, (all, code: string) => {
    switch (code.toLowerCase()) {
      case 'c':
        return 'Ø';
      case 'd':
        return '°';
      case 'p':
        return '±';
      case 'u':
      case 'o':
      case 'k':
        return '';
      case '%':
        return '%';
      default: {
        const n = Number(code);
        return Number.isInteger(n) && n >= 32 && n < 256
          ? String.fromCharCode(n)
          : all;
      }
    }
  });
}

/** `\U+XXXX` escapes, as DXF and older DWG files write characters outside their code page. */
export function unicodeEscapes(raw: string): string {
  return raw.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_all, hex: string) => {
    const cp = Number.parseInt(hex, 16);
    return cp >= 0xd800 && cp <= 0xdfff ? '�' : String.fromCodePoint(cp);
  });
}

/**
 * MTEXT without its formatting codes: paragraph breaks become new lines,
 * stacked fractions become a/b, and font, height, colour and other switches
 * are dropped.
 */
export function mtextPlain(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (ch === '{' || ch === '}') continue;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const code = raw[i + 1];
    if (code === undefined) break;
    switch (code) {
      case '\\':
      case '{':
      case '}':
        out += code;
        i++;
        break;
      case 'P':
        out += '\n';
        i++;
        break;
      case 'X':
        out += '\n';
        i++;
        break;
      case '~':
        out += ' ';
        i++;
        break;
      case 'L':
      case 'l':
      case 'O':
      case 'o':
      case 'K':
      case 'k':
        i++;
        break;
      case 'U':
        // \U+XXXX is decoded later; keep it whole.
        out += '\\U';
        i++;
        break;
      case 'S': {
        // \Sa^b; \Sa/b; \Sa#b; : a stacked fraction.
        const end = raw.indexOf(';', i + 2);
        const body = end < 0 ? raw.slice(i + 2) : raw.slice(i + 2, end);
        out += body.replace(/[\^#]/, '/').replace(/^\s+|\s+$/g, '');
        i = end < 0 ? raw.length : end;
        break;
      }
      case 'f':
      case 'F':
      case 'H':
      case 'h':
      case 'W':
      case 'w':
      case 'Q':
      case 'q':
      case 'T':
      case 't':
      case 'A':
      case 'a':
      case 'C':
      case 'c':
      case 'p': {
        const end = raw.indexOf(';', i + 2);
        i = end < 0 ? raw.length : end;
        break;
      }
      default:
        out += ch;
        break;
    }
  }
  return out;
}

const KEYS = "qwertyuiopasdfghjkl;'zxcvbnm,./";
const HEBREW = "/'קראטוןםפשדגכעיחלךף,זסבהנמצתץ.";
const KEY_MAP = new Map<string, string>();
[...KEYS].forEach((k, i) => {
  KEY_MAP.set(k, [...HEBREW][i] as string);
});

const FINALS = new Set('ךםןףץ');
const isHebrew = (c: string | undefined): boolean =>
  c !== undefined && c >= 'א' && c <= 'ת';
const isLatin = (c: string | undefined): boolean =>
  c !== undefined && /[A-Za-z0-9]/.test(c);
const JOINERS = new Set('.,/\\:"\'%=+-_xXØ×°±#&*');
const MIRROR: Record<string, string> = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '<': '>',
  '>': '<',
  '{': '}',
  '}': '{',
};

/** Digits and Latin letters inside right-to-left text back in reading order. */
function orderRuns(chars: string[], preserveSizes = false): string[] {
  const out = [...chars];
  const inRun = new Array<boolean>(out.length).fill(false);
  let i = 0;
  while (i < out.length) {
    if (!isLatin(out[i])) {
      i++;
      continue;
    }
    let end = i;
    for (let j = i + 1; j < out.length; j++) {
      const c = out[j] as string;
      if (isLatin(c)) end = j;
      else if (!JOINERS.has(c)) break;
    }
    let start = i;
    if (
      (out[start - 1] === '"' || out[start - 1] === "'") &&
      (!isHebrew(out[start - 2]) || /\d/.test(out[start] ?? ''))
    )
      start--;
    const run = out.slice(start, end + 1);
    const orderedSize =
      preserveSizes &&
      /^\d+(?:[.,/]\d+)*$/.test(run.join('')) &&
      (run.includes('/') || out[end + 1] === '"' || out[end + 1] === "'");
    if (!orderedSize) run.reverse();
    for (let k = 0; k < run.length; k++) {
      out[start + k] = run[k] as string;
      inRun[start + k] = true;
    }
    i = end + 1;
  }
  return out.map((c, k) => (inRun[k] ? c : (MIRROR[c] ?? c)));
}

function keyed(text: string): string {
  return text.replace(
    /\d+(?:[.,/]\d+)*['"]?|['"]\d+(?:[.,/]\d+)*|./gsu,
    (part) => KEY_MAP.get(part) ?? part,
  );
}

/** Whether keyboard-mapped text reads as Hebrew. */
export function plausibleHebrew(mapped: string): boolean {
  if (/[@~^`|]|:\/\//.test(mapped)) return false;
  const chars = [...mapped];
  let letters = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (!isHebrew(c)) continue;
    letters++;
    if (FINALS.has(c) && (!isHebrew(chars[i - 1]) || isHebrew(chars[i + 1])))
      return false;
    if (/\d/.test(chars[i - 1] ?? '') && /\d/.test(chars[i + 1] ?? ''))
      return false;
  }
  if (letters >= 2) return /[א-ת]{2}/.test(mapped);
  return letters === 1 && /[א-ת]['".]/.test(mapped);
}

function keyboardHebrew(text: string): string {
  return orderRuns(readingUnits(keyed(normalizeSizes(text))), true)
    .join('')
    .replace(/(?<=[א-ת])''(?=[א-ת])/g, '"')
    .trim();
}

/** Font file names of Hebrew stroke fonts that take Latin keys. */
export function hebrewShx(font: string): boolean {
  return /heb|ivrit|isr|david|miriam|narkis|frank|aharoni/i.test(
    font.replace(/\.shx$/i, ''),
  );
}

// DOS Hebrew letters can be stored as the Windows rendering of bytes 0x80–0x9A.
// Unassigned Windows code-page slots survive as C1 controls in Unicode DWG text.
const DOS_GLYPHS = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š';
const DOS_MAP = new Map(
  [...DOS_GLYPHS].map((c, i) => [c, String.fromCharCode(0x05d0 + i)]),
);
// Windows-1255 leaves four more of these slots unassigned than Windows-1252.
for (const byte of [0x8a, 0x8c, 0x8e, 0x9a])
  DOS_MAP.set(
    String.fromCharCode(byte),
    String.fromCharCode(0x05d0 + byte - 0x80),
  );
const DOS_CLUE = /[ŠŒŽ˜š\u0081\u008a\u008c-\u0090\u009a]/u;

/** Signs that a stroke label contains DOS bytes carried through a Windows code page. */
export function hasDosGlyphs(text: string, knownStyle = false): boolean {
  if (
    /[א-ת]/u.test(text) ||
    !(DOS_CLUE.test(text) || (knownStyle && /[‚ƒ„†‡ˆ‰‹•™]/u.test(text)))
  )
    return false;
  const mapped = [...text].filter((c) => DOS_MAP.has(c)).length;
  return (
    mapped >= (knownStyle ? 2 : 3) &&
    (text.match(/[A-Za-z]/g)?.length ?? 0) <= mapped
  );
}

/** A final Hebrew letter belongs at the end of a word in reading order. */
function finalLetterOrder(chars: string[]): number {
  let score = 0;
  for (const [i, c] of chars.entries()) {
    if (FINALS.has(c))
      score += Number(isHebrew(chars[i - 1])) - Number(isHebrew(chars[i + 1]));
  }
  return score;
}

/** A leading inch or foot mark identifies a size stored backwards. */
function normalizeSizes(text: string): string {
  return text.replace(
    /(?<![\p{L}\p{N}])(['"])(\d+\/\d+ +\d+|\d+(?:[./]\d+)*)(?![\p{L}\p{N}./'"])/gu,
    (_, mark: string, size: string) => [...size].reverse().join('') + mark,
  );
}

// Some DOS drawings store a fraction backwards with its inch mark still
// at the end. Change it only when reversing turns an improper fraction
// into a proper one, a common notation for a fractional pipe size.
function normalizeDosFractions(text: string): string {
  return text.replace(
    /(?<![\d./"])(\d{1,4})\/(\d{1,4})(?=")/g,
    (fraction, numerator: string, denominator: string) => {
      if (Number(numerator) <= Number(denominator)) return fraction;
      const top = [...denominator].reverse().join('');
      const bottom = [...numerator].reverse().join('');
      return Number(top) > 0 && Number(top) < Number(bottom)
        ? `${top}/${bottom}`
        : fraction;
    },
  );
}

/** A mixed fraction is one unit when reordering right-to-left text. */
function readingUnits(text: string): string[] {
  return text.match(/\d+ +\d+\/\d+['"]?|./gsu) ?? [];
}

function dosLine(text: string): string {
  const sizes = normalizeSizes(text);
  // Some CAD files store Hebrew in reading order. When final forms give
  // us no direction, use the visual order of DOS stroke fonts.
  return finalLetterOrder([...sizes]) > 0
    ? sizes
    : orderRuns(readingUnits(normalizeDosFractions(sizes)).reverse()).join('');
}

export type DosMode = 'declared' | 'guess' | 'known-style' | 'known-drawing';
export type Decoded = 'keyboard' | 'dos-hebrew' | null;

export interface TextView {
  text: string;
  decoded: Decoded;
}

/**
 * Decode one stored string. `mtext` removes formatting codes; `keyboard`
 * says the drawing writes Hebrew on Latin keys in this text's style.
 */
export function decodeText(
  raw: string,
  mtext: boolean,
  keyboard: boolean,
  dos?: DosMode,
): TextView {
  let s = mtext ? mtextPlain(raw) : raw;
  s = unicodeEscapes(controlCodes(s));
  if (dos) {
    let decoded = false;
    s = s
      .split('\n')
      .map((line) => {
        if (dos === 'declared' && /[א-ת]/u.test(line)) {
          decoded = true;
          return dosLine(line);
        }
        if (dos !== 'declared' && hasDosGlyphs(line, dos === 'known-style')) {
          decoded = true;
          return dosLine([...line].map((c) => DOS_MAP.get(c) ?? c).join(''));
        }
        if (dos !== 'guess' && !/[א-ת]/u.test(line)) {
          const size = /^\s*['"]\d+(?:[./ ]\d+)*\s*$/.test(line)
            ? normalizeSizes(line)
            : normalizeDosFractions(line);
          if (size !== line) {
            decoded = true;
            return size;
          }
        }
        return line;
      })
      .join('\n');
    if (decoded) return { text: s.trim(), decoded: 'dos-hebrew' };
  }
  if (
    keyboard &&
    /[a-z]/.test(s) &&
    !/[א-ת]/u.test(s) &&
    !/^\s*[A-Za-z][A-Za-z0-9_]*\s*=\s*[+-]?\d/.test(s)
  ) {
    if (plausibleHebrew(keyed(s)))
      return { text: keyboardHebrew(s), decoded: 'keyboard' };
    const coded = /^(.*\S)\s*\)([A-Za-z]{1,3})\(\s*$/.exec(s.trim());
    if (coded && plausibleHebrew(keyed(coded[1] as string))) {
      const code = [...(coded[2] as string)].reverse().join('').toUpperCase();
      return {
        text: `${keyboardHebrew(coded[1] as string)} (${code})`,
        decoded: 'keyboard',
      };
    }
  }
  return { text: s.trim(), decoded: null };
}

/**
 * Which styles write Hebrew on Latin keys: an SHX style whose font is a
 * known Hebrew font, or whose longer texts mostly read as Hebrew once mapped.
 */
export function keyboardStyles(
  styles: ReadonlyArray<{ name: string; font: string; kind: string }>,
  samples: ReadonlyArray<{ style: string; raw: string }>,
): Set<string> {
  const out = new Set<string>();
  const tally = new Map<string, { n: number; hebrew: number }>();
  for (const s of samples) {
    const plain = unicodeEscapes(controlCodes(s.raw)).trim();
    if ((plain.match(/[a-z]/g)?.length ?? 0) < 4) continue;
    const t = tally.get(s.style) ?? { n: 0, hebrew: 0 };
    t.n++;
    if (plausibleHebrew(keyed(plain.replace(/\s*\)[A-Za-z]{1,3}\(\s*$/, ''))))
      t.hebrew++;
    tally.set(s.style, t);
  }
  for (const style of styles) {
    if (style.kind !== 'shx') continue;
    const t = tally.get(style.name);
    const voted = t !== undefined && t.n >= 3 && t.hebrew / t.n >= 0.6;
    const named =
      hebrewShx(style.font) &&
      (t === undefined || t.n === 0 || t.hebrew / t.n >= 0.5);
    if (voted || named) out.add(style.name);
  }
  return out;
}
