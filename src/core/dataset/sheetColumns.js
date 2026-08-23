// Sheet columns have no stable identity of their own, so a dataset column id is
// derived from the position. Both the eager and the virtual store parse it, and
// a prefix that drifted between them would silently project the wrong column.

export const SHEET_COLUMN_PREFIX = "sheet-column:";

export function sheetColumnName(index) {
  return `${SHEET_COLUMN_PREFIX}${index}`;
}

export function sheetColumnIndex(columnId) {
  const value = String(columnId);
  if (!value.startsWith(SHEET_COLUMN_PREFIX)) return null;
  const index = Number(value.slice(SHEET_COLUMN_PREFIX.length));
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}
