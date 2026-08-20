// Herlaadt de onthul-pagina op het moment dat de volgende gang onthuld
// wordt. Het tijdstip staat in data-reveal-at op de eigen script-tag;
// zonder dat attribuut doet dit script niets.
(function () {
  'use strict';
  var el = document.currentScript;
  var at = el ? parseInt(el.dataset.revealAt || '', 10) : NaN;
  if (!at || isNaN(at)) return;
  setTimeout(function () { location.reload(); }, Math.max(1000, at - Date.now()) + 500);
})();
