// Plain textarea with a highlighted copy of its text drawn underneath. Typing, undo, IME and
// selection stay native; only the colours come from the layer behind.

import { forwardRef, useMemo, useRef, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { tokenize } from "../lib/sqlFormat";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
};

export const SqlEditor = forwardRef<HTMLTextAreaElement, Props>(function SqlEditor({ value, onChange, onKeyDown, onScroll, className, ...rest }, ref) {
  const layer = useRef<HTMLPreElement>(null);
  const tokens = useMemo(() => tokenize(value), [value]);

  return (
    <div className={"sqled " + (className ?? "")}>
      <pre ref={layer} className="sqled-layer" aria-hidden="true">
        {tokens.map((t, i) => (t.kind === "text" ? t.text : <span key={i} className={"tk-" + t.kind}>{t.text}</span>))}
        {/* A trailing newline needs a character after it, or the layer ends one line short. */}
        {"\n "}
      </pre>
      <textarea
        ref={ref}
        className="sqled-input"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (layer.current) {
            layer.current.scrollTop = e.currentTarget.scrollTop;
            layer.current.scrollLeft = e.currentTarget.scrollLeft;
          }
          onScroll?.(e);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => onKeyDown?.(e)}
        {...rest}
      />
    </div>
  );
});
