// Text as stored in a drawing, and as a person reads it (design §8.3):
// - MTEXT formatting codes are removed;
// - \U+XXXX escapes and %%c, %%d and %%p are decoded;
// - Hebrew typed on the Latin keys of the Israeli keyboard, for a Hebrew
//   stroke (SHX) font, is decoded when it reads as Hebrew, and marked so.
// The stored text is always kept beside it, unchanged. Text is never
// reversed on the strength of a style's backwards flag: that is reported.
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
function orderRuns(chars: string[]): string[] {
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
      !isHebrew(out[start - 2])
    )
      start--;
    const run = out.slice(start, end + 1).reverse();
    for (let k = 0; k < run.length; k++) {
      out[start + k] = run[k] as string;
      inRun[start + k] = true;
    }
    i = end + 1;
  }
  return out.map((c, k) => (inRun[k] ? c : (MIRROR[c] ?? c)));
}

function keyed(text: string): string {
  return [...text].map((c) => KEY_MAP.get(c) ?? c).join('');
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
  if (letters >= 2) return true;
  return letters === 1 && /[א-ת]['".]/.test(mapped);
}

function keyboardHebrew(text: string): string {
  return orderRuns([...keyed(text)])
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

export type Decoded = 'keyboard' | null;

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
): TextView {
  let s = mtext ? mtextPlain(raw) : raw;
  s = unicodeEscapes(controlCodes(s));
  if (keyboard && /[a-z]/.test(s)) {
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
