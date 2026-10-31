// Line icons (lucide-style: 24-unit grid, round caps, drawn with currentColor). Sized by
// CSS (.ico is 16px; .ico.sm 14px), so they follow the surrounding text colour in both themes.

import type { ObjectType } from "@core/types";

type Shape = string | { c: [number, number, number] } | { r: [number, number, number, number, number?] } | { e: [number, number, number, number] };

const ICONS = {
  sidebar: [{ r: [3, 3, 18, 18, 2] }, "M9 3v18"],
  "panel-right": [{ r: [3, 3, 18, 18, 2] }, "M15 3v18"],
  home: ["M3 10.2a2 2 0 0 1 .7-1.5l7-6a2 2 0 0 1 2.6 0l7 6a2 2 0 0 1 .7 1.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M9 21v-7h6v7"],
  log: ["M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"],
  copy: [{ r: [8, 8, 13, 13, 2] }, "M4 16V6a2 2 0 0 1 2-2h10"],
  terminal: [{ r: [3, 4, 18, 16, 2] }, "m7 9 3 3-3 3", "M13 15h4"],
  refresh: ["M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8", "M21 3v5h-5"],
  back: ["m15 18-6-6 6-6"],
  forward: ["m9 18 6-6-6-6"],
  prev: ["m15 18-6-6 6-6"],
  next: ["m9 18 6-6-6-6"],
  "chevron-right": ["m9 18 6-6-6-6"],
  "chevron-down": ["m6 9 6 6 6-6"],
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  close: ["M18 6 6 18M6 6l12 12"],
  check: ["M20 6 9 17l-5-5"],
  edit: ["M21.2 6.8a2.8 2.8 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8L2 21.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z", "m15 5 4 4"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  filter: ["M22 3H2l8 9.5V19l4 2v-8.5z"],
  clear: [{ c: [12, 12, 10] }, "m15 9-6 6M9 9l6 6"],
  search: [{ c: [11, 11, 7] }, "m20 20-3.9-3.9"],
  "arrow-right": ["M5 12h14", "m12 5 7 7-7 7"],
  "reset-width": ["m18 8 4 4-4 4", "m6 8-4 4 4 4", "M2 12h20"],
  star: ["M11.5 2.3a.5.5 0 0 1 1 0l2.3 4.7a2.1 2.1 0 0 0 1.6 1.2l5.2.7a.5.5 0 0 1 .3.9l-3.8 3.7a2.1 2.1 0 0 0-.6 1.8l.9 5.2a.5.5 0 0 1-.8.5l-4.6-2.4a2.1 2.1 0 0 0-2 0L6.4 21a.5.5 0 0 1-.8-.5l.9-5.2a2.1 2.1 0 0 0-.6-1.8L2.2 9.8a.5.5 0 0 1 .3-.9l5.1-.7a2.1 2.1 0 0 0 1.6-1.2z"],
  more: ["M5 12h.01M12 12h.01M19 12h.01"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  settings: ["M20 7h-9M14 17H5", { c: [17, 17, 3] }, { c: [7, 7, 3] }],
  help: [{ c: [12, 12, 10] }, "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3", "M12 17h.01"],
  history: ["M3 12a9 9 0 1 0 9-9 9.8 9.8 0 0 0-6.7 2.7L3 8", "M3 3v5h5", "M12 7v5l4 2"],
  items: ["M21 12h-8M21 6H8M21 18h-8", "M3 6v4a2 2 0 0 0 2 2h3", "M3 10v6a2 2 0 0 0 2 2h3"],
  collections: ["M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.7-.9l-.8-1.2a2 2 0 0 0-1.7-.9H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2z", "M2 8v11a2 2 0 0 0 2 2h14"],
  workflow: [{ r: [3, 3, 8, 8, 2] }, "M7 11v4a2 2 0 0 0 2 2h4", { r: [13, 13, 8, 8, 2] }],
  "folder-open": ["m6 14 1.5-2.9A2 2 0 0 1 9.2 10H20a2 2 0 0 1 1.9 2.5l-1.5 6a2 2 0 0 1-2 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H18a2 2 0 0 1 2 2v2"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"],
  play: ["M6 4v16l14-8z"],
  sun: [{ c: [12, 12, 4] }, "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"],
  moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"],
  monitor: [{ r: [2, 3, 20, 14, 2] }, "M8 21h8M12 17v4"],
  // object kinds (tree rows and work tabs)
  database: [{ e: [12, 5, 9, 3] }, "M3 5v14a9 3 0 0 0 18 0V5", "M3 12a9 3 0 0 0 18 0"],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"],
  table: [{ r: [3, 3, 18, 18, 2] }, "M3 9h18M3 15h18M12 3v18"],
  view: [{ r: [3, 3, 18, 18, 2] }, "M3 9h18", "M7.5 15.5c2.6-3 6.4-3 9 0", "M12 15.5h.01"],
  "materialized-view": ["M12.8 2.2a2 2 0 0 0-1.6 0L2.6 6.1a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.6 0l8.6-3.9a1 1 0 0 0 0-1.8z", "m22 12.6-9.2 4.2a2 2 0 0 1-1.6 0L2 12.6", "m22 17.6-9.2 4.2a2 2 0 0 1-1.6 0L2 17.6"],
  function: [{ r: [3, 3, 18, 18, 2] }, "M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3", "M9 11.2h5.7"],
  dictionary: ["M12 7v14", "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"],
  key: ["m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4", "m21 2-9.6 9.6", { c: [7.5, 15.5, 5.5] }],
  file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z", "M14 2v4a2 2 0 0 0 2 2h4"],
  query: [{ r: [3, 3, 18, 18, 2] }, "m7 10 3 2.5L7 15", "M12.5 15H17"],
  "named-query": ["m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "ico", title }: { name: IconName; className?: string; title?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      {(ICONS[name] as Shape[]).map((s, i) =>
        typeof s === "string" ? (
          <path key={i} d={s} />
        ) : "c" in s ? (
          <circle key={i} cx={s.c[0]} cy={s.c[1]} r={s.c[2]} />
        ) : "r" in s ? (
          <rect key={i} x={s.r[0]} y={s.r[1]} width={s.r[2]} height={s.r[3]} rx={s.r[4] ?? 0} />
        ) : (
          <ellipse key={i} cx={s.e[0]} cy={s.e[1]} rx={s.e[2]} ry={s.e[3]} />
        ),
      )}
    </svg>
  );
}

/** Icon for an object kind in the tree and on work tabs; groups have none (they render as section labels). */
export function objectIcon(type: ObjectType | string | undefined): IconName | null {
  switch (type) {
    case "database":
    case "dataset":
      return "database";
    case "schema":
      return "folder";
    case "table":
      return "table";
    case "view":
      return "view";
    case "materialized_view":
      return "materialized-view";
    case "function":
      return "function";
    case "dictionary":
      return "dictionary";
    case "key":
      return "key";
    case "file":
      return "file";
    default:
      return null;
  }
}
