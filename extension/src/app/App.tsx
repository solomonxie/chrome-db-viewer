import { useEffect, useState } from "react";
import { navigate, parseRoute, type Route } from "./lib/route";
import { useKeys } from "./lib/keys";
import { ToastProvider } from "./components/ui";
import { Home } from "./home/Home";
import { ConnectionTab } from "./conn/ConnectionTab";
import { FileSheet } from "./file/FileSheet";
import { Settings } from "./settings/Settings";
import { DownloadPrompt } from "./settings/DownloadPrompt";
import { ChainView } from "./chains/ChainView";
import { migrateSavedQueries } from "./collections/migrateSaved";
import { RestoreBanner, useRestoreOffer } from "./home/RestoreBanner";
import { startAutoBackup } from "./store/autoBackup";

function useRoute(): Route {
  const read = () => parseRoute(location.hash, location.search);
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    window.addEventListener("popstate", on);
    return () => {
      window.removeEventListener("hashchange", on);
      window.removeEventListener("popstate", on);
    };
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  // Bumped after a backup restore so Home reloads its lists.
  const [homeKey, setHomeKey] = useState(0);
  const restore = useRestoreOffer(route.name === "home");

  useKeys({ "mod+shift+h": () => navigate({ name: "home" }) });

  // Old "Saved" tab rows move into the "Saved queries" collection once; later runs find nothing to do.
  useEffect(() => {
    void migrateSavedQueries().catch(() => {});
  }, []);

  // Copies saved data to the runner a few seconds after each change (§3.16).
  useEffect(() => startAutoBackup(), []);

  useEffect(() => {
    document.title =
      route.name === "home" ? "dbui · Home" : route.name === "settings" ? "dbui · Settings" : route.name === "file" ? "dbui · File" : "dbui";
  }, [route]);

  let page;
  switch (route.name) {
    case "home":
      page = (
        <Home
          key={homeKey + (route.newConnection ? ":new" : "")}
          newConnection={route.newConnection}
          banner={
            restore.offer ? (
              <RestoreBanner
                offer={restore.offer}
                onDone={(restored) => {
                  restore.dismiss();
                  if (restored) setHomeKey((k) => k + 1);
                }}
              />
            ) : undefined
          }
        />
      );
      break;
    case "connection":
      page = <ConnectionTab key={route.connectionId} connectionId={route.connectionId} />;
      break;
    case "file":
      page = <FileSheet key={(route.src ?? "") + (route.fileHandleId ?? "")} src={route.src} fileHandleId={route.fileHandleId} />;
      break;
    case "settings":
      page = <Settings section={route.section} />;
      break;
    case "download-prompt":
      page = <DownloadPrompt downloadId={route.downloadId} />;
      break;
    case "chain":
      page = <ChainView key={route.chainId} chainId={route.chainId} />;
      break;
  }
  return <ToastProvider>{page}</ToastProvider>;
}
