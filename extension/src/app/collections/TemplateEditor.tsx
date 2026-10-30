// Editor for named query templates: the same textarea-over-highlight-layer as SqlEditor, with
// Jinja tags coloured on top of the SQL and raw {{ x }} in a value position underlined amber.

import { forwardRef, useMemo, useRef, type KeyboardEvent, type TextareaHTMLAttributes } from "react";
import { tokenizeTemplate } from "../../collections/highlight";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
};

export const TemplateEditor = forwardRef<HTMLTextAreaElement, Props>(function TemplateEditor({ value, onChange, onKeyDown, onScroll, className, ...rest }, ref) {
  const layer = useRef<HTMLPreElement>(null);
  const tokens = useMemo(() => tokenizeTemplate(value), [value]);
  return (
    <div className={"sqled " + (className ?? "")}>
      <pre ref={layer} className="sqled-layer" aria-hidden="true">
        {tokens.map((t, i) => (t.kind === "text" ? t.text : <span key={i} className={"tk-" + t.kind}>{t.text}</span>))}
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
