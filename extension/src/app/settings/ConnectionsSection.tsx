// Settings → Connections: show or hide the demo connection in the popup and connection pickers.

import { useEffect, useState } from "react";
import { loadShowDemo, saveShowDemo } from "../lib/demoSetting";

export function ConnectionsSection() {
  const [show, setShow] = useState<boolean | null>(null);
  useEffect(() => {
    void loadShowDemo().then(setShow);
  }, []);
  const toggle = (on: boolean) => {
    setShow(on);
    void saveShowDemo(on);
  };
  return (
    <section id="settings-connections">
      <h2>Connections</h2>
      <label className="switch">
        <input type="checkbox" checked={show ?? true} disabled={show === null} onChange={(e) => toggle(e.target.checked)} aria-label="Show the demo connection" />
        <span>
          <b>Show the demo connection</b>
          <br />
          <small className="muted">A built-in sample database to try dbui with, listed under Demo in the toolbar popup.</small>
        </span>
      </label>
    </section>
  );
}
