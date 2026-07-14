// Theme: dark by default, seeded from prefers-color-scheme on first load,
// then persisted to localStorage and applied via [data-theme] on <html>.
const KEY = "stoke-theme";

export function initialTheme() {
  let theme = null;
  try {
    theme = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  if (!theme) {
    theme =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  }
  return theme;
}

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage blocked */
  }
}

// Apply once at boot so there is no flash before React mounts.
export function initTheme() {
  const t = initialTheme();
  document.documentElement.setAttribute("data-theme", t);
  return t;
}
