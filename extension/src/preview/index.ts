// Browser preview (design/DESIGN.md §3.12). The background service worker (src/background/)
// calls syncPreviewRules and handleDownloadCreated; keep their signatures stable.

import { buildRules, PREVIEW_RULE_IDS } from "./rules";
import type { PreviewSettings } from "./settings";

export * from "./settings";
export * from "./rules";
export * from "./src-param";
export {
  DOWNLOAD_PROMPT_PREFIX,
  decideDownloadPrompt,
  dismissDownloadPrompt,
  getPendingDownloadPrompt,
  handleDownloadCreated,
  openDownloadInDbui,
  viewerUrlFor,
  waitForDownloadComplete,
  type DownloadDecision,
  type PendingDownloadPrompt,
} from "./downloads";

/** The origins the redirect rules need; requested when the user turns the feature on. */
export const PREVIEW_ORIGINS = ["https://*/*", "http://*/*"];

export async function hasPreviewHostAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: PREVIEW_ORIGINS });
  } catch {
    return false;
  }
}

/** Replaces dbui's dynamic DNR rules to match the settings. Removes them when disabled
 *  or when all-sites access hasn't been granted. */
export async function syncPreviewRules(settings: PreviewSettings): Promise<void> {
  const granted = settings.enabled ? await hasPreviewHostAccess() : false;
  const addRules = granted ? buildRules(settings, chrome.runtime.getURL("")) : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: PREVIEW_RULE_IDS, addRules });
}
