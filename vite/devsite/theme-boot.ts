// SPDX-License-Identifier: LGPL-3.0-or-later

/**
 * The theme before first paint on the developer pages: the same logic as the `#theme-boot` script in the player's
 * `index.html`, as text for an inline classic script. `src/ui/theme-boot.test.ts` runs both against the same cases.
 */
export const THEME_BOOT_SCRIPT = `
// The stored choice and the device decide; a copy of readThemeChoice, effectiveTheme and applyTheme in src/ui/theme.ts.
(function () {
var choice = 'auto';
try {
  var v = window.localStorage.getItem('bluray-web:theme');
  if (v === 'light' || v === 'dark') choice = v;
} catch (e) {}
var theme = choice === 'auto' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : choice;
var root = document.documentElement;
root.dataset.theme = theme;
root.style.colorScheme = theme;
var metas = document.querySelectorAll('meta[name="theme-color"]');
for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', theme === 'light' ? '#f6f8fe' : '#0a1330');
})();
`;
