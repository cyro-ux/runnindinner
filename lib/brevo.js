/**
 * Brevo (ex-Sendinblue) — transactional email wrapper.
 *
 * Activated only when `BREVO_API_KEY` environment variable is set. Otherwise
 * this module exports `isConfigured() === false` and the app continues to use
 * nodemailer/SMTP via the existing sendMail() pathway.
 *
 * API reference: https://developers.brevo.com/reference/sendtransacemail
 *
 * Usage:
 *   const brevo = require('./brevo');
 *   if (brevo.isConfigured()) await brevo.sendTransactional({ to, subject, html });
 */

'use strict';

const https = require('node:https');

const API_KEY = process.env.BREVO_API_KEY || '';
const FROM_EMAIL = process.env.BREVO_FROM_EMAIL || 'noreply@runningdinner.app';
const FROM_NAME  = process.env.BREVO_FROM_NAME  || 'Running Dinner Planner';

function isConfigured() {
  return Boolean(API_KEY);
}

function _request(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host: 'api.brevo.com',
      method: 'POST',
      path,
      headers: {
        'api-key': API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'application/json',
      },
      timeout: 15000,
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => { data += c; });
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data || '{}') }); }
        catch { resolve({ status: resp.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('brevo timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Send a transactional email via Brevo.
 *
 * @param {object} opts
 * @param {string|string[]} opts.to    single email or array of emails
 * @param {string} opts.subject
 * @param {string} opts.html           HTML body
 * @param {string} [opts.text]         optional plain-text alt
 * @param {string} [opts.replyTo]      email for Reply-To header
 * @param {object} [opts.params]       template params (for template-based sends)
 * @param {number} [opts.templateId]   if set, use Brevo template instead of inline html
 */
async function sendTransactional({ to, subject, html, text, replyTo, params, templateId }) {
  if (!isConfigured()) throw new Error('[brevo] not configured');

  const toArr = (Array.isArray(to) ? to : [to]).map(e => ({ email: e }));
  const body = {
    sender: { email: FROM_EMAIL, name: FROM_NAME },
    to: toArr,
    subject,
  };
  if (templateId) {
    body.templateId = templateId;
    if (params) body.params = params;
  } else {
    body.htmlContent = html;
    if (text) body.textContent = text;
  }
  if (replyTo) body.replyTo = { email: replyTo };

  const resp = await _request('/v3/smtp/email', body);
  if (resp.status >= 200 && resp.status < 300) {
    return { ok: true, messageId: resp.body?.messageId };
  }
  throw new Error(`[brevo] ${resp.status}: ${JSON.stringify(resp.body)}`);
}

/**
 * Add a contact to a Brevo list (for marketing lists: NL, EN, ES, segments).
 */
async function addContactToList({ email, listIds, attributes }) {
  if (!isConfigured()) throw new Error('[brevo] not configured');
  const body = {
    email,
    listIds: Array.isArray(listIds) ? listIds : [listIds],
    updateEnabled: true,
  };
  if (attributes) body.attributes = attributes;
  const resp = await _request('/v3/contacts', body);
  if (resp.status >= 200 && resp.status < 300) return { ok: true };
  // 400 "Contact already exist" is not fatal if updateEnabled: true worked elsewhere
  throw new Error(`[brevo] ${resp.status}: ${JSON.stringify(resp.body)}`);
}

module.exports = { isConfigured, sendTransactional, addContactToList };
