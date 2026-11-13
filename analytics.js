// Privacy-friendly, cookieless analytics via GoatCounter (https://www.goatcounter.com).
// Setup: register a free site at goatcounter.com, then put your site code below.
// For https://brainsilencer.goatcounter.com the code is 'brainsilencer'.
// While GOATCOUNTER_CODE is empty, nothing is loaded and nothing is sent.
(() => {
  "use strict";
  const GOATCOUNTER_CODE = 'brainsilencer';

  window.bsTrack = () => {};
  if (!GOATCOUNTER_CODE) return;

  const host = location.hostname;
  const isLocal = !host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
  const doNotTrack = navigator.doNotTrack === '1' || window.doNotTrack === '1';
  if (isLocal || doNotTrack) return;

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://gc.zgo.at/count.js';
  script.dataset.goatcounter = `https://${GOATCOUNTER_CODE}.goatcounter.com/count`;
  document.head.appendChild(script);

  // Anonymous usage events only (e.g. "play", "timer-on"): no settings, no audio, no personal data.
  window.bsTrack = (name) => {
    try {
      if (window.goatcounter && typeof window.goatcounter.count === 'function') {
        window.goatcounter.count({ path: name, title: name, event: true });
      }
    } catch (error) { /* analytics must never break the app */ }
  };
})();
