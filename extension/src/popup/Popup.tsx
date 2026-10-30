// Toolbar popup: the saved connections, searchable, grouped like Home's picker. Clicking one
// (or Enter) opens it in a new tab and closes the popup. The footer opens Home or the
// new-connection form in the app tab (DESIGN.md §4.1).

import { useEffect, useMemo, useState } from "react";
import { groupConnections, subtitleOf } from "../app/components/ConnectionPicker";
import { EngineBadge, Highlight } from "../app/components/ui";
import { Icon } from "../app/components/Icon";
import { isDemo } from "../app/demo/demoDriver";
import { listConnections, openConnection, type SavedConnection } from "../app/lib/connections";
import { ENV_VAR } from "../app/lib/format";

/**
 * Brings up the app's Home tab: focuses one already on Home (or the bare app.html) and moves
 * it to `hash`, or opens a new tab. Tabs showing a connection or a file are left alone.
 */
export async function focusApp(hash: "#home" | "#home/new"): Promise<void> {
  const page = chrome.runtime.getURL("app.html");
  const tabs = await chrome.tabs.query({ url: page + "*" });
  const tab = tabs.find((t) => {
    const rest = (t.url ?? "").slice(page.length);
    return rest === "" || rest.startsWith("#home");
  });
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { active: true, url: page + hash });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: page + hash });
  }
}

export function Popup(props: { onDone?: () => void }) {
  const done = props.onDone ?? (() => window.close());
  const [conns, setConns] = useState<SavedConnection[] | null>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    void listConnections().then(setConns);
  }, []);

  const groups = useMemo(() => groupConnections(conns ?? [], q), [conns, q]);
  const flat = groups.flatMap((g) => g.conns);
  const showHeaders = groups.length > 1 || (groups[0] && groups[0].group !== "");

  const open = async (c: SavedConnection | undefined) => {
    if (!c) return;
    await openConnection(c);
    done();
  };
  const app = async (hash: "#home" | "#home/new") => {
    await focusApp(hash);
    done();
  };

  useEffect(() => {
    document.getElementById(`pop-opt-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.min(flat.length - 1, Math.max(0, i + d)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void open(flat[active]);
    }
  };

  let idx = -1;
  const row = (c: SavedConnection) => {
    idx += 1;
    const i = idx;
    return (
      <div
        key={c.id}
        id={`pop-opt-${i}`}
        role="option"
        aria-selected={i === active}
        className={"cpick-opt" + (i === active ? " on" : "")}
        style={{ ["--envc" as string]: ENV_VAR[c.env] }}
        onMouseEnter={() => setActive(i)}
        onClick={() => void open(c)}
        title={`Open ${c.name} in a new tab`}
      >
        <EngineBadge driver={c.driver} demo={isDemo(c)} />
        <span className="cpick-text">
          <span className="cpick-name">
            <Highlight text={c.name} needle={q.trim()} />
          </span>
          <small>
            <Highlight text={subtitleOf(c)} needle={q.trim()} />
          </small>
        </span>
        {c.readOnly && <span className="rotag">read-only</span>}
        <span className="cpick-env" title={c.env}>
          <span className="envdot" aria-hidden />
        </span>
      </div>
    );
  };

  return (
    <div className="pop">
      <div className="pop-search">
        <Icon name="search" className="ico" />
        <input
          role="combobox"
          aria-label="Connection"
          aria-expanded
          aria-controls="pop-list"
          aria-activedescendant={flat.length ? `pop-opt-${active}` : undefined}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder="Search connections…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div id="pop-list" role="listbox" aria-label="Connections" className="pop-list">
        {groups.map((g) =>
          showHeaders ? (
            <div key={g.group || "_"} role="group" aria-label={g.group || "Ungrouped"}>
              <div className="cpick-group" aria-hidden>
                {g.group || "Ungrouped"}
              </div>
              {g.conns.map(row)}
            </div>
          ) : (
            g.conns.map(row)
          ),
        )}
        {conns && flat.length === 0 && <div className="cpick-empty">No connection matches “{q.trim()}”.</div>}
      </div>
      <div className="pop-foot">
        <button className="btn ghost" onClick={() => void app("#home")}>
          <Icon name="home" /> Open app
        </button>
        <button className="btn ghost" onClick={() => void app("#home/new")}>
          <Icon name="plus" /> New connection
        </button>
      </div>
    </div>
  );
}
