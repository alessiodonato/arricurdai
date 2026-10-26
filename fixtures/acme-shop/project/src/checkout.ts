import { applyDiscount, toCents } from './pricing'
import type { Cart } from './cart'

export function computeTotals(cart: Cart) {
  const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.qty, 0)
  const discounted = applyDiscount(subtotal, cart.coupon)
  return { subtotal: toCents(subtotal), total: toCents(discounted) }
}
