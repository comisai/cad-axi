// The drawing as the engine described it, reduced from its records. Every
// field comes from the file; nothing is filled in.

import type { EngineRecord } from '../bridge/engine.ts';

export type P3 = [number, number, number];
export type P2 = [number, number];

export interface Header {
  format: 'dwg' | 'dxf';
  version: string;
  codepage: string;
  codepage_assumed?: boolean;
  insunits: number;
  measurement: number;
  extmin?: P3;
  extmax?: P3;
  ltscale: number;
  layouts: Array<{ name: string; block: string; tab: number }>;
}

export interface Layer {
  name: string;
  on: boolean;
  frozen: boolean;
  locked: boolean;
  plot: boolean;
  color: number;
  rgb?: string;
  linetype: string;
  entities: number;
}

export interface Linetype {
  name: string;
  description: string;
  pattern: number[];
}

export interface Style {
  name: string;
  font: string;
  bigfont: string;
  kind: 'shx' | 'ttf' | 'unknown';
  backwards: boolean;
  upside: boolean;
  height: number;
  width: number;
}

export interface Block {
  name: string;
  base: P3;
  layout: boolean;
  anonymous: boolean;
  external: boolean;
  overlay: boolean;
  dependent: boolean;
  path_present: boolean;
  xref_file?: string;
  xref_folder?: string;
  units?: number;
  attributes: string[];
  entities: number;
}

export interface Attrib {
  h: string;
  tag: string;
  layer: string;
  raw: string;
  at: P3;
  height: number;
  rot: number;
  style: string;
  backwards?: boolean;
  n?: P3;
}

/** One entity record; geometry fields depend on the kind. */
export interface Entity {
  h: string;
  kind: string;
  layer: string;
  owner: string;
  color: number;
  rgb?: string;
  lt: string;
  lts?: number;
  invisible?: boolean;
  unknown?: boolean;
  proxy?: boolean;
  // Geometry, by kind.
  a?: P3;
  b?: P3;
  c?: P3;
  r?: number;
  a0?: number;
  a1?: number;
  n?: P3;
  major?: P3;
  ratio?: number;
  t0?: number;
  t1?: number;
  pts?: number[][];
  bulges?: number[];
  closed?: boolean;
  elev?: number;
  d3?: boolean;
  degree?: number;
  periodic?: boolean;
  ctrl?: P3[];
  knots?: number[];
  weights?: number[];
  fit?: P3[];
  at?: P3;
  align?: P3;
  halign?: number;
  valign?: number;
  raw?: string;
  height?: number;
  rot?: number;
  style?: string;
  wf?: number;
  backwards?: boolean;
  upside?: boolean;
  width?: number;
  attach?: number;
  tag?: string;
  prompt?: string;
  block?: string;
  sx?: number;
  sy?: number;
  sz?: number;
  cols?: number;
  rows?: number;
  cs?: number;
  rs?: number;
  attribs?: Attrib[];
  text?: string;
  measurement?: number;
  measurement_kind?: 'length' | 'angle';
  dimension_factor?: number;
  dimension_suffix?: string;
  pattern?: string;
  solid?: boolean;
  loops?: P2[][];
  u?: P3;
  v?: P3;
  size?: P2;
  path_present?: boolean;
  w?: number;
  ht?: number;
  view?: P2;
  view_height?: number;
  id?: number;
  class?: string;
}

export interface ClassInfo {
  name: string;
  cpp: string;
  app: string;
  instances: number;
  entity: boolean;
  unknown: number;
}

export interface Drawing {
  header: Header;
  layers: Layer[];
  linetypes: Linetype[];
  styles: Style[];
  blocks: Map<string, Block>;
  externals: Array<{ kind: string; name: string; path_present: boolean }>;
  entities: Entity[];
  /** Entities by owner block record name. */
  byOwner: Map<string, Entity[]>;
  kinds: Map<string, number>;
  classes: ClassInfo[];
  objects: Array<{ name: string; count: number; unknown: boolean }>;
  end: {
    entities: number;
    unknown: number;
    proxies: number;
    unknown_objects: number;
    errors: number;
    warnings: number;
    ms: number;
  };
}

export function emptyDrawing(): Drawing {
  return {
    header: {
      format: 'dwg',
      version: '',
      codepage: '',
      insunits: 0,
      measurement: 0,
      ltscale: 1,
      layouts: [],
    },
    layers: [],
    linetypes: [],
    styles: [],
    blocks: new Map(),
    externals: [],
    entities: [],
    byOwner: new Map(),
    kinds: new Map(),
    classes: [],
    objects: [],
    end: {
      entities: 0,
      unknown: 0,
      proxies: 0,
      unknown_objects: 0,
      errors: 0,
      warnings: 0,
      ms: 0,
    },
  };
}

/** Fold one engine record into the drawing. */
export function reduce(d: Drawing, r: EngineRecord): void {
  const { p: _p, type, ...rest } = r;
  switch (type) {
    case 'header':
      d.header = rest as unknown as Header;
      return;
    case 'layer':
      d.layers.push(rest as unknown as Layer);
      return;
    case 'linetype':
      d.linetypes.push(rest as unknown as Linetype);
      return;
    case 'style':
      d.styles.push(rest as unknown as Style);
      return;
    case 'block': {
      const b = rest as unknown as Block;
      d.blocks.set(b.name, b);
      return;
    }
    case 'external':
      d.externals.push(
        rest as unknown as {
          kind: string;
          name: string;
          path_present: boolean;
        },
      );
      return;
    case 'entity': {
      const e = rest as unknown as Entity;
      d.entities.push(e);
      const list = d.byOwner.get(e.owner);
      if (list) list.push(e);
      else d.byOwner.set(e.owner, [e]);
      return;
    }
    case 'kind':
      d.kinds.set(String(rest.name), Number(rest.count));
      return;
    case 'class':
      d.classes.push(rest as unknown as ClassInfo);
      return;
    case 'object':
      d.objects.push(
        rest as unknown as { name: string; count: number; unknown: boolean },
      );
      return;
    case 'end':
      d.end = rest as unknown as Drawing['end'];
      return;
  }
}

/** The release that wrote a version code. */
export const RELEASES: Record<string, string> = {
  AC1009: 'R11/R12',
  AC1012: 'R13',
  AC1014: 'R14',
  AC1015: 'AutoCAD 2000',
  AC1018: 'AutoCAD 2004',
  AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013',
  AC1032: 'AutoCAD 2018',
};

export const MODEL = '*Model_Space';

/** The layout a block record belongs to, or null for an ordinary block. */
export function layoutOf(d: Drawing, owner: string): string | null {
  const found = d.header.layouts.find(
    (l) => l.block.toLowerCase() === owner.toLowerCase(),
  );
  if (found) return found.name;
  if (owner.toLowerCase() === '*model_space') return 'Model';
  if (owner.toLowerCase().startsWith('*paper_space')) return owner;
  return null;
}

/** Block record names whose entities lie in the chosen space. */
export function spaceBlocks(d: Drawing, space: string): string[] {
  if (space === 'all')
    return [...d.blocks.values()].filter((b) => b.layout).map((b) => b.name);
  const want = space.toLowerCase();
  if (want === 'model') {
    const model = [...d.blocks.keys()].find(
      (n) => n.toLowerCase() === '*model_space',
    );
    return [model ?? MODEL];
  }
  const layout = d.header.layouts.find((l) => l.name.toLowerCase() === want);
  return layout ? [layout.block] : [];
}

/** The layout names a --space flag may take. */
export function spaceNames(d: Drawing): string[] {
  return d.header.layouts.map((l) => l.name);
}
