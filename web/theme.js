'use strict';

(function () {
  const key = 'gh-arc-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    preference = window.localStorage.getItem(key) || 'system';
  } catch (err) {
    // Theme changes still work when browser storage is unavailable.
  }

  function apply() {
    document.documentElement.dataset.theme = preference === 'system'
      ? (system.matches ? 'dark' : 'light') : preference;
    document.querySelectorAll('[data-theme-select]').forEach((select) => {
      select.value = preference;
    });
  }

  // Run in the head so the saved theme is applied before the page paints.
  apply();
  system.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('change', (event) => {
    if (!event.target.matches('[data-theme-select]')) return;
    preference = event.target.value;
    apply();
    try {
      window.localStorage.setItem(key, preference);
    } catch (err) {
      // Keep the selected theme for this page even if it cannot be saved.
    }
  });
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) {
      preference = event.newValue || 'system';
      apply();
    }
  });
}());
