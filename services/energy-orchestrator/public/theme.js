(() => {
  'use strict';
  const storageKey = 'energy-manager-theme';
  const system = window.matchMedia?.('(prefers-color-scheme: dark)');
  let preference = null;
  let button;
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch { /* Theme selection still works when browser storage is unavailable. */ }

  function apply() {
    const dark = preference ? preference === 'dark' : Boolean(system?.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101817' : '#f5f6f4');
    if (button) {
      button.setAttribute('aria-pressed', String(dark));
      button.title = dark ? 'Activer le mode clair' : 'Activer le mode sombre';
      document.getElementById('theme-label').textContent = dark ? 'Mode clair' : 'Mode sombre';
    }
  }

  // Run before the stylesheet to avoid a light flash on dark-mode reloads.
  apply();
  system?.addEventListener?.('change', () => { if (!preference) apply(); });

  function connectButton() {
    button = document.getElementById('theme-toggle');
    button.addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { window.localStorage.setItem(storageKey, preference); } catch { /* Keep the choice for this page. */ }
      apply();
    });
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connectButton, { once: true });
  else connectButton();
})();
