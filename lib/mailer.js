/**
 * Alle uitgaande mail: transporter (Brevo indien geconfigureerd, anders
 * SMTP), de HTML-wrappers en de factuurmail met 4-talige labels.
 * Uit server.js gelicht (tranche 10) zodat de templates unit-testbaar
 * zijn — drie eerdere bugs waren telkens een ontbrekende DE-variant.
 */
'use strict';

const nodemailer = require('nodemailer');

// Zelfde afleiding als in server.js (config is env-gedreven).
const PORT = parseInt(process.env.PORT || '3001', 10);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ── Mail transporter ──────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendMail(to, subject, html, { replyTo } = {}) {
  const brevo = require('./brevo');
  // If Brevo is configured, prefer it over SMTP (better deliverability + analytics)
  if (brevo.isConfigured()) {
    try {
      await brevo.sendTransactional({ to, subject, html: wrapHtml(html), replyTo });
      return;
    } catch (err) {
      console.error('[mail] Brevo failed, falling back to SMTP:', err.message);
      // fall through to SMTP
    }
  }
  if (!process.env.SMTP_HOST) {
    console.log(`[mail] SMTP not configured – would send to ${to}: ${subject}`);
    return;
  }
  // Strip HTML tags for plain-text alternative (improves deliverability)
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&bull;/g, '•').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();

  const mailOptions = {
    from: process.env.MAIL_FROM,
    to,
    subject,
    html: wrapHtml(html),
    text,
    headers: {
      'X-Mailer': 'Running Dinner Planner',
      'List-Unsubscribe': `<mailto:${process.env.MAIL_FROM_ADDRESS || 'noreply@runningdinner.app'}?subject=unsubscribe>`,
    },
  };
  if (replyTo) mailOptions.replyTo = replyTo;
  await mailer.sendMail(mailOptions);
}

