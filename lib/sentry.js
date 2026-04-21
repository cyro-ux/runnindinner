/**
 * Sentry wrapper — activeert alleen als SENTRY_DSN is gezet.
 *
 * Waarom wrapper en niet direct `@sentry/node` importeren? Omdat we Sentry
 * zonder DSN stil willen laten falen. De npm-package `@sentry/node` is een
 * optional dependency die alleen wordt geïnstalleerd wanneer monitoring nodig
 * is. Zonder DSN gebruiken we een no-op implementatie.
 *
 * Installatie (alleen wanneer je Sentry gaat gebruiken):
 *   npm install @sentry/node
 *
 * Env:
 *   SENTRY_DSN           — https://xxx@sentry.io/yyy (verplicht voor activatie)
 *   SENTRY_ENV           — 'production' | 'staging' (default: NODE_ENV)
 *   SENTRY_TRACES_RATE   — 0.0–1.0 (default 0 = geen performance-tracing)
 */

'use strict';

const DSN = process.env.SENTRY_DSN || '';

let _sentry = null;
let _initialized = false;

function _init() {
  if (_initialized) return _sentry;
  _initialized = true;
  if (!DSN) return null;

  try {
    // Laden alleen wanneer nodig
    _sentry = require('@sentry/node');
    _sentry.init({
      dsn: DSN,
      environment:     process.env.SENTRY_ENV || process.env.NODE_ENV || 'production',
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_RATE || '0'),
      release:         process.env.SENTRY_RELEASE,
      beforeSend(event) {
        // Niet-kritieke info van gebruikers strippen (we zitten onder AVG)
        if (event.request?.cookies) delete event.request.cookies;
        return event;
      },
    });
    console.log('[sentry] initialized');
  } catch (err) {
    console.warn('[sentry] DSN set but @sentry/node not installed:', err.message);
    _sentry = null;
  }
  return _sentry;
}

function isEnabled() { return Boolean(_init()); }

function captureException(err, context = {}) {
  const s = _init();
  if (!s) return;
  s.withScope(scope => {
    for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
    s.captureException(err);
  });
}

function captureMessage(msg, level = 'info', context = {}) {
  const s = _init();
  if (!s) return;
  s.withScope(scope => {
    for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
    s.captureMessage(msg, level);
  });
}

// Express error-handler middleware (drop-in via app.use(errorHandler()))
function errorHandler() {
  return (err, req, res, next) => {
    captureException(err, {
      url: req.originalUrl,
      method: req.method,
      userId: req.user?.id,
    });
    next(err);
  };
}

module.exports = { isEnabled, captureException, captureMessage, errorHandler };
