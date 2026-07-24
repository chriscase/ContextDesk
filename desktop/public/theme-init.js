/**
 * Pre-paint theme (#152 / #300). CSP-safe external script from 'self'.
 * Mirrors `cd-theme` localStorage + skin registry ids in `src/lib/skins.ts`.
 * Default dark when unset or unknown. Keep the allow-list in sync with SKINS.
 */
(function () {
  // Allow-list must match SkinId in desktop/src/lib/skins.ts
  var KNOWN = { dark: 1, light: 1, slate: 1, sand: 1, forest: 1 };
  var LIGHT = { light: 1, sand: 1 };
  var t = "dark";
  try {
    var stored = localStorage.getItem("cd-theme");
    if (stored && KNOWN[stored]) {
      t = stored;
    }
  } catch (_) {
    /* ignore */
  }
  document.documentElement.setAttribute("data-theme", t);
  // Immediate paint colors (before critical-boot.css / theme bundles).
  var bg = LIGHT[t] ? "#f4f5f7" : "#0b0c0e";
  if (t === "sand") bg = "#f3efe6";
  document.documentElement.style.backgroundColor = bg;
  document.documentElement.style.colorScheme = LIGHT[t] ? "light" : "dark";
  try {
    if (document.body) {
      document.body.style.backgroundColor = bg;
    }
  } catch (_) {
    /* ignore */
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