// Wrap HTML content in a proper email document structure
function wrapHtml(body, lang = 'nl') {
  const footers = {
    nl: 'Je ontvangt deze e-mail omdat je een account hebt of bent uitgenodigd.',
    en: 'You are receiving this email because you have an account or have been invited.',
    es: 'Recibes este correo porque tienes una cuenta o has sido invitado.',
    de: 'Du erhältst diese E-Mail, weil du ein Konto hast oder eingeladen wurdest.',
  };
  const footer = footers[lang] || footers.nl;
  return `<!DOCTYPE html>
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Running Dinner Planner</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7">
    <tr>
      <td align="center" style="padding:24px 16px">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;max-width:520px;width:100%">
          <tr>
            <td style="padding:32px 24px">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e5e7eb;text-align:center">
              <p style="margin:0;color:#9ca3af;font-size:11px;line-height:16px">
                Running Dinner Planner &bull; runningdinner.app<br>
                ${footer}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Dedicated wrapper voor factuur-mails. Toont het runningdinner.app logo in
 * de header en een duidelijk VMH-blok in de footer (KvK, BTW, adres). De
 * Zoho PDF-bijlage is juridisch de factuur — deze e-mail communiceert dat
 * de betaling door VMH B.V. wordt verwerkt (runningdinner.app is een
 * product van VMH).
 */
function wrapInvoiceHtml(body, lang = 'nl') {
  const footerLines = {
    nl: [
      'runningdinner.app is een product van <strong>VMH B.V.</strong>',
      'KvK 08142482 &bull; BTW NL8152.92.715.B01',
      'Hanekerweg 4, 7381 AM Klarenbeek, Nederland',
      '<a href="mailto:info@runningdinner.app" style="color:#6b7280">info@runningdinner.app</a>',
    ],
    en: [
      'runningdinner.app is a product of <strong>VMH B.V.</strong>',
      'Chamber of Commerce 08142482 &bull; VAT NL8152.92.715.B01',
      'Hanekerweg 4, 7381 AM Klarenbeek, The Netherlands',
      '<a href="mailto:info@runningdinner.app" style="color:#6b7280">info@runningdinner.app</a>',
    ],
    es: [
      'runningdinner.app es un producto de <strong>VMH B.V.</strong>',
      'Cámara de Comercio 08142482 &bull; NIF NL8152.92.715.B01',
      'Hanekerweg 4, 7381 AM Klarenbeek, Países Bajos',
      '<a href="mailto:info@runningdinner.app" style="color:#6b7280">info@runningdinner.app</a>',
    ],
    de: [
      'runningdinner.app ist ein Produkt der <strong>VMH B.V.</strong>',
      'Handelskammer 08142482 &bull; USt-IdNr. NL8152.92.715.B01',
      'Hanekerweg 4, 7381 AM Klarenbeek, Niederlande',
      '<a href="mailto:info@runningdinner.app" style="color:#6b7280">info@runningdinner.app</a>',
    ],
  };
  const lines = footerLines[lang] || footerLines.nl;
  return `<!DOCTYPE html>
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Running Dinner Planner</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7">
    <tr>
      <td align="center" style="padding:24px 16px">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;max-width:560px;width:100%">
          <tr>
            <td align="center" style="padding:32px 24px 8px 24px">
              <a href="https://runningdinner.app" style="text-decoration:none">
                <img src="https://runningdinner.app/images/runningdinner-logo-email.png" alt="runningdinner.app" width="200" style="width:200px;height:auto;display:block;border:0">
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 24px 32px">
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px;border-top:1px solid #e5e7eb;text-align:center">
              <p style="margin:0;color:#6b7280;font-size:11px;line-height:17px">
                ${lines.join('<br>')}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function formatEur(cents) {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

// Email locale helpers
const EMAIL_LOCALES = { nl: 'nl-NL', en: 'en-GB', es: 'es-ES', de: 'de-DE' };

// Labels for invoice/payment emails by language
const INVOICE_LABELS = {
  nl: {
    hi: 'Hallo,',
    thanks: (date) => `Bedankt voor je betaling! Je abonnement is actief t/m <strong>${date}</strong>.`,
    invoice_number: 'Factuurnummer',
    description: 'Omschrijving',
    sub_label: '1 jaar abonnement',
    amount: 'Bedrag',
    date: 'Datum',
    open_planner: 'Open de planner',
    subject: (no) => `Factuur ${no} - Running Dinner Planner`,
    waiver_heading: 'Bevestiging directe activering & afstand herroepingsrecht',
    waiver_body: (ts) => `Bij het afronden van je abonnement heb je op <strong>${ts}</strong> aangevinkt dat je uitdrukkelijk toestemming geeft voor directe activering van je account, en daarmee bevestigd dat je afziet van het herroepingsrecht zoals bedoeld in artikel 6:230p sub e BW. Deze e-mail dient als bevestiging op een duurzame drager conform BW 6:230v lid 7. Meer informatie op <a href="https://runningdinner.app/herroepingsrecht.html">runningdinner.app/herroepingsrecht.html</a>.`,
  },
  en: {
    hi: 'Hi,',
    thanks: (date) => `Thank you for your payment! Your subscription is active until <strong>${date}</strong>.`,
    invoice_number: 'Invoice number',
    description: 'Description',
    sub_label: '1 year subscription',
    amount: 'Amount',
    date: 'Date',
    open_planner: 'Open the planner',
    subject: (no) => `Invoice ${no} - Running Dinner Planner`,
    waiver_heading: 'Confirmation of immediate activation & waiver of right of withdrawal',
    waiver_body: (ts) => `When completing your subscription you ticked on <strong>${ts}</strong> that you expressly consented to immediate activation of your account, thereby waiving your right of withdrawal as referred to in article 6:230p(e) Dutch Civil Code. This email serves as a confirmation on a durable medium, in line with article 6:230v(7) DCC. Full details at <a href="https://runningdinner.app/herroepingsrecht.html">runningdinner.app/herroepingsrecht.html</a>.`,
  },
  es: {
    hi: 'Hola,',
    thanks: (date) => `¡Gracias por tu pago! Tu suscripción está activa hasta el <strong>${date}</strong>.`,
    invoice_number: 'Número de factura',
    description: 'Descripción',
    sub_label: 'Suscripción de 1 año',
    amount: 'Importe',
    date: 'Fecha',
    open_planner: 'Abrir el planificador',
    subject: (no) => `Factura ${no} - Running Dinner Planner`,
    waiver_heading: 'Confirmación de activación inmediata y renuncia al derecho de desistimiento',
    waiver_body: (ts) => `Al completar tu suscripción, el <strong>${ts}</strong> marcaste que otorgas consentimiento expreso para la activación inmediata de tu cuenta y con ello renuncias al derecho de desistimiento conforme al artículo 6:230p letra e del Código Civil neerlandés. Este correo sirve como confirmación en un soporte duradero, conforme al artículo 6:230v(7) BW. Más información en <a href="https://runningdinner.app/herroepingsrecht.html">runningdinner.app/herroepingsrecht.html</a>.`,
  },
  de: {
    hi: 'Hallo,',
    thanks: (date) => `Vielen Dank für deine Zahlung! Dein Abonnement ist aktiv bis zum <strong>${date}</strong>.`,
    invoice_number: 'Rechnungsnummer',
    description: 'Beschreibung',
    sub_label: '1 Jahr Abonnement',
    amount: 'Betrag',
    date: 'Datum',
    open_planner: 'Planer öffnen',
    subject: (no) => `Rechnung ${no} - Running Dinner Planner`,
    waiver_heading: 'Bestätigung der sofortigen Aktivierung & Verzicht auf das Widerrufsrecht',
    waiver_body: (ts) => `Beim Abschluss deines Abonnements hast du am <strong>${ts}</strong> angekreuzt, dass du der sofortigen Aktivierung deines Kontos ausdrücklich zustimmst und damit auf dein Widerrufsrecht gemäß Artikel 6:230p Buchstabe e des niederländischen Bürgerlichen Gesetzbuchs (BW) verzichtest. Diese E-Mail dient als Bestätigung auf einem dauerhaften Datenträger gemäß Artikel 6:230v Absatz 7 BW. Weitere Informationen unter <a href="https://runningdinner.app/herroepingsrecht.html">runningdinner.app/herroepingsrecht.html</a>.`,
  },
};

async function sendInvoiceMail(user, payment) {
  const lang = user.language || 'nl';
  const locale = EMAIL_LOCALES[lang] || EMAIL_LOCALES.nl;
  // Onbekende taal: val terug op EN (breedst begrepen), daarna NL.
  const L = INVOICE_LABELS[lang] || INVOICE_LABELS.en || INVOICE_LABELS.nl;
  const untilDate = new Date(user.license_until).toLocaleDateString(locale);

  // Optioneel waiver-bevestigingsblok — uitsluitend als de klant bij checkout
  // expliciet heeft ingestemd met directe activering. Dient als bevestiging
  // op een duurzame drager (BW 6:230v lid 7).
  let waiverBlock = '';
  if (user.waiver_accepted_at) {
    const ts = new Date(user.waiver_accepted_at).toLocaleString(locale);
    waiverBlock = `
          <div style="margin:24px 0;padding:14px 18px;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;font-size:13px;line-height:1.55;color:#78350f">
            <strong style="display:block;margin-bottom:6px">${L.waiver_heading}</strong>
            ${L.waiver_body(ts)}
          </div>`;
  }

  const html = `
          <p style="color:#374151;line-height:1.6;margin:0 0 12px">${L.hi}</p>
          <p style="color:#374151;line-height:1.6;margin:0 0 16px">${L.thanks(untilDate)}</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px">
            <tr style="background:#f3f4f6">
              <td style="padding:8px 12px;color:#374151">${L.invoice_number}</td>
              <td style="padding:8px 12px;color:#374151"><strong>${payment.invoice_number}</strong></td>
            </tr>
            <tr>
              <td style="padding:8px 12px;color:#374151">${L.description}</td>
              <td style="padding:8px 12px;color:#374151">Running Dinner Planner - ${L.sub_label}</td>
            </tr>
            <tr style="background:#f3f4f6">
              <td style="padding:8px 12px;color:#374151">${L.amount}</td>
              <td style="padding:8px 12px;color:#374151"><strong>${formatEur(payment.amount_cents)}</strong></td>
            </tr>
            <tr>
              <td style="padding:8px 12px;color:#374151">${L.date}</td>
              <td style="padding:8px 12px;color:#374151">${new Date(payment.created_at).toLocaleDateString(locale)}</td>
            </tr>
          </table>
          ${waiverBlock}
          <p style="margin:24px 0;text-align:center">
            <a href="${BASE_URL}/app" style="background:#E85D3A;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">${L.open_planner}</a>
          </p>
  `;
  await sendMail(user.email, L.subject(payment.invoice_number), wrapInvoiceHtml(html, lang));
}

module.exports = {
  sendMail, wrapHtml, wrapInvoiceHtml, sendInvoiceMail, formatEur,
  // Alleen voor tests:
  EMAIL_LOCALES, INVOICE_LABELS,
};
