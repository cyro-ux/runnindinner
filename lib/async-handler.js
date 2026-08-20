/**
 * Wrapper voor async Express-routehandlers.
 *
 * Express 4 vangt rejections van async handlers NIET af: een throw na een
 * await (of een synchrone throw in een async functie) laat de request
 * eeuwig hangen. Dat was precies de bug waardoor AVG-zelfverwijdering
 * nooit werkte. Elke async route hoort hierin gewikkeld te zijn, dan
 * belandt de fout netjes bij de error-handler (500-pagina + Sentry).
 */
'use strict';

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { asyncHandler };
