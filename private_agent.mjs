#!/usr/bin/env node
/**
 * RELAY confidential-job SDK, Node >=22.12.0.
 * Encryption occurs in this local process before the encrypted transport call.
 * Wallet signatures authenticate separate RSA content-encryption keys. Private
 * keys never belong in an API payload; persist only password-encrypted backups.
 * Long-lived RSA encryption keys do not provide forward secrecy: compromise of
 * a private content key can expose recorded messages encrypted to that key.
 */
import { webcrypto, createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Keypair, StrKey } from '@stellar/stellar-sdk/base';

const subtle = webcrypto.subtle;
export const PRIVATE_IDENTITY_PROTOCOL = 'relay-private-identity/1';
export const PRIVATE_MESSAGE_PROTOCOL = 'relay-private-message/1';
export const PRIVATE_BACKUP_PROTOCOL = 'relay-private-backup/1';
export const PRIVATE_ATTACHMENT_PROTOCOL = 'relay-private-attachment/1';
export const MAX_PRIVATE_MESSAGE_BYTES = 24_000;
export const MAX_PRIVATE_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_KEY_LIFETIME = 90 * 86400;
const BACKUP_ITERATIONS = 600_000;
const IDENTITY_FIELDS = ['protocol','purpose','site','wallet','issued_at','expires_at','previous_key_id','key_id','public_key','signature'];
const HEADER_FIELDS = ['protocol','site','thread_id','id','kind','sender_wallet','recipient_wallet','sender_key_id','recipient_key_id'];
const MESSAGE_FIELDS = [...HEADER_FIELDS,'iv','ciphertext','wrapped_keys','signature'];
const MESSAGE_KINDS = new Set(['request','proposal','message','preview','delivery','evidence']);
const hash = value => createHash('sha256').update(value).digest();
const fail = message => { throw new Error(message); };
const clock = () => Math.floor(Date.now() / 1000);
const isWallet = value => typeof value === 'string' && value.length === 56 && StrKey.isValidEd25519PublicKey(value);
const isKeyId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const isMessageId = value => typeof value === 'string' && /^message-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const isThreadId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
function exact(value, fields, label) {
  if (!isObject(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) fail(`Invalid ${label} fields`);
}
/** Canonical JSON has sorted object keys, bounded shape and finite numbers. */
export function canonicalPrivateJson(value, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 10000 || depth > 20) fail('Private JSON is too complex');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonicalPrivateJson(item, depth + 1, budget)).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalPrivateJson(value[key], depth + 1, budget)).join(',') + '}';
  fail('Private payload must contain JSON values only');
}
function origin(value) {
  try {
    const url = new URL(value);
    if (!['https:','http:'].includes(url.protocol) || url.origin === 'null' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { fail('A Site origin without a path or credentials is required'); }
}
function b64(value, maximum, length, label) {
  if (typeof value !== 'string' || !value.length || value.length > 4 * Math.ceil(maximum / 3) || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(`Invalid ${label}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maximum || (length !== undefined && bytes.length !== length) || bytes.toString('base64') !== value) fail(`Invalid ${label}`);
  return bytes;
}
function unsigned(value) { const { signature, ...rest } = value; return rest; }
function signature(value, signer) {
  if (!signer || typeof signer.sign !== 'function' || typeof signer.publicKey !== 'function') fail('A local Stellar signer is required');
  return Buffer.from(signer.sign(hash(canonicalPrivateJson(value)))).toString('base64');
}
function verifySignature(value, wallet) {
  try { return Keypair.fromPublicKey(wallet).verify(hash(canonicalPrivateJson(unsigned(value))), b64(value.signature, 64, 64, 'wallet signature')); }
  catch { return false; }
}
async function rsaPublic(record) {
  const bytes = b64(record.public_key, 1024, undefined, 'RSA public key');
  if (hash(bytes).toString('hex') !== record.key_id) fail('Encryption public-key fingerprint does not match');
  let key;
  try { key = await subtle.importKey('spki', bytes, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']); }
  catch { fail('Unsupported content-encryption public key'); }
  if (key.algorithm.modulusLength !== 3072 || Buffer.from(key.algorithm.publicExponent).toString('hex') !== '010001') fail('RSA-OAEP 3072-bit public key with exponent 65537 required');
  return key;
}
/** Verify a wallet-bound encryption key against an independently obtained pin. */
export async function verifyPrivateIdentity(record, { site, expectedWallet, pinnedKeyId, allowExpired = false, now = clock() } = {}) {
  exact(record, IDENTITY_FIELDS, 'identity');
  const expectedSite = origin(site);
  if (!isWallet(expectedWallet) || !isKeyId(pinnedKeyId)) fail('Expected wallet and out-of-band encryption-key fingerprint are required');
  if (record.protocol !== PRIVATE_IDENTITY_PROTOCOL || record.purpose !== 'content-encryption' || record.site !== expectedSite || record.wallet !== expectedWallet || record.key_id !== pinnedKeyId) fail('Encryption identity does not match its wallet, Site, or pinned key');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(record.issued_at) || !Number.isSafeInteger(record.expires_at) || record.issued_at < 1 || record.issued_at > now + 60 || record.expires_at <= record.issued_at || record.expires_at - record.issued_at > MAX_KEY_LIFETIME || (!allowExpired && record.expires_at <= now)) fail('Encryption identity is expired, not yet valid, or outside its lifetime limit');
  if (record.previous_key_id !== null && (!isKeyId(record.previous_key_id) || record.previous_key_id === record.key_id)) fail('Invalid previous encryption-key fingerprint');
  if (!verifySignature(record, expectedWallet)) fail('Encryption identity wallet signature is invalid');
  const publicKey = await rsaPublic(record);
  return { record, publicKey };
}
/** Returns a local CryptoKey plus a signed PUBLIC record safe to register. */
export async function generatePrivateIdentity({ site, signer, lifetimeSeconds = 30 * 86400, previousKeyId = null, now = clock() } = {}) {
  const normalizedSite = origin(site);
  if (!signer || !isWallet(signer.publicKey?.()) || !Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > MAX_KEY_LIFETIME || !Number.isSafeInteger(now) || now < 1 || (previousKeyId !== null && !isKeyId(previousKeyId))) fail('Valid signer, key lifetime and previous key fingerprint required');
  const pair = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['encrypt','decrypt']);
  const spki = Buffer.from(await subtle.exportKey('spki', pair.publicKey));
  const record = { protocol: PRIVATE_IDENTITY_PROTOCOL, purpose: 'content-encryption', site: normalizedSite, wallet: signer.publicKey(), issued_at: now, expires_at: now + lifetimeSeconds, previous_key_id: previousKeyId, key_id: hash(spki).toString('hex'), public_key: spki.toString('base64') };
  record.signature = signature(record, signer);
  return { record, privateKey: pair.privateKey };
}
function messageHeader(envelope) { return Object.fromEntries(HEADER_FIELDS.map(key => [key, envelope[key]])); }
export function privateMessageAdditionalData(envelope) { return Buffer.from(canonicalPrivateJson(messageHeader(envelope))); }
function validateMessage(envelope, expected) {
  exact(envelope, MESSAGE_FIELDS, 'message');
  if (!isObject(expected)) fail('An exact expected message context is required');
  const fields = { site: origin(expected.site), thread_id: expected.threadId, id: expected.id, kind: expected.kind, sender_wallet: expected.senderWallet, recipient_wallet: expected.recipientWallet, sender_key_id: expected.senderKeyId, recipient_key_id: expected.recipientKeyId };
  if (!isThreadId(fields.thread_id) || !isMessageId(fields.id) || !MESSAGE_KINDS.has(fields.kind) || !isWallet(fields.sender_wallet) || !isWallet(fields.recipient_wallet) || fields.sender_wallet === fields.recipient_wallet || !isKeyId(fields.sender_key_id) || !isKeyId(fields.recipient_key_id)) fail('Expected message context is incomplete');
  if (envelope.protocol !== PRIVATE_MESSAGE_PROTOCOL || Object.entries(fields).some(([key,value]) => envelope[key] !== value)) fail('Message context differs from the expected transaction, parties, keys, or purpose');
  b64(envelope.iv, 12, 12, 'message IV');
  const ciphertext = b64(envelope.ciphertext, MAX_PRIVATE_MESSAGE_BYTES + 16, undefined, 'message ciphertext');
  if (ciphertext.length < 16) fail('Message ciphertext is truncated');
  exact(envelope.wrapped_keys, [envelope.sender_wallet, envelope.recipient_wallet], 'wrapped-key recipients');
  for (const wallet of [envelope.sender_wallet, envelope.recipient_wallet]) b64(envelope.wrapped_keys[wallet], 384, 384, 'wrapped content key');
  b64(envelope.signature, 64, 64, 'message signature');
}
async function localIdentity(identity, site, allowExpired = true) {
  if (!identity || !identity.privateKey || identity.privateKey.type !== 'private' || identity.privateKey.algorithm?.name !== 'RSA-OAEP' || identity.privateKey.algorithm?.modulusLength !== 3072 || identity.privateKey.algorithm?.hash?.name !== 'SHA-256') fail('A local private encryption identity is required');
  const checked = await verifyPrivateIdentity(identity.record, { site, expectedWallet: identity.record?.wallet, pinnedKeyId: identity.record?.key_id, allowExpired });
  return checked;
}
/** Seal JSON locally. Publish ONLY the returned envelope, never sender.privateKey. */
export async function sealPrivateMessage({ site, threadId, id = 'message-' + randomUUID(), kind, sender, recipient, recipientKeyId, signer, payload } = {}) {
  const expectedSite = origin(site);
  const self = await localIdentity(sender, expectedSite, false);
  if (!signer || signer.publicKey?.() !== self.record.wallet) fail('Message signer does not own the sender encryption identity');
  const peer = await verifyPrivateIdentity(recipient, { site: expectedSite, expectedWallet: recipient?.wallet, pinnedKeyId: recipientKeyId });
  if (self.record.wallet === peer.record.wallet || !isThreadId(threadId) || !isMessageId(id) || !MESSAGE_KINDS.has(kind)) fail('Two distinct parties and valid message context required');
  const plaintext = Buffer.from(canonicalPrivateJson(payload));
  if (plaintext.length > MAX_PRIVATE_MESSAGE_BYTES) fail('Private message exceeds 24000 bytes; encrypt attachments separately');
  const header = { protocol: PRIVATE_MESSAGE_PROTOCOL, site: expectedSite, thread_id: threadId, id, kind, sender_wallet: self.record.wallet, recipient_wallet: peer.record.wallet, sender_key_id: self.record.key_id, recipient_key_id: peer.record.key_id };
  const aad = privateMessageAdditionalData(header), label = hash(aad), rawKey = randomBytes(32), iv = randomBytes(12);
  try {
    const aes = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const [ciphertext, wrappedSender, wrappedRecipient] = await Promise.all([
      subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, aes, plaintext),
      subtle.encrypt({ name: 'RSA-OAEP', label }, self.publicKey, rawKey),
      subtle.encrypt({ name: 'RSA-OAEP', label }, peer.publicKey, rawKey),
    ]);
    const envelope = { ...header, iv: iv.toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64'), wrapped_keys: { [self.record.wallet]: Buffer.from(wrappedSender).toString('base64'), [peer.record.wallet]: Buffer.from(wrappedRecipient).toString('base64') } };
    envelope.signature = signature(envelope, signer);
    return envelope;
  } finally { rawKey.fill(0); plaintext.fill(0); }
}
/** Caller supplies pinned context; untrusted message fields are never expectations. */
export async function openPrivateMessage({ envelope, identity, sender, expected } = {}) {
  validateMessage(envelope, expected);
  const self = await localIdentity(identity, expected.site, true);
  await verifyPrivateIdentity(sender, { site: expected.site, expectedWallet: expected.senderWallet, pinnedKeyId: expected.senderKeyId, allowExpired: true });
  const ownWallet = self.record.wallet;
  const ownKey = ownWallet === envelope.sender_wallet ? envelope.sender_key_id : ownWallet === envelope.recipient_wallet ? envelope.recipient_key_id : null;
  if (ownKey !== self.record.key_id) fail('This encryption identity is not an authorized message recipient');
  if (!verifySignature(envelope, envelope.sender_wallet)) fail('Message wallet signature is invalid');
  const aad = privateMessageAdditionalData(envelope);
  let rawKey;
  try {
    rawKey = Buffer.from(await subtle.decrypt({ name: 'RSA-OAEP', label: hash(aad) }, identity.privateKey, b64(envelope.wrapped_keys[ownWallet],384,384,'wrapped content key')));
    if (rawKey.length !== 32) throw new Error();
    const key = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    const plaintext = Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: b64(envelope.iv,12,12,'message IV'), additionalData: aad, tagLength: 128 }, key, b64(envelope.ciphertext,MAX_PRIVATE_MESSAGE_BYTES+16,undefined,'message ciphertext')));
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)); }
    finally { plaintext.fill(0); }
  } catch { fail('Message authentication or local decryption failed'); }
  finally { rawKey?.fill(0); }
}
function passwordBytes(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) fail('Backup password must contain at least 12 characters and at most 1024 UTF-8 bytes');
  return Buffer.from(password);
}
async function backupKey(password, salt, iterations) {
  const bytes = passwordBytes(password);
  try {
    const input = await subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, input, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
  } finally { bytes.fill(0); }
}
/** Explicit local persistence: encrypted PKCS8 only. Never print this identity's key. */
export async function exportPrivateIdentityBackup({ identity, password } = {}) {
  await localIdentity(identity, identity.record?.site, true);
  const salt = randomBytes(16), iv = randomBytes(12), header = { protocol: PRIVATE_BACKUP_PROTOCOL, kdf: 'PBKDF2-SHA256', iterations: BACKUP_ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64') };
  const key = await backupKey(password, salt, BACKUP_ITERATIONS);
  const pkcs8 = Buffer.from(await subtle.exportKey('pkcs8', identity.privateKey));
  const plaintext = Buffer.from(JSON.stringify({ record: identity.record, private_key: pkcs8.toString('base64') }));
  try { return { ...header, ciphertext: Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from(canonicalPrivateJson(header)), tagLength:128 }, key, plaintext)).toString('base64') }; }
  finally { pkcs8.fill(0); plaintext.fill(0); }
}
/** Recovery authenticates the backup and independently pinned public identity. */
export async function importPrivateIdentityBackup({ backup, password, site, expectedWallet, pinnedKeyId } = {}) {
  exact(backup, ['protocol','kdf','iterations','salt','iv','ciphertext'], 'backup');
  if (backup.protocol !== PRIVATE_BACKUP_PROTOCOL || backup.kdf !== 'PBKDF2-SHA256' || backup.iterations !== BACKUP_ITERATIONS) fail('Unsupported encrypted backup parameters');
  const salt = b64(backup.salt,16,16,'backup salt'), iv = b64(backup.iv,12,12,'backup IV');
  const key = await backupKey(password,salt,backup.iterations);
  const { ciphertext,...header } = backup;
  let plaintext, pkcs8;
  try {
    plaintext = Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from(canonicalPrivateJson(header)), tagLength:128 }, key, b64(ciphertext,16384,undefined,'backup ciphertext')));
    const data = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
    exact(data,['record','private_key'],'recovered identity');
    const peer = await verifyPrivateIdentity(data.record,{site,expectedWallet,pinnedKeyId,allowExpired:true});
    pkcs8=b64(data.private_key,4096,undefined,'recovered private key');
    const privateKey=await subtle.importKey('pkcs8',pkcs8,{name:'RSA-OAEP',hash:'SHA-256'},true,['decrypt']);
    const [privateJwk,publicJwk]=await Promise.all([subtle.exportKey('jwk',privateKey),subtle.exportKey('jwk',peer.publicKey)]);
    if (privateJwk.n!==publicJwk.n || privateJwk.e!==publicJwk.e || privateKey.algorithm.modulusLength!==3072) throw new Error();
    return {record:data.record,privateKey};
  } catch { fail('Backup password, authentication, identity pin, or key verification failed'); }
  finally { plaintext?.fill(0); pkcs8?.fill(0); }
}
/** Ciphertext is uploadable; private_metadata MUST stay inside a sealed message. */
export async function encryptPrivateAttachment(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_PRIVATE_ATTACHMENT_BYTES) fail('Attachment must be bytes no larger than 64 MiB');
  const rawKey=randomBytes(32),iv=randomBytes(12),header={protocol:PRIVATE_ATTACHMENT_PROTOCOL,plaintext_bytes:bytes.byteLength};
  try {
    const key=await subtle.importKey('raw',rawKey,'AES-GCM',false,['encrypt']);
    const ciphertext=Buffer.from(await subtle.encrypt({name:'AES-GCM',iv,additionalData:Buffer.from(canonicalPrivateJson(header)),tagLength:128},key,bytes));
    return {ciphertext,private_metadata:{...header,iv:iv.toString('base64'),key:rawKey.toString('base64'),ciphertext_bytes:ciphertext.length,ciphertext_sha256:hash(ciphertext).toString('hex')}};
  } finally {rawKey.fill(0);}
}
export async function decryptPrivateAttachment(ciphertext,metadata) {
  exact(metadata,['protocol','plaintext_bytes','iv','key','ciphertext_bytes','ciphertext_sha256'],'private attachment metadata');
  if(metadata.protocol!==PRIVATE_ATTACHMENT_PROTOCOL || !Number.isSafeInteger(metadata.plaintext_bytes) || metadata.plaintext_bytes<0 || metadata.plaintext_bytes>MAX_PRIVATE_ATTACHMENT_BYTES || metadata.ciphertext_bytes!==metadata.plaintext_bytes+16 || !(ciphertext instanceof Uint8Array) || ciphertext.byteLength!==metadata.ciphertext_bytes || !isKeyId(metadata.ciphertext_sha256) || hash(ciphertext).toString('hex')!==metadata.ciphertext_sha256) fail('Attachment differs from its encrypted metadata');
  const rawKey=b64(metadata.key,32,32,'private attachment key'),iv=b64(metadata.iv,12,12,'attachment IV');
  try {
    const key=await subtle.importKey('raw',rawKey,'AES-GCM',false,['decrypt']);
    return new Uint8Array(await subtle.decrypt({name:'AES-GCM',iv,additionalData:Buffer.from(canonicalPrivateJson({protocol:PRIVATE_ATTACHMENT_PROTOCOL,plaintext_bytes:metadata.plaintext_bytes})),tagLength:128},key,ciphertext));
  } catch {fail('Attachment authentication or local decryption failed');}
  finally {rawKey.fill(0);}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if(process.argv.length!==3 || !['--help','-h'].includes(process.argv[2])) { process.stderr.write('Use --help. This file is an SDK; it never signs or broadcasts payments.\n');process.exitCode=1; }
  else process.stdout.write(`RELAY private-job SDK (Node >=22.12.0)\n\nImport generatePrivateIdentity, sealPrivateMessage and openPrivateMessage from this file.\nRegister only identity.record; identity.privateKey remains local.\nObtain and verify the peer key_id through an independent trusted channel.\nUse exportPrivateIdentityBackup({identity,password}) for encrypted local recovery.\nEncrypt files using encryptPrivateAttachment(bytes); upload ciphertext separately and\nput its URL plus private_metadata INSIDE sealPrivateMessage({...,payload}).\nThe server cannot recover lost keys. Revocation cannot erase a recipient's copies.\nLong-lived RSA content keys do not provide forward secrecy for old ciphertext.\nExternal model providers can process decrypted inputs; check the agreed execution policy.\nOrdinary Stellar payments expose on-chain metadata; this SDK does not anonymize payments.\nSee /downloads/private-market-guide.md for end-to-end API examples.\n`);
}
