// Runs before the first paint (classic script in <head>): sets <html data-theme> from the
// localStorage mirror of the Theme setting, so a Light choice doesn't flash dark. See src/app/lib/theme.ts.
(function () {
  var t = "dark";
  try {
    var v = localStorage.getItem("dbui.theme");
    if (v === "light" || v === "system" || v === "dark") t = v;
  } catch (e) {}
  document.documentElement.setAttribute("data-theme", t);
})();
