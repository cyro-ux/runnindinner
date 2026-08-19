/**
 * Branded foutpagina (404/500) in 4 talen. Puur: (status, locale) -> HTML.
 * Uit server.js gelicht als tranche 3 van de opsplitsing.
 */
'use strict';

// Helper: branded error page (HTML). Used for both 404 and 500.
function renderErrorPage(status, locale) {
  const L = {
    nl: {
      title: status === 404 ? 'Pagina niet gevonden' : 'Er ging iets mis',
      heading: status === 404 ? 'Deze pagina bestaat niet' : 'Er ging iets mis aan onze kant',
      sub: status === 404
        ? 'De link is mogelijk verouderd of verkeerd getypt. Via de knop hieronder kun je weer verder.'
        : 'We hebben een melding ontvangen en kijken er zo snel mogelijk naar. Probeer het over een paar minuten opnieuw.',
      cta: '← Terug naar de homepage',
      blog: 'Of lees een blogartikel',
    },
    en: {
      title: status === 404 ? 'Page not found' : 'Something went wrong',
      heading: status === 404 ? 'This page does not exist' : 'Something went wrong on our end',
      sub: status === 404
        ? 'The link may be outdated or mistyped. Use the button below to get back on track.'
        : 'We\u2019ve logged the error and will look into it. Please try again in a few minutes.',
      cta: '\u2190 Back to the homepage',
      blog: 'Or read a blog post',
    },
    es: {
      title: status === 404 ? 'P\u00E1gina no encontrada' : 'Algo ha ido mal',
      heading: status === 404 ? 'Esta p\u00E1gina no existe' : 'Algo ha ido mal por nuestra parte',
      sub: status === 404
        ? 'El enlace puede estar desactualizado o mal escrito. Usa el bot\u00F3n siguiente para continuar.'
        : 'Hemos registrado el error y lo revisaremos. Vuelve a intentarlo en unos minutos.',
      cta: '\u2190 Volver al inicio',
      blog: 'O lee un art\u00EDculo del blog',
    },
  }[locale] || null;
  const l = L || { title: 'Error', heading: 'Error', sub: '', cta: 'Home', blog: 'Blog' };
  const homeHref = locale === 'nl' ? '/' : '/' + locale + '/';
  const blogHref = locale === 'nl' ? '/blog' : '/' + locale + '/blog';
  const emoji = status === 404 ? '\uD83D\uDDFA\uFE0F' : '\u26A0\uFE0F';
  return `<!DOCTYPE html>
<html lang="${locale || 'nl'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>${status} \u2014 ${l.title} | Running Dinner Planner</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap">
<style>
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;min-height:100vh;font-family:'Plus Jakarta Sans',system-ui,sans-serif;color:#1E293B;background:linear-gradient(135deg,#FFFBF7 0%,#FFF4ED 100%)}
  .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 20px}
  .card{max-width:520px;width:100%;background:#fff;border-radius:20px;padding:48px 40px;box-shadow:0 8px 40px rgba(0,0,0,.08);text-align:center}
  .emoji{font-size:3.5rem;margin-bottom:8px}
  .status{font-size:3rem;font-weight:800;color:#E85D3A;letter-spacing:-.02em;margin:0 0 8px}
  h1{font-size:1.5rem;margin:0 0 12px;color:#1E293B;font-weight:700;letter-spacing:-.01em}
  p{color:#64748B;line-height:1.6;margin:0 0 28px}
  .btn{display:inline-block;background:#E85D3A;color:#fff;padding:12px 24px;border-radius:10px;font-weight:700;text-decoration:none;box-shadow:0 4px 16px rgba(232,93,58,.25);transition:transform .15s}
  .btn:hover{transform:translateY(-1px)}
  .secondary{display:block;margin-top:16px;color:#64748B;font-size:.9rem;text-decoration:none}
  .secondary:hover{color:#E85D3A}
  .brand{margin-top:32px;color:#94A3B8;font-size:.82rem}
  .brand a{color:#94A3B8;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="emoji">${emoji}</div>
    <div class="status">${status}</div>
    <h1>${l.heading}</h1>
    <p>${l.sub}</p>
    <a class="btn" href="${homeHref}">${l.cta}</a>
    <a class="secondary" href="${blogHref}">${l.blog} \u2192</a>
    <div class="brand">\uD83C\uDF7D\uFE0F <a href="${homeHref}">Running Dinner Planner</a></div>
  </div>
</div>
</body>
</html>`;
}

// Sentry error-reporter (no-op zonder SENTRY_DSN). Plaats VÓÓR de eigen
// error-handler zodat alle niet-afgehandelde errors worden gerapporteerd.

module.exports = { renderErrorPage };
