import { cellAddress } from "../../sheet/coordinates.js";
import { formatCellValue } from "../../sheet/formatting.js";
import { formatFormulaResult } from "../../sheet/formulas.js";
import { isBareUrlValue } from "../../model.js";
import { projectObjectCell } from "../registry/index.js";

/**
 * The text a cell actually renders, shared by the sheet canvas and the
 * auto-fit measurement so the fitted width/height matches what is painted.
 *
 * - Embedded objects report their projected cell label (e.g. "Code A1").
 * - Bare URLs render as the link text.
 * - Everything else renders the formatted value (formula results included).
 */
export function cellDisplayText(cell, coordinates, formulaValues, sheet, workspaceObjects) {
  const rawValue = cell?.value ?? "";
  const formula = cell?.formula ?? "";
  const embed = cell?.embed;
  const calculatedValue = formula
    ? formatFormulaResult(formulaValues.get(cellAddress(coordinates.row, coordinates.column)))
    : rawValue;
  if (embed) {
    const embeddedObject = workspaceObjects?.[embed.objectId];
    const embeddedProjection = projectObjectCell(embed.type, {
      object: embeddedObject,
      cell,
      sheet,
      fallbackValue: rawValue,
    });
    return embeddedProjection?.displayValue || embeddedObject?.title || rawValue || "Embedded object";
  }
  if (!formula && isBareUrlValue(rawValue)) return rawValue;
  return formatCellValue(calculatedValue, cell?.style);
}
