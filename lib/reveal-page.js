/**
 * Publieke onthul-pagina (digitale envelopkaartjes): teksten in 4 talen
 * en de HTML-renderer. Puur: (locale, title, inner, nextRevealMs) -> HTML.
 * Uit server.js gelicht als tranche 2 van de opsplitsing.
 */
'use strict';

const { escHtml } = require('./html');

// Teksten voor de publieke onthul-pagina, in de taal van de publicatie.
const REVEAL_T = {
  nl: { hello: 'Hoi', intro: 'Dit is jouw persoonlijke route. Elk volgend adres verschijnt zodra de vorige gang is afgelopen — net als bij de envelopjes.', youhost: 'Jij bent gastheer/vrouw!', address: 'Adres', host: 'Bij', mates: 'Tafelgenoten', locked: 'Wordt onthuld om', together: 'Iedereen komt hier samen', notfound: 'Route niet gevonden of niet meer beschikbaar.', autorefresh: 'Deze pagina ververst zichzelf op het onthulmoment.' },
  en: { hello: 'Hi', intro: 'This is your personal route. Each next address appears once the previous course has ended — just like the envelopes.', youhost: 'You are the host!', address: 'Address', host: 'At', mates: 'Tablemates', locked: 'Revealed at', together: 'Everyone gathers here', notfound: 'Route not found or no longer available.', autorefresh: 'This page refreshes itself at the reveal moment.' },
  es: { hello: 'Hola', intro: 'Esta es tu ruta personal. Cada nueva dirección aparece cuando termina el plato anterior — igual que con los sobres.', youhost: '¡Tú eres el anfitrión!', address: 'Dirección', host: 'En casa de', mates: 'Compañeros de mesa', locked: 'Se revela a las', together: 'Todos se reúnen aquí', notfound: 'Ruta no encontrada o ya no disponible.', autorefresh: 'Esta página se actualiza sola en el momento de la revelación.' },
  de: { hello: 'Hallo', intro: 'Das ist deine persönliche Route. Jede nächste Adresse erscheint, sobald der vorherige Gang beendet ist — genau wie bei den Umschlägen.', youhost: 'Du bist Gastgeber!', address: 'Adresse', host: 'Bei', mates: 'Tischnachbarn', locked: 'Wird enthüllt um', together: 'Alle kommen hier zusammen', notfound: 'Route nicht gefunden oder nicht mehr verfügbar.', autorefresh: 'Diese Seite aktualisiert sich zum Enthüllungszeitpunkt selbst.' },
};

function renderRevealPage(locale, title, inner, nextRevealMs) {
  const R = REVEAL_T[locale] || REVEAL_T.nl;
  const reloadScript = nextRevealMs
    ? `<script>setTimeout(function(){location.reload()}, Math.max(1000, ${nextRevealMs} - Date.now()) + 500);</script>`
    : '';
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow">
<title>${escHtml(title)}</title>
<link rel="icon" type="image/svg+xml" href="/images/runningdinner-logo.svg">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Plus Jakarta Sans',system-ui,sans-serif; background:#FFFBF7; color:#1E293B; padding:20px 16px 60px; }
  .wrap { max-width:520px; margin:0 auto; }
  .logo { display:block; margin:8px auto 24px; max-width:180px; }
  h1 { font-size:1.35rem; letter-spacing:-.01em; margin-bottom:4px; }
  .sub { color:#64748B; font-size:.9rem; margin-bottom:22px; line-height:1.55; }
  .card { background:#fff; border:1px solid #E2E8F0; border-radius:16px; padding:18px 20px; margin-bottom:14px; box-shadow:0 2px 10px rgba(0,0,0,.04); }
  .card.locked { background:#F8FAFC; border-style:dashed; }
  .course-head { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
  .course-head .icon { font-size:1.5rem; }
  .course-head .name { font-weight:800; font-size:1.05rem; }
  .course-head .time { margin-left:auto; color:#E85D3A; font-weight:700; font-size:.92rem; white-space:nowrap; }
  .detail { font-size:.92rem; line-height:1.6; color:#334155; }
  .detail b { color:#1E293B; }
  .lockmsg { display:flex; align-items:center; gap:8px; color:#94A3B8; font-size:.92rem; }
  .hostbadge { display:inline-block; background:#E85D3A; color:#fff; font-size:.72rem; font-weight:800; letter-spacing:.04em; padding:3px 10px; border-radius:100px; margin-bottom:8px; }
  .foot { text-align:center; color:#94A3B8; font-size:.78rem; margin-top:26px; }
  .foot a { color:#E85D3A; text-decoration:none; font-weight:600; }
</style>
</head>
<body>
<div class="wrap">
  <a href="/"><img class="logo" src="/images/runningdinner-logo-email.png" alt="runningdinner.app"></a>
  ${inner}
  <p class="foot">${nextRevealMs ? escHtml(R.autorefresh) + '<br>' : ''}<a href="/">runningdinner.app</a></p>
</div>
${reloadScript}
</body>
</html>`;
}

module.exports = { REVEAL_T, renderRevealPage };
