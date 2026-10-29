// Stroke icons for toolbar and row buttons. Sized by CSS (.ico, 18px by default) and
// coloured with currentColor, so they follow the button's text colour in both themes.

export type IconName =
  | "sidebar" | "home" | "lock" | "unlock" | "log" | "refresh" | "panel-right"
  | "back" | "forward" | "plus" | "minus" | "close" | "edit" | "trash"
  | "filter" | "clear" | "prev" | "next" | "arrow-right" | "reset-width" | "star";

const paths: Record<IconName, string> = {
  sidebar: "M3 5h18v14H3zM9 5v14",
  home: "M4 11l8-7 8 7M6 9.5V20h12V9.5",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  unlock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 6.7-1.4",
  log: "M5 6h14M5 12h14M5 18h9",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  "panel-right": "M3 5h18v14H3zM15 5v14",
  back: "M15 5l-7 7 7 7",
  forward: "M9 5l7 7-7 7",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  filter: "M4 5h16l-6 8v6l-4-2v-4z",
  clear: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6",
  prev: "M15 5l-7 7 7 7",
  next: "M9 5l7 7-7 7",
  "arrow-right": "M5 12h14M13 6l6 6-6 6",
  "reset-width": "M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z",
};

export function Icon({ name, className = "ico" }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
