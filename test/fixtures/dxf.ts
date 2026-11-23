// A small DXF writer for tests: AC1015 (R2000) ASCII DXF with handles, so
// readers that build the object graph from handles read it as AutoCAD
// writes it. It is independent of the engine: tests draw their own files
// with chosen answers, and the engine must read them.
//
// It writes only what the tests need: layers, linetypes, text styles, blocks
// with attribute definitions, external reference blocks, and the entities
// LINE, LWPOLYLINE, ARC, CIRCLE, ELLIPSE, SPLINE, POINT, TEXT, MTEXT and
// INSERT with attributes, in model space, paper space or a block.

export type Xyz = [number, number, number] | [number, number];

export type Ent =
  | {
      kind: 'LINE';
      layer: string;
      from: Xyz;
      to: Xyz;
      linetype?: string;
      color?: number;
    }
  | {
      kind: 'LWPOLYLINE';
      layer: string;
      pts: Array<[number, number]>;
      bulges?: number[];
      closed?: boolean;
      normal?: Xyz;
      linetype?: string;
      color?: number;
    }
  | {
      kind: 'ARC';
      layer: string;
      center: Xyz;
      radius: number;
      /** Degrees, counter-clockwise. */
      start: number;
      end: number;
      normal?: Xyz;
      color?: number;
    }
  | {
      kind: 'CIRCLE';
      layer: string;
      center: Xyz;
      radius: number;
      color?: number;
    }
  | {
      kind: 'ELLIPSE';
      layer: string;
      center: Xyz;
      major: Xyz;
      ratio: number;
      t0?: number;
      t1?: number;
    }
  | {
      kind: 'SPLINE';
      layer: string;
      degree: number;
      knots: number[];
      ctrl: Xyz[];
    }
  | { kind: 'POINT'; layer: string; at: Xyz }
  | {
      kind: 'TEXT';
      layer: string;
      at: Xyz;
      height: number;
      value: string;
      style?: string;
      /** Degrees. */
      rotation?: number;
      backwards?: boolean;
    }
  | {
      kind: 'MTEXT';
      layer: string;
      at: Xyz;
      height: number;
      value: string;
      style?: string;
      width?: number;
    }
  | {
      kind: 'INSERT';
      layer: string;
      block: string;
      at: Xyz;
      scale?: [number, number, number];
      /** Degrees. */
      rotation?: number;
      normal?: Xyz;
      attribs?: Array<{ tag: string; value: string; at: Xyz; height: number }>;
    }
  | {
      kind: 'ATTDEF';
      layer: string;
      tag: string;
      prompt: string;
      value: string;
      at: Xyz;
      height: number;
    }
  | {
      kind: 'DIMENSION';
      layer: string;
      from: Xyz;
      to: Xyz;
      text?: string;
    }
  | {
      kind: 'VIEWPORT';
      layer: string;
      center: Xyz;
      width: number;
      height: number;
      viewHeight: number;
      id?: number;
    };

export interface DxfLayer {
  name: string;
  color: number;
  linetype?: string;
  off?: boolean;
  frozen?: boolean;
  locked?: boolean;
  dependent?: boolean;
}

export interface DxfDrawing {
  /** $INSUNITS: 4 millimetres, 6 metres, 1 inches, 0 none. */
  units: number;
  measurement?: 0 | 1;
  codepage?: string;
  layers: DxfLayer[];
  linetypes?: Array<{ name: string; description: string; pattern: number[] }>;
  styles?: Array<{
    name: string;
    font: string;
    bigfont?: string;
    height?: number;
    backwards?: boolean;
  }>;
  blocks?: Array<{ name: string; base?: Xyz; entities: Ent[] }>;
  /** External references: a block that names another file. */
  xrefs?: Array<{ name: string; path: string; units?: number }>;
  model: Ent[];
  paper?: Ent[];
}

