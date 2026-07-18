/**
 * Pre-paint theme (#152). CSP-safe external script from 'self'.
 * Mirrors loadTheme() key `cd-theme` in useShellState; default dark when unset.
 * Must run before the module bundle so light users never flash dark.
 */
(function () {
  try {
    var t = localStorage.getItem("cd-theme");
    if (t !== "light" && t !== "dark") {
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
