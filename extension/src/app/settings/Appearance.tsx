// Settings → Appearance: Dark (default) / Light / Match system. Saved by lib/theme.ts,
// which also sets <html data-theme> right away.

import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { THEMES, loadTheme, saveTheme, type ThemePref } from "../lib/theme";

const THEME_ICON = { dark: "moon", light: "sun", system: "monitor" } as const;

export function Appearance() {
  const [theme, setTheme] = useState<ThemePref | null>(null);
  useEffect(() => {
    void loadTheme().then(setTheme);
  }, []);
  const pick = (t: ThemePref) => {
    setTheme(t);
    void saveTheme(t);
  };
  return (
    <section id="settings-appearance">
      <h2>Appearance</h2>
      <div className="setrow">
        <span>
          <b>Theme</b>
          <small className="muted">Match system follows your macOS light or dark setting.</small>
        </span>
        <div className="seg" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.value} role="radio" aria-checked={theme === t.value} aria-pressed={theme === t.value} onClick={() => pick(t.value)}>
              <Icon name={THEME_ICON[t.value]} className="ico" />
              {t.label}
              {t.value === "dark" && <small className="dflt">default</small>}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