class Out {
  private lines: string[] = [];
  private next = 0x100;
  handle(): string {
    return (this.next++).toString(16).toUpperCase();
  }
  get seed(): string {
    return (this.next + 1).toString(16).toUpperCase();
  }
  g(code: number, value: string | number): void {
    this.lines.push(
      String(code),
      typeof value === 'number'
        ? isInteger(code)
          ? int(value)
          : num(value)
        : value,
    );
  }
  text(): string {
    return `${this.lines.join('\r\n')}\r\n`;
  }
}

// Group codes whose values are integers; the rest of the numeric codes are reals.
function isInteger(code: number): boolean {
  return (
    (code >= 60 && code <= 99) ||
    (code >= 170 && code <= 179) ||
    (code >= 270 && code <= 289) ||
    (code >= 370 && code <= 389) ||
    (code >= 400 && code <= 409) ||
    (code >= 1060 && code <= 1071)
  );
}

function int(v: number): string {
  if (!Number.isInteger(v)) throw new Error('a DXF integer must be whole');
  return String(v);
}

function num(v: number): string {
  if (!Number.isFinite(v)) throw new Error('a DXF number must be finite');
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

const xyz = (p: Xyz): [number, number, number] => [p[0], p[1], p[2] ?? 0];

function point(o: Out, base: number, p: Xyz): void {
  const [x, y, z] = xyz(p);
  o.g(base, x);
  o.g(base + 10, y);
  o.g(base + 20, z);
}

// Text in DXF R2000 is in the drawing's code page, as AutoCAD writes it:
// a character the code page holds is written as its byte, and any other as
// a \U+XXXX escape. The file is assembled as one byte per character.
const CODE_PAGES: Record<string, string> = {
  ANSI_1252: 'windows-1252',
  ANSI_1255: 'windows-1255',
};

function pageMap(codepage: string): Map<string, number> {
  const map = new Map<string, number>();
  const label = CODE_PAGES[codepage];
  if (!label) return map;
  const decoder = new TextDecoder(label);
  for (let b = 0x80; b <= 0xff; b++) {
    const ch = decoder.decode(Uint8Array.of(b));
    if (ch !== '\ufffd' && !map.has(ch)) map.set(ch, b);
  }
  return map;
}

let page = new Map<string, number>();

function dxfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0x20 && cp < 0x80) out += ch;
    else if (page.has(ch)) out += String.fromCharCode(page.get(ch) as number);
    else out += `\\U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

const deg = (r: number) => r;

/** The drawing as DXF bytes, text in its code page. */
export function writeDxf(d: DxfDrawing): Buffer {
  page = pageMap(d.codepage ?? 'ANSI_1252');
  const o = new Out();
  const linetypes = [
    { name: 'ByBlock', description: '', pattern: [] as number[] },
    { name: 'ByLayer', description: '', pattern: [] as number[] },
    { name: 'Continuous', description: 'Solid line', pattern: [] as number[] },
    ...(d.linetypes ?? []),
  ];
  const styles = [{ name: 'Standard', font: 'txt' }, ...(d.styles ?? [])];
  const layers: DxfLayer[] = [{ name: '0', color: 7 }, ...d.layers];

  // Handles fixed up front, so owners can be named before they are written.
  const tables: Record<string, string> = {};
  for (const t of [
    'VPORT',
    'LTYPE',
    'LAYER',
    'STYLE',
    'VIEW',
    'UCS',
    'APPID',
    'DIMSTYLE',
    'BLOCK_RECORD',
  ])
    tables[t] = o.handle();
  const root = o.handle();
  const groupDict = o.handle();
  const layoutDict = o.handle();
  const modelLayout = o.handle();
  const paperLayout = o.handle();
  const record: Record<string, string> = {};
  const blockNames = [
    '*Model_Space',
    '*Paper_Space',
    ...(d.blocks ?? []).map((b) => b.name),
    ...(d.xrefs ?? []).map((x) => x.name),
  ];
  for (const name of blockNames) record[name] = o.handle();

  // HEADER
  o.g(0, 'SECTION');
  o.g(2, 'HEADER');
  o.g(9, '$ACADVER');
  o.g(1, 'AC1015');
  o.g(9, '$DWGCODEPAGE');
  o.g(3, d.codepage ?? 'ANSI_1252');
  o.g(9, '$INSUNITS');
  o.g(70, d.units);
  if (d.measurement !== undefined) {
    o.g(9, '$MEASUREMENT');
    o.g(70, d.measurement);
  }
  o.g(9, '$HANDSEED');
  o.g(5, 'FFFF');
  o.g(0, 'ENDSEC');

  // CLASSES (none needed)
  o.g(0, 'SECTION');
  o.g(2, 'CLASSES');
  o.g(0, 'ENDSEC');

  // TABLES
  o.g(0, 'SECTION');
  o.g(2, 'TABLES');
  const table = (name: string, count: number, entries: () => void) => {
    o.g(0, 'TABLE');
    o.g(2, name);
    o.g(5, tables[name] as string);
    o.g(330, '0');
    o.g(100, 'AcDbSymbolTable');
    o.g(70, count);
    entries();
    o.g(0, 'ENDTAB');
  };
  const entry = (
    type: string,
    sub: string,
    owner: string,
    handle = o.handle(),
  ) => {
    o.g(0, type);
    o.g(5, handle);
    o.g(330, owner);
    o.g(100, 'AcDbSymbolTableRecord');
    o.g(100, sub);
  };
  table('VPORT', 1, () => {
    entry('VPORT', 'AcDbViewportTableRecord', tables.VPORT as string);
    o.g(2, '*Active');
    o.g(70, 0);
  });
  table('LTYPE', linetypes.length, () => {
    for (const lt of linetypes) {
      entry('LTYPE', 'AcDbLinetypeTableRecord', tables.LTYPE as string);
      o.g(2, lt.name);
      o.g(70, 0);
      o.g(3, lt.description);
      o.g(72, 65);
      o.g(73, lt.pattern.length);
      o.g(
        40,
        lt.pattern.reduce((a, b) => a + Math.abs(b), 0),
      );
      for (const len of lt.pattern) {
        o.g(49, len);
        o.g(74, 0);
      }
    }
  });
  table('LAYER', layers.length, () => {
    for (const l of layers) {
      entry('LAYER', 'AcDbLayerTableRecord', tables.LAYER as string);
      o.g(2, l.name);
      o.g(70, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0) | (l.dependent ? 16 : 0));
      o.g(62, l.off ? -l.color : l.color);
      o.g(6, l.linetype ?? 'Continuous');
      o.g(370, -3);
      o.g(390, '0');
    }
  });
  table('STYLE', styles.length, () => {
    for (const s of styles) {
      entry('STYLE', 'AcDbTextStyleTableRecord', tables.STYLE as string);
      o.g(2, s.name);
      o.g(70, 0);
      o.g(40, 'height' in s && s.height ? s.height : 0);
      o.g(41, 1);
      o.g(50, 0);
      o.g(71, 'backwards' in s && s.backwards ? 2 : 0);
      o.g(42, 2.5);
      o.g(3, s.font);
      o.g(4, 'bigfont' in s && s.bigfont ? s.bigfont : '');
    }
  });
  table('VIEW', 0, () => {});
  table('UCS', 0, () => {});
  table('APPID', 1, () => {
    entry('APPID', 'AcDbRegAppTableRecord', tables.APPID as string);
    o.g(2, 'ACAD');
    o.g(70, 0);
  });
  table('DIMSTYLE', 1, () => {
    o.g(0, 'DIMSTYLE');
    o.g(105, o.handle());
    o.g(330, tables.DIMSTYLE as string);
    o.g(100, 'AcDbSymbolTableRecord');
    o.g(100, 'AcDbDimStyleTableRecord');
    o.g(2, 'Standard');
    o.g(70, 0);
  });
  table('BLOCK_RECORD', blockNames.length, () => {
    for (const name of blockNames) {
      entry(
        'BLOCK_RECORD',
        'AcDbBlockTableRecord',
        tables.BLOCK_RECORD as string,
        record[name],
      );
      o.g(2, name);
      if (name === '*Model_Space') o.g(340, modelLayout);
      if (name === '*Paper_Space') o.g(340, paperLayout);
      const units = d.xrefs?.find((x) => x.name === name)?.units;
      if (units !== undefined) o.g(70, units);
    }
  });
  o.g(0, 'ENDSEC');

  // BLOCKS
  o.g(0, 'SECTION');
  o.g(2, 'BLOCKS');
  const block = (
    name: string,
    flags: number,
    base: Xyz,
    path: string,
    entities: Ent[],
    paper: boolean,
  ) => {
    const owner = record[name] as string;
    o.g(0, 'BLOCK');
    o.g(5, o.handle());
    o.g(330, owner);
    o.g(100, 'AcDbEntity');
    if (paper) o.g(67, 1);
    o.g(8, '0');
    o.g(100, 'AcDbBlockBegin');
    o.g(2, name);
    o.g(70, flags);
    point(o, 10, base);
    o.g(3, name);
    o.g(1, path);
    for (const e of entities) entity(o, e, owner, false);
    o.g(0, 'ENDBLK');
    o.g(5, o.handle());
    o.g(330, owner);
    o.g(100, 'AcDbEntity');
    if (paper) o.g(67, 1);
    o.g(8, '0');
    o.g(100, 'AcDbBlockEnd');
  };
  block('*Model_Space', 0, [0, 0, 0], '', [], false);
  block('*Paper_Space', 0, [0, 0, 0], '', [], true);
  for (const b of d.blocks ?? []) {
    const hasAtt = b.entities.some((e) => e.kind === 'ATTDEF');
    block(b.name, hasAtt ? 2 : 0, b.base ?? [0, 0, 0], '', b.entities, false);
  }
  for (const x of d.xrefs ?? []) block(x.name, 4, [0, 0, 0], x.path, [], false);
  o.g(0, 'ENDSEC');

  // ENTITIES
  o.g(0, 'SECTION');
  o.g(2, 'ENTITIES');
  for (const e of d.model)
    entity(o, e, record['*Model_Space'] as string, false);
  for (const e of d.paper ?? [])
    entity(o, e, record['*Paper_Space'] as string, true);
  o.g(0, 'ENDSEC');

  // OBJECTS: the root dictionary, groups and the two layouts.
  o.g(0, 'SECTION');
  o.g(2, 'OBJECTS');
  o.g(0, 'DICTIONARY');
  o.g(5, root);
  o.g(330, '0');
  o.g(100, 'AcDbDictionary');
  o.g(281, 1);
  o.g(3, 'ACAD_GROUP');
  o.g(350, groupDict);
  o.g(3, 'ACAD_LAYOUT');
  o.g(350, layoutDict);
  o.g(0, 'DICTIONARY');
  o.g(5, groupDict);
  o.g(330, root);
  o.g(100, 'AcDbDictionary');
  o.g(281, 1);
  o.g(0, 'DICTIONARY');
  o.g(5, layoutDict);
  o.g(330, root);
  o.g(100, 'AcDbDictionary');
  o.g(281, 1);
  o.g(3, 'Model');
  o.g(350, modelLayout);
  o.g(3, 'Sheet');
  o.g(350, paperLayout);
  const layout = (handle: string, name: string, tab: number, br: string) => {
    o.g(0, 'LAYOUT');
    o.g(5, handle);
    o.g(330, layoutDict);
    o.g(100, 'AcDbPlotSettings');
    o.g(1, '');
    o.g(4, '');
    o.g(6, '');
    o.g(40, 0);
    o.g(41, 0);
    o.g(42, 0);
    o.g(43, 0);
    o.g(44, 0);
    o.g(45, 0);
    o.g(46, 0);
    o.g(47, 0);
    o.g(48, 0);
    o.g(49, 0);
    o.g(140, 0);
    o.g(141, 0);
    o.g(142, 1);
    o.g(143, 1);
    o.g(70, 688);
    o.g(72, 0);
    o.g(73, 0);
    o.g(74, 5);
    o.g(7, '');
    o.g(75, 16);
    o.g(147, 1);
    o.g(148, 0);
    o.g(149, 0);
    o.g(100, 'AcDbLayout');
    o.g(1, name);
    o.g(70, 1);
    o.g(71, tab);
    o.g(10, 0);
    o.g(20, 0);
    o.g(11, 420);
    o.g(21, 297);
    o.g(12, 0);
    o.g(22, 0);
    o.g(32, 0);
    o.g(14, 0);
    o.g(24, 0);
    o.g(34, 0);
    o.g(15, 0);
    o.g(25, 0);
    o.g(35, 0);
    o.g(146, 0);
    o.g(13, 0);
    o.g(23, 0);
    o.g(33, 0);
    o.g(16, 1);
    o.g(26, 0);
    o.g(36, 0);
    o.g(17, 0);
    o.g(27, 1);
    o.g(37, 0);
    o.g(76, 0);
    o.g(330, br);
  };
  layout(modelLayout, 'Model', 0, record['*Model_Space'] as string);
  layout(paperLayout, 'Sheet', 1, record['*Paper_Space'] as string);
  o.g(0, 'ENDSEC');
  o.g(0, 'EOF');
  return Buffer.from(o.text(), 'latin1');
}

function common(
  o: Out,
  type: string,
  owner: string,
  paper: boolean,
  e: { layer: string; linetype?: string; color?: number },
  handle = o.handle(),
): string {
  o.g(0, type);
  o.g(5, handle);
  o.g(330, owner);
  o.g(100, 'AcDbEntity');
  if (paper) o.g(67, 1);
  o.g(8, e.layer);
  if (e.linetype) o.g(6, e.linetype);
  if (e.color !== undefined) o.g(62, e.color);
  return handle;
}

function normal(o: Out, n: Xyz | undefined): void {
  if (n) point(o, 210, n);
}

function entity(o: Out, e: Ent, owner: string, paper: boolean): void {
  switch (e.kind) {
    case 'LINE':
      common(o, 'LINE', owner, paper, e);
      o.g(100, 'AcDbLine');
      point(o, 10, e.from);
      point(o, 11, e.to);
      return;
    case 'LWPOLYLINE':
      common(o, 'LWPOLYLINE', owner, paper, e);
      o.g(100, 'AcDbPolyline');
      o.g(90, e.pts.length);
      o.g(70, e.closed ? 1 : 0);
      e.pts.forEach((p, i) => {
        o.g(10, p[0]);
        o.g(20, p[1]);
        const b = e.bulges?.[i] ?? 0;
        if (b) o.g(42, b);
      });
      normal(o, e.normal);
      return;
    case 'ARC':
      common(o, 'ARC', owner, paper, e);
      o.g(100, 'AcDbCircle');
      point(o, 10, e.center);
      o.g(40, e.radius);
      normal(o, e.normal);
      o.g(100, 'AcDbArc');
      o.g(50, deg(e.start));
      o.g(51, deg(e.end));
      return;
    case 'CIRCLE':
      common(o, 'CIRCLE', owner, paper, e);
      o.g(100, 'AcDbCircle');
      point(o, 10, e.center);
      o.g(40, e.radius);
      return;
    case 'ELLIPSE':
      common(o, 'ELLIPSE', owner, paper, e);
      o.g(100, 'AcDbEllipse');
      point(o, 10, e.center);
      point(o, 11, e.major);
      o.g(40, e.ratio);
      o.g(41, e.t0 ?? 0);
      o.g(42, e.t1 ?? Math.PI * 2);
      return;
    case 'SPLINE':
      common(o, 'SPLINE', owner, paper, e);
      o.g(100, 'AcDbSpline');
      o.g(210, 0);
      o.g(220, 0);
      o.g(230, 1);
      o.g(70, 8);
      o.g(71, e.degree);
      o.g(72, e.knots.length);
      o.g(73, e.ctrl.length);
      o.g(74, 0);
      for (const k of e.knots) o.g(40, k);
      for (const c of e.ctrl) point(o, 10, c);
      return;
    case 'POINT':
      common(o, 'POINT', owner, paper, e);
      o.g(100, 'AcDbPoint');
      point(o, 10, e.at);
      return;
    case 'TEXT':
      common(o, 'TEXT', owner, paper, e);
      o.g(100, 'AcDbText');
      point(o, 10, e.at);
      o.g(40, e.height);
      o.g(1, dxfText(e.value));
      if (e.rotation) o.g(50, e.rotation);
      if (e.style) o.g(7, e.style);
      if (e.backwards) o.g(71, 2);
      o.g(100, 'AcDbText');
      return;
    case 'MTEXT':
      common(o, 'MTEXT', owner, paper, e);
      o.g(100, 'AcDbMText');
      point(o, 10, e.at);
      o.g(40, e.height);
      o.g(41, e.width ?? 0);
      o.g(71, 1);
      o.g(72, 5);
      o.g(1, dxfText(e.value));
      if (e.style) o.g(7, e.style);
      return;
    case 'ATTDEF':
      common(o, 'ATTDEF', owner, paper, e);
      o.g(100, 'AcDbText');
      point(o, 10, e.at);
      o.g(40, e.height);
      o.g(1, dxfText(e.value));
      o.g(100, 'AcDbAttributeDefinition');
      o.g(3, dxfText(e.prompt));
      o.g(2, e.tag);
      o.g(70, 0);
      return;
    case 'DIMENSION':
      common(o, 'DIMENSION', owner, paper, e);
      o.g(100, 'AcDbDimension');
      point(o, 10, [e.to[0], e.to[1] + 10]);
      point(o, 11, [(e.from[0] + e.to[0]) / 2, e.to[1] + 10]);
      o.g(70, 33);
      if (e.text !== undefined) o.g(1, dxfText(e.text));
      o.g(100, 'AcDbAlignedDimension');
      point(o, 13, e.from);
      point(o, 14, e.to);
      return;
    case 'VIEWPORT':
      common(o, 'VIEWPORT', owner, paper, e);
      o.g(100, 'AcDbViewport');
      point(o, 10, e.center);
      o.g(40, e.width);
      o.g(41, e.height);
      o.g(68, 1);
      o.g(69, e.id ?? 2);
      o.g(12, 0);
      o.g(22, 0);
      o.g(45, e.viewHeight);
      return;
    case 'INSERT': {
      const h = o.handle();
      common(o, 'INSERT', owner, paper, e, h);
      o.g(100, 'AcDbBlockReference');
      if (e.attribs?.length) o.g(66, 1);
      o.g(2, e.block);
      point(o, 10, e.at);
      const [sx, sy, sz] = e.scale ?? [1, 1, 1];
      o.g(41, sx);
      o.g(42, sy);
      o.g(43, sz);
      if (e.rotation) o.g(50, e.rotation);
      normal(o, e.normal);
      if (e.attribs?.length) {
        for (const a of e.attribs) {
          common(o, 'ATTRIB', h, paper, e);
          o.g(100, 'AcDbText');
          point(o, 10, a.at);
          o.g(40, a.height);
          o.g(1, dxfText(a.value));
          o.g(100, 'AcDbAttribute');
          o.g(2, a.tag);
          o.g(70, 0);
        }
        common(o, 'SEQEND', h, paper, e);
      }
      return;
    }
  }
}
