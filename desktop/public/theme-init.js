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
})();
