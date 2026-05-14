export function registerPwaServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // PWA install is additive; dashboard runtime should not fail if
      // the browser blocks registration or the app is served over HTTP.
    });
  });
}
