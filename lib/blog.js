/**
 * Blog engine — reads markdown files from content/blog/*.md.
 *
 * Each file has YAML-style frontmatter:
 *
 *   ---
 *   title: Hoe organiseer je een running dinner?
 *   slug: hoe-organiseer-je-een-running-dinner
 *   locale: nl
 *   date: 2026-04-20
 *   author: Cyro van Malsen
 *   draft: true
 *   description: Korte meta description voor SEO
 *   keywords: running dinner, organiseren, tips
 *   ---
 *
 *   # Markdown content here
 *
 * draft: true = verborgen voor publiek, zichtbaar in admin.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONTENT_DIR = path.join(__dirname, '..', 'content', 'blog');

// In-memory cache; watch files for changes in production is overkill for now.
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 60000; // 1 min

function _parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    meta[kv[1]] = value;
  }
  return { meta, body: m[2] };
}

// Minimal markdown → HTML (headings, paragraphs, bold/italic, lists, links,
// fenced code blocks, GFM tables, task-list checkboxes, horizontal rules).
// Kept small — no external deps.
function mdToHtml(md) {
  let html = md;

  // Code blocks first (to avoid interference with other rules)
  html = html.replace(/```([a-z]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code>${escaped}</code></pre>`;
  });

  // Horizontal rules: a line containing only --- (3+). Use [ \t]* (non-newline)
  // so we don't accidentally eat the surrounding blank-line separators.
  html = html.replace(/^[ \t]*-{3,}[ \t]*$/gm, '<hr>');

  // GFM-style tables:
  //   | h1 | h2 |
  //   |----|----|
  //   | a  | b  |
  // Detect a header-row followed by a separator-row (dashes with optional colons).
  html = html.replace(
    /(^|\n)((?:\|[^\n]+\|\s*\n))(\|[\s:\-|]+\|\s*\n)((?:\|[^\n]+\|\s*\n?)+)/g,
    (m, pre, header, sep, rows) => {
      const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const head = cells(header);
      const body = rows.trimEnd().split('\n').filter(Boolean).map(cells);
      const thead = '<thead><tr>' + head.map(c => `<th>${c}</th>`).join('') + '</tr></thead>';
      const tbody = '<tbody>' + body.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody>';
      return `${pre}<table>${thead}${tbody}</table>\n`;
    }
  );

  // Headings
  html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Bold & italic (order matters: bold first)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Lists (consecutive - lines become <ul>). Supports GFM task-list checkboxes
  // [ ] / [x]. Keeps the result inline so the outer paragraph-wrapper skips it.
  html = html.replace(/(^|\n)((?:- .+\n?)+)/g, (m, pre, list) => {
    const items = list.trim().split('\n').map(l => {
      const inner = l.replace(/^- /, '');
      const task = inner.match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) {
        const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
        return `  <li class="task"><input type="checkbox" disabled${checked}> ${task[2]}</li>`;
      }
      return `  <li>${inner}</li>`;
    }).join('\n');
    return `${pre}<ul>\n${items}\n</ul>`;
  });

  // Paragraphs: wrap consecutive non-empty non-tag lines in <p>
  html = html.split(/\n\n+/).map(block => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    // Skip wrapping if block already starts with a block-level tag
    if (/^<(h\d|ul|ol|pre|blockquote|div|table|p|hr)\b/i.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('\n\n');

  return html;
}

function _loadAll() {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.md'));
  return files.map(f => {
    const text = fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8');
    const { meta, body } = _parseFrontmatter(text);
    const slug = meta.slug || f.replace(/\.md$/, '');
    return {
      slug,
      title:       meta.title || slug,
      locale:      meta.locale || 'nl',
      date:        meta.date || null,
      author:      meta.author || 'Cyro van Malsen',
      draft:       meta.draft === true,
      description: meta.description || '',
      keywords:    meta.keywords || '',
      body,
      filename:    f,
    };
  });
}

function _getCached() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;
  _cache = _loadAll();
  _cacheTime = Date.now();
  return _cache;
}

function listPublished(locale = 'nl') {
  return _getCached()
    .filter(p => !p.draft && p.locale === locale)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function listAll() {
  // For admin: all posts regardless of draft/locale
  return _getCached().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function getBySlug(slug, locale = 'nl') {
  return _getCached().find(p => p.slug === slug && p.locale === locale);
}

function render(post) {
  return mdToHtml(post.body);
}

function invalidate() { _cache = null; _cacheTime = 0; }

/**
 * Admin helper: toggle `draft: true/false` in the file and invalidate cache.
 */
function setDraft(filename, draft) {
  const fullPath = path.join(CONTENT_DIR, filename);
  if (!fs.existsSync(fullPath)) throw new Error('not found');
  let text = fs.readFileSync(fullPath, 'utf8');
  if (/^draft:/m.test(text)) {
    text = text.replace(/^draft:.*$/m, `draft: ${draft ? 'true' : 'false'}`);
  } else {
    // Inject into frontmatter
    text = text.replace(/^---\n/, `---\ndraft: ${draft ? 'true' : 'false'}\n`);
  }
  fs.writeFileSync(fullPath, text, 'utf8');
  invalidate();
}

module.exports = { listPublished, listAll, getBySlug, render, invalidate, setDraft, mdToHtml };
