// bexio API client — public surface.
// Pinned to API version 2.0. Drift smoke-test runs monthly in the worker.

export { BEXIO_API_BASE, BEXIO_AUTH_BASE } from './http.ts';
export { getValidAccessToken } from './auth.ts';
export { listRecurringOrders, getOrder, getOrderRepetition } from './orders.ts';
export { getContact, listContacts } from './contacts.ts';
export { listArticles, getArticle } from './articles.ts';
export { createInvoiceFromOrder, issueInvoice, sendInvoice, getInvoice } from './invoices.ts';
export type { SendInvoiceInput } from './invoices.ts';
export {
  BexioApiError,
  formatContactName,
  mapBexioStatus,
  mapRepetitionToInterval,
  isSupportedBexioInterval,
  type BexioOrder,
  type BexioInvoice,
  type BexioContact,
  type BexioArticle,
  type BexioRepetition,
  type BexioOrderRepetition,
  type CanonicalInterval,
  type RecurringInterval,
  type CreateInvoiceFromOrderInput,
  type BexioErrorClass,
  type MappedBexioStatus,
} from './types.ts';
