/**
 * Content- en SEO-routes: sitemap.xml, de /en-, /es- en /de-taalvarianten
 * van de publieke pagina's, de bij mount gebouwde Duitse homepage-variant,
 * de blog (4 talen) en de segment-landingspagina's.
 *
 * ROOT is de repo-root (geïnjecteerd): __dirname zou hier routes/ zijn.
 * Factory met dependency-injection (tranche 9).
 */
'use strict';

const express = require('express');
const { asyncHandler } = require('../lib/async-handler');

module.exports = function pagesRoutes(deps) {
  const { ROOT, fs, path, blog, SUPPORTED_LANGS } = deps;
  const router = express.Router();

// ── Sitemap ──────────────────────────────────────────────────────────────────
router.get('/sitemap.xml', (req, res) => {
  const base = 'https://runningdinner.app';
  const today = new Date().toISOString().split('T')[0];

  // Static marketing pages: a fixed lastmod stops Google from seeing
  // "everything changed" on each deploy. Bump this date only when the
  // visible content on these pages is meaningfully changed.
  const STATIC_LASTMOD = '2026-04-21';

  // Pages with NL + EN + ES + DE alternates
  const multilingualPages = [
    { nl: '/',                   en: '/en/',                   es: '/es/',                   de: '/de/',                   priority: '1.0', changefreq: 'weekly' },
    { nl: '/login.html',         en: '/en/login.html',         es: '/es/login.html',         de: '/de/login.html',         priority: '0.6', changefreq: 'monthly' },
    { nl: '/register.html',      en: '/en/register.html',      es: '/es/register.html',      de: '/de/register.html',      priority: '0.7', changefreq: 'monthly' },
    { nl: '/subscribe.html',     en: '/en/subscribe.html',     es: '/es/subscribe.html',     de: '/de/subscribe.html',     priority: '0.7', changefreq: 'monthly' },
    // Segment-landingspagina's (SEO-kritiek voor long-tail keywords per doelgroep)
    { nl: '/service-clubs',      en: '/en/service-clubs',      es: '/es/service-clubs',      de: '/de/service-clubs',      priority: '0.9', changefreq: 'monthly' },
    { nl: '/verenigingen',       en: '/en/verenigingen',       es: '/es/verenigingen',       de: '/de/verenigingen',       priority: '0.9', changefreq: 'monthly' },
    { nl: '/vriendengroepen',    en: '/en/vriendengroepen',    es: '/es/vriendengroepen',    de: '/de/vriendengroepen',    priority: '0.9', changefreq: 'monthly' },
  ];

  const hreflangBlock = (page) => `
    <xhtml:link rel="alternate" hreflang="nl" href="${base}${page.nl}"/>
    <xhtml:link rel="alternate" hreflang="en" href="${base}${page.en}"/>
    <xhtml:link rel="alternate" hreflang="es" href="${base}${page.es}"/>
    <xhtml:link rel="alternate" hreflang="de" href="${base}${page.de}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${base}${page.nl}"/>`;

  let urls = '';
  for (const page of multilingualPages) {
    for (const lang of ['nl', 'en', 'es', 'de']) {
      urls += `
  <url>
    <loc>${base}${page[lang]}</loc>
    <lastmod>${STATIC_LASTMOD}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>${hreflangBlock(page)}
  </url>`;
    }
  }

  // Blog index — listing itself barely changes; posts are separately timestamped
  urls += `
  <url><loc>${base}/blog</loc><lastmod>${STATIC_LASTMOD}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`;
  for (const lang of ['nl', 'en', 'es', 'de']) {
    for (const post of blog.listPublished(lang)) {
      const path = lang === 'nl' ? `/blog/${post.slug}` : `/${lang}/blog/${post.slug}`;
      const lastmod = post.date || today;
      urls += `
  <url>
    <loc>${base}${path}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`;
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}
</urlset>`;

  res.type('application/xml').send(xml);
});

// ── English route handling (/en/*) ──────────────────────────────────────────

// Build English homepage variant at startup (cached in memory for SEO)
const homeHtmlPath = path.join(ROOT, 'public', 'home.html');
let homeHtmlEN = null;
try {
  let html = fs.readFileSync(homeHtmlPath, 'utf8');

  // 1. <html lang="nl"> → <html lang="en">
  html = html.replace('<html lang="nl">', '<html lang="en">');

  // 2. <title>
  html = html.replace(
    /<title>[^<]+<\/title>/,
    '<title>Organize a Running Dinner – The Easiest Planner | Running Dinner Planner</title>'
  );

  // 3. <meta name="description">
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    '<meta name="description" content="Built by an organiser, for organisers. From spreadsheet chaos to planning in minutes. Subscription only €5 per year.">'
  );

  // 4. <meta name="keywords">
  html = html.replace(
    /<meta name="keywords" content="[^"]*">/,
    '<meta name="keywords" content="running dinner organise, running dinner planner, progressive dinner, dinner party planner, running dinner tool, running dinner app">'
  );

  // 5. canonical
  html = html.replace(
    /<link rel="canonical" href="https:\/\/runningdinner\.app\/">/,
    '<link rel="canonical" href="https://runningdinner.app/en/">'
  );

  // 6. Open Graph
  html = html.replace(
    /<meta property="og:url" content="https:\/\/runningdinner\.app\/">/,
    '<meta property="og:url" content="https://runningdinner.app/en/">'
  );
  html = html.replace(
    /<meta property="og:title" content="[^"]*">/,
    '<meta property="og:title" content="Running Dinner Planner – From spreadsheet chaos to planning in minutes">'
  );
  html = html.replace(
    /<meta property="og:description" content="[^"]*">/,
    '<meta property="og:description" content="Built by an organiser, for organisers. Everything I ran into is now built in as standard.">'
  );

  // 7. Twitter Card
  html = html.replace(
    /<meta name="twitter:title" content="[^"]*">/,
    '<meta name="twitter:title" content="Running Dinner Planner – From spreadsheet chaos to planning in minutes">'
  );
  html = html.replace(
    /<meta name="twitter:description" content="[^"]*">/,
    '<meta name="twitter:description" content="Built by an organiser. Everything I ran into is now built in as standard. €5 per year.">'
  );

  // 8. Schema.org SoftwareApplication
  html = html.replace(
    '"description": "Organiseer een running dinner moeiteloos. Plan routes, wijs tafels toe en druk enveloppen af."',
    '"description": "Organize a running dinner effortlessly. Plan routes, assign tables and print envelopes."'
  );
  html = html.replace(
    '"url": "https://runningdinner.app/"',
    '"url": "https://runningdinner.app/en/"'
  );
  html = html.replace(
    '"description": "1 jaar abonnement"',
    '"description": "1 year subscription"'
  );

  // 9. FAQ structured data
  html = html.replace(
    '"name": "Wat is een running dinner?"',
    '"name": "What is a running dinner?"'
  );
  html = html.replace(
    '"text": "Een running dinner (ook wel lopend diner of diner en route) is een sociaal evenement waarbij deelnemers elke gang van het diner bij een andere gastheer eten. Zo ontmoet iedereen nieuwe mensen."',
    '"text": "A running dinner (also known as a progressive dinner) is a social event where participants eat each course of the dinner at a different host\'s home. This way everyone meets new people."'
  );
  html = html.replace(
    '"name": "Hoe werkt de Running Dinner Planner?"',
    '"name": "How does the Running Dinner Planner work?"'
  );
  html = html.replace(
    '"text": "Je voert deelnemers in, configureert de gangenstructuur en de planner wijst automatisch tafels en routes toe zodat iedereen zoveel mogelijk nieuwe tafelgenoten ontmoet. Daarna druk je de envelop-kaartjes af."',
    '"text": "You enter participants, configure the course structure and the planner automatically assigns tables and routes so everyone meets as many new tablemates as possible. Then you print the envelope cards."'
  );
  html = html.replace(
    '"name": "Hoeveel kost de Running Dinner Planner?"',
    '"name": "How much does the Running Dinner Planner cost?"'
  );
  html = html.replace(
    '"text": "Het abonnement kost slechts €5 per jaar. Je kunt daarmee onbeperkt evenementen organiseren."',
    '"text": "The subscription costs only €5 per year. You can organize unlimited events with it."'
  );

  // Demo-link wijzen naar de Engelse demo zodat de demo in de juiste taal start
  html = html.replace(/href="\/demo"/g, 'href="/en/demo"');
  // Segment-landingspagina's taal-prefixen (Voor wie?-sectie + footer)
  html = html.replace(/href="\/(verenigingen|service-clubs|vriendengroepen)"/g, 'href="/en/$1"');

  homeHtmlEN = html;
  console.log('[boot] English homepage SEO variant generated');
} catch (e) {
  console.warn('[boot] Could not generate English homepage variant:', e.message);
}

// Build Spanish homepage variant at startup (cached in memory for SEO)
let homeHtmlES = null;
try {
  let html = fs.readFileSync(homeHtmlPath, 'utf8');

  // 1. <html lang>
  html = html.replace('<html lang="nl">', '<html lang="es">');

  // 2. <title>
  html = html.replace(
    /<title>[^<]+<\/title>/,
    '<title>Organiza una Cena Itinerante – El Planificador más Sencillo | Running Dinner Planner</title>'
  );

  // 3. <meta description>
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    '<meta name="description" content="Creado por un organizador, para organizadores. Del caos de hojas de cálculo a la planificación en minutos. Suscripción de solo €5 al año.">'
  );

  // 4. keywords
  html = html.replace(
    /<meta name="keywords" content="[^"]*">/,
    '<meta name="keywords" content="cena itinerante, cena progresiva, organizar cena itinerante, planificador cenas, running dinner español, herramienta cena itinerante">'
  );

  // 5. canonical
  html = html.replace(
    /<link rel="canonical" href="https:\/\/runningdinner\.app\/">/,
    '<link rel="canonical" href="https://runningdinner.app/es/">'
  );

  // 6. Open Graph
  html = html.replace(
    /<meta property="og:url" content="https:\/\/runningdinner\.app\/">/,
    '<meta property="og:url" content="https://runningdinner.app/es/">'
  );
  html = html.replace(
    /<meta property="og:title" content="[^"]*">/,
    '<meta property="og:title" content="Running Dinner Planner – Del caos de hojas de cálculo a la planificación en minutos">'
  );
  html = html.replace(
    /<meta property="og:description" content="[^"]*">/,
    '<meta property="og:description" content="Creado por un organizador, para organizadores. Todo con lo que me topé ya está integrado.">'
  );

  // 7. Twitter Card
  html = html.replace(
    /<meta name="twitter:title" content="[^"]*">/,
    '<meta name="twitter:title" content="Running Dinner Planner – Del caos a la planificación en minutos">'
  );
  html = html.replace(
    /<meta name="twitter:description" content="[^"]*">/,
    '<meta name="twitter:description" content="Creado por un organizador. Todo lo que necesitas está integrado. €5 al año.">'
  );

  // 8. Schema.org SoftwareApplication
  html = html.replace(
    '"description": "Organiseer een running dinner moeiteloos. Plan routes, wijs tafels toe en druk enveloppen af."',
    '"description": "Organiza una cena itinerante sin esfuerzo. Planifica rutas, asigna mesas e imprime sobres."'
  );
  html = html.replace(
    '"url": "https://runningdinner.app/"',
    '"url": "https://runningdinner.app/es/"'
  );
  html = html.replace(
    '"description": "1 jaar abonnement"',
    '"description": "Suscripción de 1 año"'
  );

  // 9. FAQ structured data
  html = html.replace(
    '"name": "Wat is een running dinner?"',
    '"name": "¿Qué es una cena itinerante?"'
  );
  html = html.replace(
    '"text": "Een running dinner (ook wel lopend diner of diner en route) is een sociaal evenement waarbij deelnemers elke gang van het diner bij een andere gastheer eten. Zo ontmoet iedereen nieuwe mensen."',
    '"text": "Una cena itinerante (también llamada cena progresiva) es un evento social donde los participantes cenan cada plato en casa de un anfitrión diferente. Así todos conocen a gente nueva."'
  );
  html = html.replace(
    '"name": "Hoe werkt de Running Dinner Planner?"',
    '"name": "¿Cómo funciona el Running Dinner Planner?"'
  );
  html = html.replace(
    '"text": "Je voert deelnemers in, configureert de gangenstructuur en de planner wijst automatisch tafels en routes toe zodat iedereen zoveel mogelijk nieuwe tafelgenoten ontmoet. Daarna druk je de envelop-kaartjes af."',
    '"text": "Introduces a los participantes, configuras la estructura de los platos y el planificador asigna automáticamente mesas y rutas para que todos conozcan al máximo de nuevos compañeros de mesa. Después imprimes los sobres."'
  );
  html = html.replace(
    '"name": "Hoeveel kost de Running Dinner Planner?"',
    '"name": "¿Cuánto cuesta el Running Dinner Planner?"'
  );
  html = html.replace(
    '"text": "Het abonnement kost slechts €5 per jaar. Je kunt daarmee onbeperkt evenementen organiseren."',
    '"text": "La suscripción cuesta solo €5 al año. Con ella puedes organizar eventos de forma ilimitada."'
  );

  // Demo-link wijzen naar de Spaanse demo
  html = html.replace(/href="\/demo"/g, 'href="/es/demo"');
  // Segment-landingspagina's taal-prefixen (Voor wie?-sectie + footer)
  html = html.replace(/href="\/(verenigingen|service-clubs|vriendengroepen)"/g, 'href="/es/$1"');

  homeHtmlES = html;
  console.log('[boot] Spanish homepage SEO variant generated');
} catch (e) {
  console.warn('[boot] Could not generate Spanish homepage variant:', e.message);
}

// ── German homepage SEO variant (built at boot, cached in memory) ──────────
let homeHtmlDE = null;
try {
  let html = fs.readFileSync(homeHtmlPath, 'utf8');

  // 1. <html lang>
  html = html.replace('<html lang="nl">', '<html lang="de">');

  // 2. <title>
  html = html.replace(
    /<title>[^<]+<\/title>/,
    '<title>Running Dinner organisieren – Der einfachste Planer | Running Dinner Planner</title>'
  );

  // 3. <meta description>
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    '<meta name="description" content="Von einem Organisator für Organisatoren entwickelt. Vom Tabellenchaos zur fertigen Planung in Minuten. Abonnement für nur €5 pro Jahr.">'
  );

  // 4. keywords
  html = html.replace(
    /<meta name="keywords" content="[^"]*">/,
    '<meta name="keywords" content="running dinner, laufendes dinner, progressive dinner, running dinner organisieren, running dinner planen, running dinner app">'
  );

  // 5. canonical
  html = html.replace(
    /<link rel="canonical" href="https:\/\/runningdinner\.app\/">/,
    '<link rel="canonical" href="https://runningdinner.app/de/">'
  );

  // 6. Open Graph
  html = html.replace(
    /<meta property="og:url" content="https:\/\/runningdinner\.app\/">/,
    '<meta property="og:url" content="https://runningdinner.app/de/">'
  );
  html = html.replace(
    /<meta property="og:title" content="[^"]*">/,
    '<meta property="og:title" content="Running Dinner Planner – Vom Tabellenchaos zur Planung in Minuten">'
  );
  html = html.replace(
    /<meta property="og:description" content="[^"]*">/,
    '<meta property="og:description" content="Von einem Organisator für Organisatoren. Alles, worüber ich stolperte, ist bereits integriert.">'
  );

  // 7. Twitter Card
  html = html.replace(
    /<meta name="twitter:title" content="[^"]*">/,
    '<meta name="twitter:title" content="Running Dinner Planner – Vom Chaos zur Planung in Minuten">'
  );
  html = html.replace(
    /<meta name="twitter:description" content="[^"]*">/,
    '<meta name="twitter:description" content="Von einem Organisator entwickelt. Alles, was Sie brauchen, ist integriert. €5 pro Jahr.">'
  );

  // 8. Schema.org SoftwareApplication
  html = html.replace(
    '"description": "Organiseer een running dinner moeiteloos. Plan routes, wijs tafels toe en druk enveloppen af."',
    '"description": "Organisieren Sie ein Running Dinner mühelos. Planen Sie Routen, weisen Sie Tische zu und drucken Sie Umschläge."'
  );
  html = html.replace(
    '"url": "https://runningdinner.app/"',
    '"url": "https://runningdinner.app/de/"'
  );
  html = html.replace(
    '"description": "1 jaar abonnement"',
    '"description": "1 Jahr Abonnement"'
  );

  // 9. FAQ structured data
  html = html.replace(
    '"name": "Wat is een running dinner?"',
    '"name": "Was ist ein Running Dinner?"'
  );
  html = html.replace(
    '"text": "Een running dinner (ook wel lopend diner of diner en route) is een sociaal evenement waarbij deelnemers elke gang van het diner bij een andere gastheer eten. Zo ontmoet iedereen nieuwe mensen."',
    '"text": "Ein Running Dinner (auch Laufendes Dinner oder Progressive Dinner genannt) ist eine gesellige Veranstaltung, bei der die Teilnehmer jeden Gang bei einem anderen Gastgeber einnehmen. So lernen alle neue Leute kennen."'
  );
  html = html.replace(
    '"name": "Hoe werkt de Running Dinner Planner?"',
    '"name": "Wie funktioniert der Running Dinner Planner?"'
  );
  html = html.replace(
    '"text": "Je voert deelnemers in, configureert de gangenstructuur en de planner wijst automatisch tafels en routes toe zodat iedereen zoveel mogelijk nieuwe tafelgenoten ontmoet. Daarna druk je de envelop-kaartjes af."',
    '"text": "Sie geben Teilnehmer ein, konfigurieren die Gangstruktur, und der Planer weist automatisch Tische und Routen zu, sodass jeder so viele neue Tischgäste wie möglich trifft. Anschließend drucken Sie die Umschlag-Karten."'
  );
  html = html.replace(
    '"name": "Hoeveel kost de Running Dinner Planner?"',
    '"name": "Wie viel kostet der Running Dinner Planner?"'
  );
  html = html.replace(
    '"text": "Het abonnement kost slechts €5 per jaar. Je kunt daarmee onbeperkt evenementen organiseren."',
    '"text": "Das Abonnement kostet nur €5 pro Jahr. Damit können Sie unbegrenzt Events organisieren."'
  );

  // Demo-link wijzen naar de Duitse demo
  html = html.replace(/href="\/demo"/g, 'href="/de/demo"');
  // Segment-landingspagina's taal-prefixen (Voor wie?-sectie + footer)
  html = html.replace(/href="\/(verenigingen|service-clubs|vriendengroepen)"/g, 'href="/de/$1"');

  homeHtmlDE = html;
  console.log('[boot] German homepage SEO variant generated');
} catch (e) {
  console.warn('[boot] Could not generate German homepage variant:', e.message);
}

// Serve English homepage with SEO-optimized <head>
router.get('/en/app', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
router.get(['/en', '/en/'], (req, res) => {
  if (homeHtmlEN) {
    res.type('html').send(homeHtmlEN);
  } else {
    res.sendFile(homeHtmlPath);
  }
});
router.get('/en/:page.html', (req, res) => {
  const file = path.join(ROOT, 'public', `${req.params.page}.html`);
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).sendFile(homeHtmlPath);
  }
});

// Serve Spanish homepage with SEO-optimized <head>
router.get('/es/app', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
router.get(['/es', '/es/'], (req, res) => {
  if (homeHtmlES) {
    res.type('html').send(homeHtmlES);
  } else {
    res.sendFile(homeHtmlPath);
  }
});
router.get('/es/:page.html', (req, res) => {
  const file = path.join(ROOT, 'public', `${req.params.page}.html`);
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).sendFile(homeHtmlPath);
  }
});

// Serve German homepage with SEO-optimized <head>
router.get('/de/app', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
router.get(['/de', '/de/'], (req, res) => {
  if (homeHtmlDE) {
    res.type('html').send(homeHtmlDE);
  } else {
    res.sendFile(homeHtmlPath);
  }
});
router.get('/de/:page.html', (req, res) => {
  const file = path.join(ROOT, 'public', `${req.params.page}.html`);
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).sendFile(homeHtmlPath);
  }
});

// ── Blog (preview: drafts zijn niet in de publieke listing) ─────────────────
const BLOG_STYLE = `
  .blog-page { max-width: 780px; margin: 50px auto; padding: 0 20px; font-family: 'Plus Jakarta Sans', system-ui, sans-serif; color: #1E293B; }
  .blog-page h1 { font-size: 2.2rem; letter-spacing: -.02em; margin-bottom: 10px; }
  .blog-page h2 { font-size: 1.4rem; margin: 32px 0 12px; }
  .blog-page h3 { font-size: 1.1rem; margin: 22px 0 8px; font-weight: 700; }
  .blog-page p, .blog-page li { font-size: 1rem; line-height: 1.7; color: #334155; }
  .blog-page ul { margin: 10px 0 10px 22px; }
  .blog-page a { color: #E85D3A; }
  .blog-page code { background: #F1F5F9; padding: 2px 6px; border-radius: 4px; font-size: .88em; }
  .blog-page pre { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; overflow-x: auto; }
  .blog-meta { color: #94A3B8; font-size: .9rem; margin-bottom: 28px; border-bottom: 1px solid #F1F5F9; padding-bottom: 18px; }
  .blog-nav { margin-bottom: 20px; font-size: .9rem; }
  .blog-nav a { color: #64748B; text-decoration: none; }
  .blog-nav a:hover { color: #E85D3A; }
  .blog-list-item { padding: 24px 0; border-bottom: 1px solid #F1F5F9; }
  .blog-list-item a { color: #1E293B; text-decoration: none; }
  .blog-list-item h3 { font-size: 1.2rem; margin-bottom: 6px; }
  .blog-list-item .desc { color: #64748B; font-size: .95rem; }
  .blog-draft-badge { background: #FEF3C7; color: #92400E; padding: 2px 8px; border-radius: 4px; font-size: .72rem; margin-left: 8px; font-weight: 600; }
  .blog-page table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: .94rem; }
  .blog-page th, .blog-page td { border: 1px solid #E2E8F0; padding: 8px 12px; text-align: left; vertical-align: top; }
  .blog-page th { background: #F8FAFC; font-weight: 600; }
  .blog-page tr:nth-child(even) td { background: #FCFCFD; }
  .blog-page hr { border: none; border-top: 1px solid #E2E8F0; margin: 28px 0; }
  .blog-page li.task { list-style: none; margin-left: -20px; }
  .blog-page li.task input[type=checkbox] { margin-right: 8px; }
  .blog-header { max-width: 780px; margin: 32px auto 0; padding: 0 20px; }
  .blog-header a { display: inline-block; text-decoration: none; }
  .blog-header img { display: block; height: auto; max-width: 200px; }
  .blog-page { margin-top: 24px; }
  .blog-related { max-width: 780px; margin: 48px auto 60px; padding: 24px; background: #FFFBF7; border-radius: 12px; border: 1px solid #FDE5D0; }
  .blog-related h2 { font-size: 1.15rem; margin: 0 0 16px; color: #1E293B; }
  .blog-related ul { list-style: none; margin: 0; padding: 0; }
  .blog-related li { padding: 10px 0; border-bottom: 1px solid #FDE5D0; }
  .blog-related li:last-child { border-bottom: none; }
  .blog-related li a { color: #E85D3A; font-weight: 600; text-decoration: none; font-size: .98rem; }
  .blog-related li a:hover { text-decoration: underline; }
  .blog-related .related-desc { color: #64748B; font-size: .88rem; font-weight: 400; line-height: 1.5; display: inline-block; margin-top: 2px; }
`;

function renderBlogShell(title, content, locale, opts = {}) {
  const headerLinks = `<a href="/">← ${locale === 'en' ? 'Back to home' : locale === 'es' ? 'Volver al inicio' : locale === 'de' ? 'Zurück zur Startseite' : 'Terug naar home'}</a>`;
  const robots = opts.noindex
    ? '<meta name="robots" content="noindex,nofollow">'
    : '<meta name="robots" content="index,follow">';
  const descMeta = opts.description
    ? `<meta name="description" content="${opts.description.replace(/"/g, '&quot;')}">`
    : '';
  const canonical = opts.canonical
    ? `<link rel="canonical" href="${opts.canonical}">`
    : '';
  // Logo-URL is taal-agnostisch; op niet-NL serves wordt het bestand
  // via /en|/es|/de-prefix static mount bereikt, maar direct pad werkt altijd.
  const logoHeader = `<header class="blog-header"><a href="/" aria-label="runningdinner.app"><img src="/images/runningdinner-logo-email.png" alt="runningdinner.app" width="200" height="50"></a></header>`;

  // Helper: locale → og:locale code
  const ogLocaleCode = locale === 'nl' ? 'nl_NL' : locale === 'en' ? 'en_GB' : locale === 'es' ? 'es_ES' : locale === 'de' ? 'de_DE' : 'nl_NL';

  // BlogPosting JSON-LD voor rich snippets (datum, auteur, leestijd) in
  // Google search-resultaten. Alleen genereren voor ECHTE posts
  // (opts.post aanwezig), niet voor de blog-listing of 404-pagina.
  let jsonLd = '';
  let ogTags = '';
  if (opts.post && !opts.noindex) {
    const p = opts.post;
    const fallbackImg = 'https://runningdinner.app/images/screenshot-planning.jpg';
    const imgUrl = p.image || fallbackImg;
    const pageUrl = opts.canonical || `https://runningdinner.app/blog/${p.slug}`;
    // Google Rich Results Test eist ISO 8601 datetime mét tijdzone.
    // Frontmatter-datum is YYYY-MM-DD — we appenden 08:00 Amsterdam-tijd
    // zodat de datum/tijd valid is en consistent across deploys.
    const isoDate = p.date ? `${p.date}T08:00:00+02:00` : '';
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: p.title,
      description: p.description || '',
      image: imgUrl,
      author: {
        '@type': 'Person',
        name: p.author || 'Cyro van Malsen',
        url: 'https://runningdinner.app/',
      },
      publisher: {
        '@type': 'Organization',
        name: 'Running Dinner Planner',
        logo: { '@type': 'ImageObject', url: 'https://runningdinner.app/images/runningdinner-logo-email.png' },
      },
      datePublished: isoDate,
      dateModified: isoDate,
      mainEntityOfPage: { '@type': 'WebPage', '@id': pageUrl },
      inLanguage: locale,
      keywords: p.keywords || '',
    };
    jsonLd = `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
    // Open Graph + Twitter Card zodat blog-shares op Facebook/LinkedIn/X
    // rijke previews tonen met titel, beschrijving en afbeelding.
    ogTags = `
<meta property="og:type" content="article">
<meta property="og:title" content="${String(p.title).replace(/"/g, '&quot;')}">
<meta property="og:description" content="${String(p.description || '').replace(/"/g, '&quot;')}">
<meta property="og:image" content="${imgUrl}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:locale" content="${ogLocaleCode}">
<meta property="og:site_name" content="Running Dinner Planner">
<meta property="article:published_time" content="${p.date || ''}">
<meta property="article:author" content="${p.author || 'Cyro van Malsen'}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${String(p.title).replace(/"/g, '&quot;')}">
<meta name="twitter:description" content="${String(p.description || '').replace(/"/g, '&quot;')}">
<meta name="twitter:image" content="${imgUrl}">`;
  } else if (!opts.noindex && (opts.canonical || opts.description)) {
    // Generic website OG tags voor blog-listing en andere niet-post pages.
    const fallbackImg = 'https://runningdinner.app/images/screenshot-planning.jpg';
    const ogTitle = String(title).replace(/"/g, '&quot;');
    const ogDesc  = String(opts.description || '').replace(/"/g, '&quot;');
    const pageUrl = opts.canonical || '';
    ogTags = `
<meta property="og:type" content="website">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDesc}">
<meta property="og:image" content="${fallbackImg}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:locale" content="${ogLocaleCode}">
<meta property="og:site_name" content="Running Dinner Planner">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${ogTitle}">
<meta name="twitter:description" content="${ogDesc}">
<meta name="twitter:image" content="${fallbackImg}">`;
  }

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${robots}
${descMeta}
${canonical}${ogTags}
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<style>${BLOG_STYLE}</style>
${jsonLd}
</head>
<body>
${logoHeader}
<article class="blog-page">
<div class="blog-nav">${headerLinks}</div>
${content}
</article>
</body>
</html>`;
}

// Public blog listing (only published posts)
router.get(['/blog', '/en/blog', '/es/blog', '/de/blog'], (req, res) => {
  const locale = req.lang || 'nl';
  const prefix = locale === 'nl' ? '/blog' : `/${locale}/blog`;
  const posts = blog.listPublished(locale);
  const listTitle = 'Blog';
  const emptyText = locale === 'en' ? 'No posts yet. Come back soon.'
    : locale === 'es' ? 'Aún no hay artículos. Vuelve pronto.'
    : locale === 'de' ? 'Noch keine Artikel. Schauen Sie bald wieder vorbei.'
    : 'Nog geen artikelen. Kom binnenkort terug.';
  let content = `<h1>${listTitle}</h1>`;
  if (!posts.length) {
    content += `<p style="color:#64748B;margin-top:20px">${emptyText}</p>`;
  } else {
    for (const p of posts) {
      content += `
        <div class="blog-list-item">
          <a href="${prefix}/${p.slug}">
            <h3>${p.title}</h3>
            <p class="desc">${p.description}</p>
          </a>
        </div>`;
    }
  }
  res.type('html').send(renderBlogShell(listTitle, content, locale, {
    canonical: `https://runningdinner.app${prefix}`,
    description: locale === 'en' ? 'Running Dinner Planner blog — tips and guides for organisers.'
      : locale === 'es' ? 'Blog de Running Dinner Planner — consejos y guías para organizadores.'
      : locale === 'de' ? 'Running Dinner Planner Blog — Tipps und Anleitungen für Organisatoren.'
      : 'Running Dinner Planner blog — tips en gidsen voor organisatoren.',
  }));
});

// Individual blog post
router.get(['/blog/:slug', '/en/blog/:slug', '/es/blog/:slug', '/de/blog/:slug'], (req, res) => {
  const locale = req.lang || 'nl';
  const prefix = locale === 'nl' ? '/blog' : `/${locale}/blog`;
  const post = blog.getBySlug(req.params.slug, locale);
  if (!post) return res.status(404).type('html').send(renderBlogShell('Not found', '<h1>Not found</h1><p>Dit artikel bestaat niet of is nog niet gepubliceerd.</p>', locale, { noindex: true }));
  // Admins may preview drafts; everyone else gets 404 on draft
  const isAdminPreview = req.cookies?.token; // crude check: any logged-in user; tighter check below would require verifying the JWT
  if (post.draft && !isAdminPreview) {
    return res.status(404).type('html').send(renderBlogShell('Not found', '<h1>Not found</h1>', locale, { noindex: true }));
  }
  const html = blog.render(post);
  const meta = `<div class="blog-meta">${post.date || ''} • ${post.author}${post.draft ? ' <span class="blog-draft-badge">DRAFT</span>' : ''}</div>`;

  // Related posts voor internal linking (SEO). Keyword-overlap-gebaseerd,
  // same-locale, top 3. Versterkt topical authority voor pillar/spokes.
  let relatedBlock = '';
  if (!post.draft) {
    const related = blog.getRelated(post.slug, locale, 3);
    if (related.length) {
      const relatedLabel = locale === 'en' ? 'Related reading'
                        : locale === 'es' ? 'Sigue leyendo'
                        : locale === 'de' ? 'Das könnte Sie auch interessieren'
                        : 'Lees ook';
      const items = related.map(r =>
        `<li><a href="${prefix}/${r.slug}">${r.title}</a>${r.description ? `<br><span class="related-desc">${r.description}</span>` : ''}</li>`
      ).join('');
      relatedBlock = `
<aside class="blog-related">
  <h2>${relatedLabel}</h2>
  <ul>${items}</ul>
</aside>`;
    }
  }

  const content = meta + html + relatedBlock;
  res.type('html').send(renderBlogShell(post.title, content, locale, {
    noindex:     post.draft,   // drafts noindex; publicaties indexeerbaar
    canonical:   `https://runningdinner.app${prefix}/${post.slug}`,
    description: post.description || '',
    post,                      // voor BlogPosting JSON-LD + OG-tags
  }));
});

// Admin API: list all posts (including drafts) for content management


// ── Segment-landingspagina's (meertalig + indexeerbaar) ─────────────────────
// Bij boot bouwen we per (slug × taal) een HTML-variant met correcte
// <title>, <meta description>, <html lang>, canonical — en zonder noindex.
// Content-vertalingen komen client-side via data-i18n + lang/{locale}.json.
const SEGMENT_SLUGS = ['service-clubs', 'verenigingen', 'vriendengroepen'];
const SEGMENT_TO_I18N_KEY = {
  'service-clubs':   'clubs',
  'verenigingen':    'verenigingen',
  'vriendengroepen': 'vrienden',
};
const segmentHtmlCache = {}; // key: `${slug}:${locale}` → html

try {
  const langJSONs = {};
  for (const l of SUPPORTED_LANGS) {
    try { langJSONs[l] = require(`./public/lang/${l}.json`); } catch { langJSONs[l] = {}; }
  }

  for (const slug of SEGMENT_SLUGS) {
    const srcPath = path.join(ROOT, 'public', `${slug}.html`);
    let src;
    try { src = fs.readFileSync(srcPath, 'utf8'); }
    catch (e) { console.warn(`[boot] segment source not readable: ${slug}.html (${e.message})`); continue; }

    // Strip the noindex meta (+ optional HTML comment after it) eenmalig.
    // We laten het bestand op disk intact — alleen de in-memory cache is public.
    const baseHtml = src.replace(/<meta name="robots" content="noindex"[^>]*>(<!--[^>]*-->)?\s*\n?/g, '');

    for (const locale of SUPPORTED_LANGS) {
      let html = baseHtml;
      const segKey = SEGMENT_TO_I18N_KEY[slug];
      const seg    = langJSONs[locale]?.segment?.[segKey];

      // <html lang="nl"> → correct locale
      html = html.replace('<html lang="nl">', `<html lang="${locale}">`);

      // Vervang <title> en <meta description> met locale-specifieke SEO-tekst.
      // Voor NL blijft de NL-default (geen seo_title in nl.json).
      if (seg?.seo_title) {
        html = html.replace(/<title>[^<]+<\/title>/, `<title>${seg.seo_title}</title>`);
      }
      if (seg?.seo_description) {
        html = html.replace(/<meta name="description" content="[^"]*">/,
          `<meta name="description" content="${String(seg.seo_description).replace(/"/g, '&quot;')}">`);
      }

      // Canonical: /slug voor NL, /{locale}/slug voor andere talen
      const canonicalPath = locale === 'nl' ? `/${slug}` : `/${locale}/${slug}`;
      const canonicalUrl  = `https://runningdinner.app${canonicalPath}`;
      // Voeg canonical toe vlak voor </head> als die er nog niet staat
      if (!/<link[^>]+rel="canonical"/.test(html)) {
        html = html.replace('</head>',
          `  <link rel="canonical" href="${canonicalUrl}">\n</head>`);
      }

      // Open Graph + Twitter Card voor social shares. Title/description
      // komen uit seg.seo_title / seg.seo_description (of NL-defaults via
      // de al-aanwezige <title> en description tags — we extracten ze).
      if (!/<meta\s+property="og:/.test(html)) {
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        const descMatch  = html.match(/<meta name="description" content="([^"]*)">/);
        const ogTitle    = (seg?.seo_title || titleMatch?.[1] || '').replace(/"/g, '&quot;');
        const ogDesc     = (seg?.seo_description || descMatch?.[1] || '').replace(/"/g, '&quot;');
        const ogLocale   = locale === 'nl' ? 'nl_NL' : locale === 'en' ? 'en_GB' : locale === 'es' ? 'es_ES' : 'de_DE';
        const ogBlock = `
  <meta property="og:type" content="website">
  <meta property="og:title" content="${ogTitle}">
  <meta property="og:description" content="${ogDesc}">
  <meta property="og:image" content="https://runningdinner.app/images/screenshot-planning.jpg">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:locale" content="${ogLocale}">
  <meta property="og:site_name" content="Running Dinner Planner">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${ogTitle}">
  <meta name="twitter:description" content="${ogDesc}">
  <meta name="twitter:image" content="https://runningdinner.app/images/screenshot-planning.jpg">`;
        html = html.replace('</head>', `${ogBlock}\n</head>`);
      }

      segmentHtmlCache[`${slug}:${locale}`] = html;
    }
  }
  console.log(`[boot] Segment SEO variants generated for ${SEGMENT_SLUGS.length} pages × ${SUPPORTED_LANGS.length} locales`);
} catch (e) {
  console.warn('[boot] Could not generate segment SEO variants:', e.message);
}

function sendSegmentPage(slug, locale, res) {
  const html = segmentHtmlCache[`${slug}:${locale}`];
  if (html) {
    res.type('html').send(html);
  } else {
    // Fallback: serve de originele NL-file (geen SEO-override, werkt nog wel)
    res.sendFile(path.join(ROOT, 'public', `${slug}.html`));
  }
}

SEGMENT_SLUGS.forEach(slug => {
  router.get('/' + slug,          (req, res) => sendSegmentPage(slug, 'nl', res));
  router.get('/en/' + slug,       (req, res) => sendSegmentPage(slug, 'en', res));
  router.get('/es/' + slug,       (req, res) => sendSegmentPage(slug, 'es', res));
  router.get('/de/' + slug,       (req, res) => sendSegmentPage(slug, 'de', res));
});

  return router;
};
