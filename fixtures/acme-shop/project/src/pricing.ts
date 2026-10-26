export const TAX_RATE = 0.22

export function toCents(amount: number) {
  return Math.round(amount * 100)
}

export function applyDiscount(amount: number, coupon?: string) {
  if (coupon === 'WELCOME10') return amount * 0.9
  if (amount > 100) return amount * 0.9
  return amount
}
