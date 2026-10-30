// Browser preview (design/DESIGN.md §3.12). The background service worker (src/background/)
// calls syncPreviewRules and handleDownloadCreated; keep their signatures stable.

import { buildRules, corpRule, PREVIEW_RULE_IDS } from "./rules";
import type { PreviewSettings } from "./settings";

export * from "./settings";
export * from "./rules";
export * from "./src-param";
export * from "./media";
export {
  DOWNLOAD_PROMPT_PREFIX,
  decideDownloadPrompt,
  dismissDownloadPrompt,
  getPendingDownloadPrompt,
  handleDownloadCreated,
  localFileToOpen,
  openDownloadInDbui,
  viewerUrlFor,
  waitForDownloadComplete,
  type DownloadDecision,
  type PendingDownloadPrompt,
} from "./downloads";

/** The origins the redirect rules need. Granted at install (manifest host_permissions); only
 *  missing if the user restricted dbui's site access in Chrome, when Settings offers [Fix]. */
export const PREVIEW_ORIGINS = ["https://*/*", "http://*/*"];

export async function hasPreviewHostAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: PREVIEW_ORIGINS });
  } catch {
    return false;
  }
}

/** Replaces dbui's dynamic DNR rules to match the settings. The data-file redirect goes when
 *  disabled or when all-sites access hasn't been granted; the media viewer's CORP rule stays. */
export async function syncPreviewRules(settings: PreviewSettings): Promise<void> {
  const base = chrome.runtime.getURL("");
  const granted = settings.enabled ? await hasPreviewHostAccess() : false;
  const corp = corpRule(base);
  const addRules = [...(granted ? buildRules(settings, base) : []), ...(corp ? [corp] : [])];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: PREVIEW_RULE_IDS, addRules });
}
