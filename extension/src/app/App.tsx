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

  useKeys({ "mod+shift+h": () => navigate({ name: "home" }) });

  useEffect(() => {
    document.title =
      route.name === "home" ? "dbui · Home" : route.name === "settings" ? "dbui · Settings" : route.name === "file" ? "dbui · File" : "dbui";
  }, [route]);

  let page;
  switch (route.name) {
    case "home":
      page = <Home />;
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
