import { db } from './client'

export async function listOrders(customerId: string) {
  return db.query('select * from orders where customer_id = $1', [customerId])
}
