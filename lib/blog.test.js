'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mdToHtml } = require('./blog');

test('mdToHtml headings', () => {
  assert.equal(mdToHtml('# Title'), '<h1>Title</h1>');
  assert.equal(mdToHtml('## Sub'), '<h2>Sub</h2>');
  assert.equal(mdToHtml('### Sub sub'), '<h3>Sub sub</h3>');
});

test('mdToHtml bold + italic', () => {
  assert.match(mdToHtml('This is **bold** text.'), /<strong>bold<\/strong>/);
  assert.match(mdToHtml('This is _italic_ text.'), /<em>italic<\/em>/);
});

test('mdToHtml links', () => {
  const out = mdToHtml('Check [our site](https://runningdinner.app)');
  assert.match(out, /<a href="https:\/\/runningdinner\.app">our site<\/a>/);
});

test('mdToHtml lists', () => {
  const out = mdToHtml('- first\n- second\n- third');
  assert.match(out, /<ul>/);
  assert.match(out, /<li>first<\/li>/);
  assert.match(out, /<li>third<\/li>/);
});

test('mdToHtml paragraphs', () => {
  const out = mdToHtml('First paragraph.\n\nSecond paragraph.');
  assert.match(out, /<p>First paragraph\.<\/p>/);
  assert.match(out, /<p>Second paragraph\.<\/p>/);
});

test('mdToHtml code blocks escape HTML', () => {
  const out = mdToHtml('```js\nconst x = <y>;\n```');
  assert.match(out, /<pre><code>/);
  assert.match(out, /const x = &lt;y&gt;;/);
});

test('mdToHtml does not wrap headings in <p>', () => {
  const out = mdToHtml('# My Title\n\nParagraph here.');
  assert.match(out, /<h1>My Title<\/h1>/);
  assert.doesNotMatch(out, /<p><h1>/);
});

test('mdToHtml renders GFM tables', () => {
  const md = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n';
  const out = mdToHtml(md);
  assert.match(out, /<table>/);
  assert.match(out, /<thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead>/);
  assert.match(out, /<tbody>.*<td>1<\/td><td>2<\/td>.*<td>3<\/td><td>4<\/td>/s);
});

test('mdToHtml renders task-list checkboxes', () => {
  const out = mdToHtml('- [ ] Todo\n- [x] Done\n');
  assert.match(out, /<li class="task"><input type="checkbox" disabled> Todo<\/li>/);
  assert.match(out, /<li class="task"><input type="checkbox" disabled checked> Done<\/li>/);
});

test('mdToHtml renders horizontal rules', () => {
  const out = mdToHtml('Para one.\n\n---\n\nPara two.');
  assert.match(out, /<hr>/);
  assert.match(out, /<p>Para one\.<\/p>/);
  assert.match(out, /<p>Para two\.<\/p>/);
});
