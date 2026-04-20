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
  const out = mdToHtml('Check [our site](https://runningdiner.nl)');
  assert.match(out, /<a href="https:\/\/runningdiner\.nl">our site<\/a>/);
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
