'use strict';

const crypto = require('crypto');

const SCRYPT_N = 16384;
const KEYLEN = 64;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const ALIAS_ONE = ['Ivory', 'Chalk', 'Rail', 'Bank', 'Draw', 'Follow', 'Break', 'Safety', 'Corner', 'Side',
  'Cut', 'Combo', 'Carom', 'Jump', 'Spot', 'Rack', 'Bridge', 'Cue', 'Ferrule', 'Shaft',
  'Kitchen', 'Snooker', 'Nine', 'Eight', 'Ten', 'Straight', 'Rotation', 'Lag', 'Cushion', 'Pocket'];

const ALIAS_TWO = ['Runner', 'Shooter', 'Stroke', 'Ghost', 'Road', 'Sharp', 'Ace', 'Cannon', 'Rocket', 'Ranger',
  'Sentinel', 'Fox', 'Hawk', 'Wolf', 'Otter', 'Crane', 'Marlin', 'Comet', 'Anchor', 'Pilot',
  'Mason', 'Tinker', 'Nomad', 'Vector', 'Delta', 'Echo', 'Lantern', 'Compass', 'Harbor', 'Quarry'];

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: 8, p: 1 });
  return 'scrypt$' + SCRYPT_N + '$' + salt.toString('hex') + '$' + dk.toString('hex');
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');
    const dk = crypto.scryptSync(password, salt, expected.length, { N: Number(parts[1]), r: 8, p: 1 });
    return crypto.timingSafeEqual(dk, expected);
  } catch (err) {
    return false;
  }
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes || 32).toString('hex');
}

function groupedCode(groups, size) {
  const raw = crypto.randomBytes(groups * size);
  const out = [];
  for (let g = 0; g < groups; g++) {
    let chunk = '';
    for (let i = 0; i < size; i++) {
      chunk += CODE_ALPHABET[raw[g * size + i] % CODE_ALPHABET.length];
    }
    out.push(chunk);
  }
  return out.join('-');
}

function inviteCode() {
  return groupedCode(4, 4);
}

function recoveryCode() {
  return groupedCode(2, 5);
}

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 31];
  }
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    value = (value << 5) | B32.indexOf(clean[i]);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(key, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 4294967296), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1] & 15;
  const bin = ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);
  return String(bin % 1000000).padStart(6, '0');
}

function verifyTotp(secret, token, drift) {
  const clean = String(token || '').replace(/[^0-9]/g, '');
  if (clean.length !== 6 || !secret) return false;
  const key = base32Decode(secret);
  if (!key.length) return false;
  const counter = Math.floor(Date.now() / 30000);
  const window = typeof drift === 'number' ? drift : 1;
  let ok = false;
  for (let i = -window; i <= window; i++) {
    const candidate = hotp(key, counter + i);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(clean))) {
      ok = true;
    }
  }
  return ok;
}

function otpauthUrl(secret, account, issuer) {
  return 'otpauth://totp/' + encodeURIComponent(issuer) + ':' + encodeURIComponent(account) +
    '?secret=' + secret +
    '&issuer=' + encodeURIComponent(issuer) +
    '&algorithm=SHA1&digits=6&period=30';
}

function hmacHex(pepper, value) {
  return crypto.createHmac('sha256', String(pepper)).update(String(value)).digest('hex');
}

function hashRecoveryCode(pepper, code) {
  return hmacHex(pepper, 'recovery:' + normalizeCode(code));
}

function anonAlias(pepper, documentId, userId) {
  const digest = hmacHex(pepper, 'alias:' + documentId + ':' + userId);
  const a = parseInt(digest.slice(0, 4), 16) % ALIAS_ONE.length;
  const b = parseInt(digest.slice(4, 8), 16) % ALIAS_TWO.length;
  return ALIAS_ONE[a] + ' ' + ALIAS_TWO[b] + ' ' + digest.slice(8, 12).toUpperCase();
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  hashPassword,
  verifyPassword,
  randomToken,
  inviteCode,
  recoveryCode,
  normalizeCode,
  generateTotpSecret,
  verifyTotp,
  otpauthUrl,
  hmacHex,
  hashRecoveryCode,
  anonAlias,
  safeEqual
};
