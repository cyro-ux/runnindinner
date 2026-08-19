/**
 * HTML-escaping voor server-side gerenderde pagina's (XSS-preventie).
 */
'use strict';

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = { escHtml };
