/**
 * Exact BigInt nano-USD arithmetic.
 * 1.000000000 USD = 1_000_000_000n nanoUSD (1e9).
 * 1 USDC atomic unit (6 decimals) = 1_000n nanoUSD.
 */

export const NANO_PER_USD = 1_000_000_000n
export const NANO_PER_USDC_ATOMIC = 1_000n // USDC has 6 decimals
export const BPS_DENOMINATOR = 10_000n

/**
 * Parse a decimal USD string or number (e.g. "0.0015", 2, "12.3456789") into exact BigInt nanoUSD.
 * @param {string | number | bigint} usd
 * @returns {bigint}
 */
export function usdToNano(usd) {
  if (typeof usd === 'bigint') return usd
  const str = String(usd).trim()
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`Invalid USD amount: ${usd}`)
  }
  const neg = str.startsWith('-')
  const clean = neg ? str.slice(1) : str
  const [whole, frac = ''] = clean.split('.')
  const paddedFrac = (frac + '000000000').slice(0, 9)
  const val = BigInt(whole) * NANO_PER_USD + BigInt(paddedFrac)
  return neg ? -val : val
}

/**
 * Format BigInt nanoUSD into a human-readable fixed-point USD string (up to 9 decimals, trailing zeros trimmed to min 2 or 6).
 * @param {bigint | string | number} nano
 * @param {number} [minDecimals=6]
 * @returns {string}
 */
export function nanoToUsd(nano, minDecimals = 6) {
  const n = BigInt(nano)
  const neg = n < 0n
  const abs = neg ? -n : n
  const whole = abs / NANO_PER_USD
  const frac = String(abs % NANO_PER_USD).padStart(9, '0')
  let trimmed = frac.replace(/0+$/, '')
  if (trimmed.length < minDecimals) {
    trimmed = frac.slice(0, minDecimals)
  }
  return `${neg ? '-' : ''}${whole}.${trimmed}`
}

/**
 * Convert USDC 6-decimal atomic string/number to nanoUSD.
 * @param {string | number | bigint} atomic
 * @returns {bigint}
 */
export function usdcAtomicToNano(atomic) {
  return BigInt(atomic) * NANO_PER_USDC_ATOMIC
}

/**
 * Convert nanoUSD to USDC 6-decimal atomic units (rounded down so vault never overpays).
 * @param {bigint} nano
 * @returns {bigint}
 */
export function nanoToUsdcAtomic(nano) {
  return BigInt(nano) / NANO_PER_USDC_ATOMIC
}

/**
 * Compute exact P2P settlement split with zero dust loss (platform absorbs +/-1 nano rounding remainder).
 * Default: 500 bps (5%) total fee -> Seller 95%, Referrer 15% of fee (0.75% = 75 bps), Platform 4.25% (425 bps).
 *
 * @param {bigint} grossNano
 * @param {object} [opts]
 * @param {number} [opts.platformFeeBps=500]
 * @param {number} [opts.referrerShareBps=1500] - share of platformFeeBps (1500 = 15% of fee)
 * @param {boolean} [opts.hasReferrer=false]
 */
export function computeP2PSplit(grossNano, opts = {}) {
  const gross = BigInt(grossNano)
  if (gross < 0n) throw new Error('grossNano must be non-negative')
  const feeBps = BigInt(opts.platformFeeBps ?? 500)
  const refShareBps = BigInt(opts.referrerShareBps ?? 1500)

  const totalFee = (gross * feeBps) / BPS_DENOMINATOR
  const sellerNano = gross - totalFee
  const referrerNano = opts.hasReferrer
    ? (totalFee * refShareBps) / BPS_DENOMINATOR
    : 0n
  const platformNano = totalFee - referrerNano

  return {
    grossNano: gross,
    sellerNano,
    platformNano,
    referrerNano,
    totalFeeNano: totalFee,
  }
}

/**
 * Compute House Fallback Upstream charge & spread.
 * Buyer pays wholesale + marginBps (default 1000 bps = +10%).
 * If buyer was referred, referrer receives referrerShareBps (15%) of the margin.
 *
 * @param {bigint} wholesaleNano
 * @param {object} [opts]
 * @param {number} [opts.marginBps=1000]
 * @param {number} [opts.referrerShareBps=1500]
 * @param {boolean} [opts.hasReferrer=false]
 */
export function computeHouseSplit(wholesaleNano, opts = {}) {
  const wholesale = BigInt(wholesaleNano)
  if (wholesale < 0n) throw new Error('wholesaleNano must be non-negative')
  const marginBps = BigInt(opts.marginBps ?? 1000)
  const refShareBps = BigInt(opts.referrerShareBps ?? 1500)

  const marginNano = (wholesale * marginBps) / BPS_DENOMINATOR
  const buyerTotalNano = wholesale + marginNano
  const referrerNano = opts.hasReferrer
    ? (marginNano * refShareBps) / BPS_DENOMINATOR
    : 0n
  const platformNetMarginNano = marginNano - referrerNano

  return {
    buyerTotalNano,
    wholesaleNano: wholesale,
    marginNano,
    platformNetMarginNano,
    referrerNano,
  }
}
