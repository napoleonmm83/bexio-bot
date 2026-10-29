// bexio API client — public surface.
// Pinned to API version 2.0. Drift smoke-test runs monthly in the worker.

export { BEXIO_API_BASE, BEXIO_AUTH_BASE, callBexio } from './http.ts';
export { getValidAccessToken } from './auth.ts';
export {
  listRecurringOrders,
  getOrder,
  getOrderRepetition,
  searchOrders,
  listRecurringOrdersSince,
  type OrderSearchCriterion,
} from './orders.ts';
export { getContact, listContacts } from './contacts.ts';
export { getCompanyProfile, isAllowedBexioCompany, type BexioCompanyProfile } from './company.ts';
export { listArticles, getArticle } from './articles.ts';
export {
  createInvoiceFromOrder,
  createInvoiceFromOrderSnapshot,
  createInvoice,
  issueInvoice,
  sendInvoice,
  getInvoice,
  findInvoiceByApiReference,
  searchInvoices,
  listUnpaidInvoices,
  addCustomPosition,
  editCustomPosition,
  deleteCustomPosition,
  NEUTRAL_TAX_ID_FALLBACK,
} from './invoices.ts';
export type { SendInvoiceInput, InvoiceSearchCriterion, CustomPositionInput } from './invoices.ts';
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
  type CreateInvoiceInput,
  type BexioInvoicePositionInput,
  type BexioInvoicePosition,
  type BexioErrorClass,
  type MappedBexioStatus,
} from './types.ts';
