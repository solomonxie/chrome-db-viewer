// Workflows page (#workflows, DESIGN.md §3.15), opened from the toolbar popup's Workflows button:
// the same list as the left pane's Workflows tab, with New workflow and Import from file…,
// in a tab of its own. Each workflow opens in a new tab.

import { useEffect } from "react";
import { notifyCollectionsChanged } from "../../collections/store";
import { useToast } from "../components/ui";
import { WorkflowsList } from "./WorkflowsList";

export function WorkflowsPage() {
  const toast = useToast();
  // Workflows edited, run or deleted in other tabs show up when you come back to this one.
  useEffect(() => {
    const on = () => {
      if (document.visibilityState === "visible") notifyCollectionsChanged();
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  return (
    <div className="settings">
      <div className="settings-inner wf-page">
        <h1>Workflows</h1>
        <p className="muted">A workflow runs several steps in order, each using earlier results. Add one with +, or import a .dbui-workflow.json file.</p>
        <section>
          <WorkflowsList toast={toast} />
        </section>
      </div>
    </div>
  );
}
