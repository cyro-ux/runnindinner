/**
 * Server-side lokalisatie van de homepage (SEO).
 *
 * De homepage vertaalt zichzelf client-side via data-i18n-attributen en
 * lang/{locale}.json, en haalt hero-/footerteksten uit het CMS via
 * /api/cms. Crawlers zagen daardoor op /de/, /en/ en /es/ de Nederlandse
 * brontekst (incl. een NL-H1 op de belangrijkste markt). Deze helpers
 * passen dezelfde vertalingen en CMS-teksten al in de HTML toe; de
 * client-side i18n blijft draaien en is idempotent.
 */
'use strict';

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function lookup(dict, key) {
  const v = key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), dict);
  return typeof v === 'string' ? v : undefined;
}

/**
 * Past een i18n-woordenboek toe op data-i18n (tekst), data-i18n-html
 * (innerHTML) en data-i18n-placeholder/-title/-value (attributen).
 * Elementen met geneste tags onder data-i18n blijven ongemoeid.
 */
function applyI18n(html, dict) {
  let out = html;
  // data-i18n → tekstinhoud (alleen als de huidige inhoud platte tekst is)
  out = out.replace(/<([a-zA-Z][\w-]*)([^>]*?\sdata-i18n="([^"]+)"[^>]*)>([^<]*)<\/\1>/g,
    (m, tag, attrs, key) => {
      const v = lookup(dict, key);
      return v === undefined ? m : '<' + tag + attrs + '>' + escapeHtml(v) + '</' + tag + '>';
    });
  // data-i18n-html → innerHTML (tot de eerste sluittag van hetzelfde type)
  out = out.replace(/<([a-zA-Z][\w-]*)([^>]*?\sdata-i18n-html="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/g,
    (m, tag, attrs, key) => {
      const v = lookup(dict, key);
      return v === undefined ? m : '<' + tag + attrs + '>' + v + '</' + tag + '>';
    });
  // attribuut-varianten
  for (const attr of ['placeholder', 'title', 'value']) {
    const tagRe = new RegExp('<[a-zA-Z][\\w-]*[^>]*\\sdata-i18n-' + attr + '="([^"]+)"[^>]*>', 'g');
    out = out.replace(tagRe, (tagHtml, key) => {
      const v = lookup(dict, key);
      if (v === undefined) return tagHtml;
      const attrRe = new RegExp('\\s' + attr + '="[^"]*"');
      return attrRe.test(tagHtml)
        ? tagHtml.replace(attrRe, ' ' + attr + '="' + escapeHtml(v) + '"')
        : tagHtml.replace(/>$/, ' ' + attr + '="' + escapeHtml(v) + '">');
    });
  }
  return out;
}

/** Zelfde taal-overlay als /api/cms: hero_title_de overschrijft hero_title voor lang=de. */
function pickCmsForLang(rows, lang) {
  const all = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const cms = {};
  for (const [key, value] of Object.entries(all)) {
    if (/_(en|es|de)$/.test(key)) continue;
    const langVal = lang !== 'nl' ? all[key + '_' + lang] : undefined;
    cms[key] = langVal || value;
  }
  return cms;
}

const CMS_TARGETS = [
  ['cms-hero-title', 'hero_title'], ['cms-hero-subtitle', 'hero_subtitle'],
  ['cms-features-intro', 'features_intro'], ['cms-footer-text', 'footer_text'],
  ['cms-footer-copyright', 'footer_text'], ['cms-hero-cta', 'hero_cta'],
];

/** Zet CMS-teksten (zoals home.js dat client-side doet) in de HTML. */
function applyCms(html, cms) {
  let out = html;
  for (const [id, key] of CMS_TARGETS) {
    const v = cms && cms[key];
    if (!v) continue;
    const re = new RegExp('<([a-zA-Z][\\w-]*)([^>]*\\sid="' + id + '"[^>]*)>([\\s\\S]*?)<\\/\\1>');
    out = out.replace(re, (m, tag, attrs) => '<' + tag + attrs + '>' + escapeHtml(v) + '</' + tag + '>');
  }
  return out;
}

module.exports = { applyI18n, applyCms, pickCmsForLang, escapeHtml };
