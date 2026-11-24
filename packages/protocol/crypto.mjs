import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto'

/**
 * Generate a fresh Ed25519 identity for an autonomous agent or seller worker.
 */
export function generateAgentIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pubJwk = publicKey.export({ format: 'jwk' })
  const privJwk = privateKey.export({ format: 'jwk' })
  const thumbprint = jwkThumbprint(pubJwk)
  return {
    keyId: thumbprint,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: pubJwk.x },
    privateJwk: privJwk,
  }
}

/**
 * RFC 7638 canonical JWK thumbprint for Ed25519 OKP keys.
 */
export function jwkThumbprint(jwk) {
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('Expected Ed25519 OKP JWK')
  }
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`
  return createHash('sha256').update(canonical).digest('base64url')
}

/**
 * Sign a canonical payload string or object with an Ed25519 private JWK.
 * @param {object} privateJwk
 * @param {string | Buffer} message
 * @returns {string} base64url signature
 */
export function signEd25519(privateJwk, message) {
  const keyObj = createPrivateKey({ key: privateJwk, format: 'jwk' })
  const buf = typeof message === 'string' ? Buffer.from(message, 'utf8') : message
  return sign(null, buf, keyObj).toString('base64url')
}

/**
 * Verify an Ed25519 signature against a public JWK.
 * @param {object} publicJwk
 * @param {string | Buffer} message
 * @param {string} signatureB64Url
 * @returns {boolean}
 */
export function verifyEd25519(publicJwk, message, signatureB64Url) {
  try {
    if (!publicJwk || publicJwk.kty !== 'OKP' || publicJwk.crv !== 'Ed25519') return false
    const keyObj = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicJwk.x },
      format: 'jwk',
    })
    const buf = typeof message === 'string' ? Buffer.from(message, 'utf8') : message
    const sigBuf = Buffer.from(signatureB64Url, 'base64url')
    return verify(null, buf, keyObj, sigBuf)
  } catch {
    return false
  }
}

/**
 * Build canonical authentication string for worker WebSocket handshake or withdrawal orders.
 */
export function canonicalAuthMessage({ action, agentId, timestamp, nonce, payloadHash = '' }) {
  return `switch402-v1\n${action}\n${agentId}\n${timestamp}\n${nonce}\n${payloadHash}`
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

export function generateApiKey(prefix = 'ag_live_') {
  return `${prefix}${randomBytes(24).toString('base64url')}`
}

export function hashApiKey(apiKey) {
  return createHash('sha256').update(String(apiKey)).digest('hex')
}

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}
