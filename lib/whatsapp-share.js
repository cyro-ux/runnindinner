/**
 * WhatsApp share helpers.
 *
 * Geen WhatsApp Business API — geen kosten per bericht, geen KYC, geen Twilio.
 * We gebruiken uitsluitend de publieke `wa.me` deeplink-standaard, die op
 * alle platformen werkt: WhatsApp app (mobile), WhatsApp Web (desktop), en
 * via de Web Share API de native share-sheet op mobiel.
 *
 * **Belangrijk**: de app stuurt nooit zelf een WhatsApp-bericht. We leveren
 * alleen een voorbereide tekst + URL. De gebruiker klikt, WhatsApp opent bij
 * hem op zijn eigen device, hij verstuurt vanuit zijn eigen account.
 *
 * Documentatie: https://faq.whatsapp.com/5913398998672934
 */

'use strict';

// Basis-UTM-parameters voor attributie in Plausible
const DEFAULT_UTM = {
  source:   'whatsapp',
  medium:   'organic_share',
  campaign: 'event_share',
};

function _addUtm(url, utm = {}) {
  const merged = { ...DEFAULT_UTM, ...utm };
  const u = new URL(url);
  if (merged.source)   u.searchParams.set('utm_source',   merged.source);
  if (merged.medium)   u.searchParams.set('utm_medium',   merged.medium);
  if (merged.campaign) u.searchParams.set('utm_campaign', merged.campaign);
  return u.toString();
}

/**
 * Bouw een wa.me URL met vooringevuld bericht.
 *
 * @param {object} opts
 * @param {string} [opts.phone]  E164-telefoonnummer zonder + (bijv. "31612345678").
 *                               Leeg = shareable broadcast (ontvanger kiest gebruiker wie hij wil).
 * @param {string} opts.text     Het bericht (wordt URL-encoded).
 * @returns {string}             wa.me-URL.
 */
function buildShareUrl({ phone, text }) {
  const encoded = encodeURIComponent(text);
  if (phone) {
    const cleaned = String(phone).replace(/[^\d]/g, '');
    return `https://wa.me/${cleaned}?text=${encoded}`;
  }
  return `https://wa.me/?text=${encoded}`;
}

/**
 * Deel een event met de WhatsApp-groep.
 *
 * @param {object} opts
 * @param {string} opts.eventName
 * @param {string} opts.eventDate    ISO-datum of leesbare datum
 * @param {string} opts.registerUrl  absolute URL naar de deelnemers-registratiepagina
 * @param {string} [opts.locale]     'nl' | 'en' | 'es'  (default nl)
 */
function shareEventInvite({ eventName, eventDate, registerUrl, locale = 'nl' }) {
  const url = _addUtm(registerUrl, { campaign: 'event_invite' });
  const texts = {
    nl: `🍽️ Running Dinner: *${eventName}* op ${eventDate}\n\nIk organiseer via runningdinner.app — meld je aan via onderstaande link:\n\n${url}`,
    en: `🍽️ Running Dinner: *${eventName}* on ${eventDate}\n\nI'm organising this via runningdinner.app — sign up here:\n\n${url}`,
    es: `🍽️ Cena itinerante: *${eventName}* el ${eventDate}\n\nLa organizo con runningdinner.app — apúntate aquí:\n\n${url}`,
  };
  return buildShareUrl({ text: texts[locale] || texts.nl });
}

/**
 * Stuur een individuele deelnemer zijn persoonlijke indeling via WhatsApp.
 *
 * @param {object} opts
 * @param {string} opts.participantName
 * @param {string} [opts.phone]         voor gerichte wa.me-link
 * @param {string} opts.personalUrl     URL van de persoonlijke deelnemerspagina
 * @param {string} [opts.locale]        'nl' | 'en' | 'es'
 */
function shareParticipantSchedule({ participantName, phone, personalUrl, locale = 'nl' }) {
  const url = _addUtm(personalUrl, { campaign: 'participant_schedule' });
  const texts = {
    nl: `Hoi ${participantName}! 👋\n\nJouw persoonlijke indeling voor het running dinner staat hier:\n\n${url}\n\nTot dan! 🍴`,
    en: `Hi ${participantName}! 👋\n\nYour personal schedule for the running dinner is here:\n\n${url}\n\nSee you then! 🍴`,
    es: `¡Hola ${participantName}! 👋\n\nTu planificación personal para la cena itinerante:\n\n${url}\n\n¡Nos vemos! 🍴`,
  };
  return buildShareUrl({ phone, text: texts[locale] || texts.nl });
}

/**
 * Deel jouw eigen indeling met een vriend (deelnemer-knop op persoonlijke pagina).
 *
 * @param {object} opts
 * @param {string} opts.eventName
 * @param {string} opts.personalUrl
 * @param {string} [opts.locale]
 */
function sharePersonalSchedule({ eventName, personalUrl, locale = 'nl' }) {
  const url = _addUtm(personalUrl, { campaign: 'personal_schedule' });
  const texts = {
    nl: `Ik doe mee aan *${eventName}* via runningdinner.app 🍽️ Bekijk mijn indeling: ${url}`,
    en: `I'm joining *${eventName}* via runningdinner.app 🍽️ Check my schedule: ${url}`,
    es: `Participo en *${eventName}* con runningdinner.app 🍽️ Mira mi plan: ${url}`,
  };
  return buildShareUrl({ text: texts[locale] || texts.nl });
}

/**
 * Hulpsnippet voor de client-side: genereer een UI-knop die eerst de Web Share
 * API probeert (native share-sheet op mobiel), en valt terug op wa.me op
 * desktop. Dit is ready-to-paste JavaScript voor de frontend.
 */
const CLIENT_SNIPPET = `
function shareViaWhatsApp(text, url, waMeUrl) {
  // Web Share API: opent native share-sheet op mobiel (inclusief WhatsApp)
  if (navigator.share) {
    return navigator.share({ text, url }).catch(() => window.open(waMeUrl, '_blank'));
  }
  // Desktop fallback: open wa.me direct (WhatsApp Web of QR-login)
  window.open(waMeUrl, '_blank');
}
`.trim();

module.exports = {
  buildShareUrl,
  shareEventInvite,
  shareParticipantSchedule,
  sharePersonalSchedule,
  CLIENT_SNIPPET,
};
