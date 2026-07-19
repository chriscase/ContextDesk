/**
 * Pre-paint theme (#152 / #300). CSP-safe external script from 'self'.
 * Mirrors `cd-theme` localStorage + skin registry ids in `src/lib/skins.ts`.
 * Default dark when unset or unknown. Keep the allow-list in sync with SKINS.
 */
(function () {
  // Allow-list must match SkinId in desktop/src/lib/skins.ts
  var KNOWN = { dark: 1, light: 1, slate: 1, sand: 1, forest: 1 };
  try {
    var t = localStorage.getItem("cd-theme");
    if (!t || !KNOWN[t]) {
      t = "dark";
    }
    document.documentElement.setAttribute("data-theme", t);
  } catch (_) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
  // Platform class for chrome padding (macOS traffic-light inset, #153).
  try {
    var ua = navigator.userAgent || "";
    var plat = navigator.platform || "";
    if (/Mac/i.test(plat) || /Mac OS X/i.test(ua)) {
      document.documentElement.setAttribute("data-platform", "macos");
    }
  } catch (_) {
    /* ignore */
  }
})();
