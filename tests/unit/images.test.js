'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { imageType, isAttachmentId, localizeImages, signedUrlFresh } = require('../../lib/images');

const ID = 'c2a5e86d-0ad1-4032-8e30-56e098129283';
const jwt = (exp) => `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig_-x`;
const signed = (ext, exp = 2000000000) => `https://private-user-images.githubusercontent.com/338/681-${ID}.${ext}?jwt=${jwt(exp)}`;

test('localizeImages points uploaded images and their links at the local route', () => {
  const remembered = new Map();
  const html = [
    `<a target="_blank" href="${signed('png')}"><img src="${signed('png')}" width="420" alt="x"></a>`,
    `<img src="https://github.com/user-attachments/assets/${ID}" alt="plain">`,
    `<video src="${signed('mp4')}"></video>`,
    `<a href="${signed('mp4')}">video</a>`,
    `<a href="https://github.com/user-attachments/assets/${ID}">a zip</a>`,
    '<img src="https://camo.githubusercontent.com/abc" alt="external">',
  ].join('\n');
  assert.equal(localizeImages(html, remembered), [
    `<a target="_blank" href="/api/image/${ID}"><img src="/api/image/${ID}" width="420" alt="x"></a>`,
    `<img src="/api/image/${ID}" alt="plain">`,
    `<video src="${signed('mp4')}"></video>`,
    `<a href="${signed('mp4')}">video</a>`,
    `<a href="https://github.com/user-attachments/assets/${ID}">a zip</a>`,
    '<img src="https://camo.githubusercontent.com/abc" alt="external">',
  ].join('\n'));
  assert.equal(remembered.get(ID), signed('png'));
  assert.equal(localizeImages('', remembered), '');
  assert.equal(localizeImages(null, remembered), null);
});

test('signedUrlFresh reads the expiry out of the link', () => {
  assert.equal(signedUrlFresh(signed('png', 1000), 900000), true);
  assert.equal(signedUrlFresh(signed('png', 1000), 990000), false);
  assert.equal(signedUrlFresh('https://example.com/x.png'), false);
  assert.equal(signedUrlFresh('https://example.com/x.png?jwt=garbage'), false);
});

test('imageType trusts the bytes, not the name', () => {
  const bytes = (...parts) => Buffer.concat(parts.map((part) => Buffer.from(part, typeof part === 'string' ? 'latin1' : undefined)));
  assert.equal(imageType(bytes([0x89], 'PNG\r\n\x1a\n')), 'image/png');
  assert.equal(imageType(bytes([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageType(bytes('GIF89a')), 'image/gif');
  assert.equal(imageType(bytes('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(imageType(bytes('\0\0\0\x1cftypavif')), 'image/avif');
  assert.equal(imageType(bytes([0, 0, 1, 0, 1, 0])), 'image/x-icon');
  const utf8 = (text) => Buffer.from(text, 'utf8');
  assert.equal(imageType(utf8('﻿<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml');
  assert.equal(imageType(utf8('<svg width="1" height="1"></svg>')), 'image/svg+xml');
  assert.equal(imageType(utf8('<html><body><svg></svg></body></html>')), null);
  assert.equal(imageType(bytes('not an image <svg>')), null);
  assert.equal(imageType(bytes('<!doctype html><title>Sign in</title>')), null);
  assert.equal(imageType(Buffer.alloc(0)), null);
});

test('isAttachmentId accepts only asset ids', () => {
  assert.equal(isAttachmentId(ID), true);
  assert.equal(isAttachmentId('../../etc/passwd'), false);
  assert.equal(isAttachmentId(`${ID}.png`), false);
});
