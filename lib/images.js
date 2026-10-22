'use strict';

// GitHub renders images uploaded to private repositories as links signed for five minutes, so
// a page left open loses them. The page gets stable local links instead (/api/image/<id>), and
// the server fetches each image with the token it already holds.

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IMAGE_EXT = '(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)';
const SIGNED_RE = new RegExp(`^https://private-user-images\\.githubusercontent\\.com/\\d+/\\d+-(${ID})\\.([A-Za-z0-9]+)\\?jwt=[\\w.-]+$`);
const ATTACHMENT_RE = new RegExp(`^https://github\\.com/user-attachments/assets/(${ID})$`);
const IMAGE_EXT_RE = new RegExp(`^${IMAGE_EXT}$`, 'i');
const ID_RE = new RegExp(`^${ID}$`);
const SIGNED_LIMIT = 2000;
// An XML declaration, comments and a doctype may come before the <svg> root.
const SVG_START_RE = /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>/]/i;

function localImageUrl(id) {
  return `/api/image/${id}`;
}

// Points <img> sources and the links GitHub wraps them in at the local route. signed (a Map)
// remembers each signed link, which still works for a few minutes if the asset id alone doesn't.
function localizeImages(html, signed) {
  if (!html) {
    return html;
  }
  return html.replace(/<(img|a)\b[^>]*>/gi, (tag, name) => {
    const attribute = name.toLowerCase() === 'img' ? 'src' : 'href';
    return tag.replace(new RegExp(`(\\s${attribute}=")([^"]*)"`, 'i'), (whole, prefix, value) => {
      const id = attachmentId(value.replace(/&amp;/g, '&'), attribute === 'src', signed);
      return id ? `${prefix}${localImageUrl(id)}"` : whole;
    });
  });
}

function attachmentId(href, inImg, signed) {
  const match = href.match(SIGNED_RE);
  if (match && (inImg || IMAGE_EXT_RE.test(match[2]))) {
    if (signed) {
      signed.delete(match[1]);
      signed.set(match[1], href);
      if (signed.size > SIGNED_LIMIT) {
        signed.delete(signed.keys().next().value);
      }
    }
    return match[1];
  }
  const plain = inImg && href.match(ATTACHMENT_RE);
  return plain ? plain[1] : null;
}

function isAttachmentId(value) {
  return ID_RE.test(String(value));
}

// Whether a signed link's token is still good for a few more seconds.
function signedUrlFresh(href, now = Date.now()) {
  try {
    const payload = new URL(href).searchParams.get('jwt').split('.')[1];
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(exp) * 1000 - 15000 > now;
  } catch (err) {
    return false;
  }
}

// The image type from a file's first bytes, or null when it isn't an image a browser shows.
function imageType(bytes) {
  if (!bytes || !bytes.length) {
    return null;
  }
  const ascii = (start, end) => bytes.subarray(start, end).toString('latin1');
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (ascii(0, 4) === 'GIF8') {
    return 'image/gif';
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) {
    return 'image/avif';
  }
  if (ascii(0, 2) === 'BM') {
    return 'image/bmp';
  }
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return 'image/x-icon';
  }
  const text = bytes.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
  if (SVG_START_RE.test(text)) {
    return 'image/svg+xml';
  }
  return null;
}

module.exports = {
  imageType,
  isAttachmentId,
  localImageUrl,
  localizeImages,
  signedUrlFresh,
};
