// Numeric bounds on reference data and derived quantities (DOM-05).

/** Largest quantity any reference-data quantity field may carry. */
export const MAX_QTY = 10_000;
/** Largest replacement limit a component may declare for one location. */
export const MAX_REPLACEMENTS_PER_LOCATION = 1_000;
/** Largest computed line quantity. */
export const MAX_DERIVED_QTY = 1_000_000;
/** Deepest kit nesting allowed. */
export const MAX_KIT_DEPTH = 8;

/** Largest offset the visit list accepts: a small safe integer. */
export const MAX_LIST_OFFSET = 1_000_000;
/** Visits shown per page of the visit list. */
export const VISITS_PAGE_SIZE = 25;
