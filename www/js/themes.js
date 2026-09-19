// ---------------------------------------------------------------------------
// Theme registry — adding a new theme later is: drop a themes/<id>.css file
// (see themes/starfield.css for the pattern), add one entry below, and add
// its <link> tag in index.html. Nothing else in the app needs to change.
// ---------------------------------------------------------------------------

const THEME_REGISTRY = {
  default: {
    name: "Default",
    // Colors shown in the Settings swatch preview (not applied directly —
    // the actual palette lives in css/themes/default.css).
    swatch: ["#0a0e18", "#3b82f6", "#8b5cf6"],
    background: null,
  },
  starfield: {
    name: "Space",
    swatch: ["#090a0f", "#60a5fa", "#5eead4"],
    background: `
      <div class="starfield-container">
        <div id="stars"></div>
        <div id="stars2"></div>
        <div id="stars3"></div>
      </div>
    `,
  },
};

const THEME_STORAGE_KEY = "schedule_theme";

function getSavedTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  return THEME_REGISTRY[saved] ? saved : "default";
}

function applyTheme(themeId) {
  const id = THEME_REGISTRY[themeId] ? themeId : "default";
  document.documentElement.dataset.theme = id;
  const bgContainer = document.getElementById("themeBackground");
  if (bgContainer) bgContainer.innerHTML = THEME_REGISTRY[id].background || "";
  localStorage.setItem(THEME_STORAGE_KEY, id);
  renderThemeSwatches();
}

function renderThemeSwatches() {
  const container = document.getElementById("themeSwatches");
  if (!container) return;
  const active = getSavedTheme();

  container.innerHTML = "";
  Object.entries(THEME_REGISTRY).forEach(([id, theme]) => {
    const [c1, c2, c3] = theme.swatch;
    const btn = document.createElement("button");
    btn.className = `theme-swatch ${id === active ? "active" : ""}`;
    btn.setAttribute("aria-label", theme.name);
    btn.innerHTML = `
      <span class="theme-swatch-preview" style="background: linear-gradient(135deg, ${c1} 0%, ${c1} 45%, ${c2} 45%, ${c2} 72%, ${c3} 72%, ${c3} 100%)"></span>
      <span class="theme-swatch-name">${theme.name}</span>
    `;
    btn.addEventListener("click", () => applyTheme(id));
    container.appendChild(btn);
  });
}

function initTheme() {
  applyTheme(getSavedTheme());
}