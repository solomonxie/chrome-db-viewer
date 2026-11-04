// The page the toolbar popup opens for New connection (#new) and Edit (#edit/<id>). There is no
// Home page; this tab exists for the one form. Saving with Connect turns this tab into the
// connection; plain Save or Cancel closes it.

import { useEffect, useState } from "react";
import type { DriverId } from "@core/types";
import { isDemo } from "../demo/demoDriver";
import { listConnections, loadConnection, type SavedConnection } from "../lib/connections";
import type { FormState } from "../lib/connForm";
import { engine } from "../lib/driverForms";
import { closeThisTab, navigate } from "../lib/route";
import { ConnectionForm, EnginePicker } from "./NewConnection";

type Step =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "pick" }
  | { kind: "form"; driver: DriverId; prefill?: Partial<FormState>; existing?: SavedConnection };

export function ConnectionEditor(props: { connectionId?: string; driver?: string }) {
  const [step, setStep] = useState<Step>(() => {
    if (props.connectionId) return { kind: "loading" };
    const e = props.driver ? engine(props.driver) : undefined;
    return e?.available ? { kind: "form", driver: e.id as DriverId } : { kind: "pick" };
  });
  const [groups, setGroups] = useState<string[]>([]);

  useEffect(() => {
    void listConnections().then((cs) =>
      setGroups([...new Set(cs.map((c) => c.group).filter((g): g is string => !!g && g !== "Demo"))].sort()),
    );
    if (!props.connectionId) return;
    void loadConnection(props.connectionId).then((c) =>
      setStep(c && !isDemo(c) ? { kind: "form", driver: c.driver, existing: c } : { kind: "missing" }),
    );
  }, [props.connectionId]);

  useEffect(() => {
    document.title = step.kind === "form" && step.existing ? `Edit ${step.existing.name}` : "New connection";
  }, [step]);

  return (
    <div className="editor-page">
      {step.kind === "missing" && (
        <div className="empty">
          This connection no longer exists.{" "}
          <button className="btn" onClick={closeThisTab}>
            Close tab
          </button>
        </div>
      )}
      {step.kind === "pick" && (
        <EnginePicker onCancel={closeThisTab} onPick={(driver, prefill) => setStep({ kind: "form", driver, prefill })} />
      )}
      {step.kind === "form" && (
        <ConnectionForm
          driver={step.driver}
          prefill={step.prefill}
          existing={step.existing}
          groups={groups}
          onCancel={step.existing ? closeThisTab : () => setStep({ kind: "pick" })}
          onSaved={(c, connect) => {
            if (connect) navigate({ name: "connection", connectionId: c.id });
            else closeThisTab();
          }}
        />
      )}
    </div>
  );
}
