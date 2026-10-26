export type CartItem = { sku: string; price: number; qty: number }
export type Cart = { items: CartItem[]; coupon?: string }

export function addItem(cart: Cart, item: CartItem): Cart {
  return { ...cart, items: [...cart.items, item] }
}

export function removeItem(cart: Cart, sku: string): Cart {
  return { ...cart, items: cart.items.filter((item) => item.sku !== sku) }
}
