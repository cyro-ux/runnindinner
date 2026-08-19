/**
 * Manifest van de planner-scripts, in laadvolgorde.
 *
 * Eén bron van waarheid voor:
 *  - index.html        (script-tags, zelfde volgorde — bewaakt door test)
 *  - server.js         (allowlist van publiek geserveerde root-bestanden)
 *  - lib/*.test.js     (vm-sandbox laadt de delen geconcateneerd)
 *
 * Klassieke scripts (geen modules): functiedeclaraties zijn globaal, dus
 * delen mogen naar elkaars functies verwijzen zolang aanroepen pas ná het
 * laden gebeuren. Alle top-level code (state-init, listeners, init) zit
 * bewust in 01-core.js en 06-ui.js.
 */
'use strict';

module.exports = [
  'js/planner/01-core.js',
  'js/planner/02-participants.js',
  'js/planner/03-planning.js',
  'js/planner/04-overview.js',
  'js/planner/05-extras.js',
  'js/planner/06-ui.js',
];
