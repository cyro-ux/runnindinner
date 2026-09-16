/**
 * "Wat is er nieuw"-aankondigingen voor ingelogde gebruikers.
 *
 * Elke entry beschrijft een release in de vier talen; de planner toont
 * ongeziene entries als banner na inloggen (js/planner/08-whatsnew.js) en
 * markeert ze via POST /api/announcements/seen als gezien (per account,
 * dus over apparaten heen). Gebruikers zien alleen aankondigingen van ná
 * hun registratie — nieuwe accounts krijgen geen oude backlog.
 *
 * Nieuwe feature gebouwd? Voeg hier een entry toe in dezelfde commit; de
 * 4-talen-wachter (lib/mailer.test.js) dwingt de vertalingen af.
 */
'use strict';

const ANNOUNCEMENTS = [
  {
    id: 'sept-2026-zaal-en-extra-gangen',
    date: '2026-09-16',
    nl: {
      title: 'Nieuw: zaal-modus, eigen gangen en automatisch opslaan',
      text: 'Plan een diner op één locatie met tafelrotatie per gang (ideaal voor clubs en gala’s), hernoem gangen naar wens, voeg tot 2 extra gangen toe (7 totaal, volgorde volgt de tijden) — en je event wordt nu automatisch in je account bewaard, zodat je op elk apparaat verder werkt.',
    },
    en: {
      title: 'New: venue mode, custom courses and auto-save',
      text: 'Plan a dinner at a single venue with table rotation per course (great for clubs and galas), rename courses as you like, add up to 2 extra courses (7 in total, the order follows the times) — and your event is now saved to your account automatically, so you can continue on any device.',
    },
    es: {
      title: 'Nuevo: modo salón, platos propios y guardado automático',
      text: 'Planifica una cena en un solo salón con rotación de mesas por plato (ideal para clubes y galas), renombra los platos a tu gusto, añade hasta 2 platos extra (7 en total, el orden sigue los horarios) — y tu evento ahora se guarda automáticamente en tu cuenta, para continuar en cualquier dispositivo.',
    },
    de: {
      title: 'Neu: Saal-Modus, eigene Gänge und automatisches Speichern',
      text: 'Plane ein Dinner an einem Ort mit Tischrotation pro Gang (ideal für Vereine und Galas), benenne Gänge nach Wunsch um, füge bis zu 2 Extragänge hinzu (7 insgesamt, die Reihenfolge folgt den Zeiten) — und dein Event wird jetzt automatisch in deinem Konto gespeichert, sodass du auf jedem Gerät weiterarbeiten kannst.',
    },
  },
];

/** Epoch-ms van de releasedatum (middernacht UTC). */
function dateMs(a) {
  return Date.parse(a.date + 'T00:00:00Z');
}

/** Aankondigingen die de gebruiker nog niet zag en die ná registratie kwamen. */
function unseenFor(user) {
  const threshold = Math.max(user.announcements_seen_at || 0, user.created_at || 0);
  return ANNOUNCEMENTS.filter((a) => dateMs(a) > threshold);
}

module.exports = { ANNOUNCEMENTS, unseenFor, dateMs };
