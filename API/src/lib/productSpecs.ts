// How a product's size and weight read on screen. Weight is kept in kilograms and size in centimetres (the sync converts whatever
// units DEAR holds them in). Size is shown only when all three of length, width and height are known, as length x width x height.
const trim = (n: number, decimals: number) => String(Math.round(n * 10 ** decimals) / 10 ** decimals);

export function fmtDimensions(length?: number | null, width?: number | null, height?: number | null): string | null {
  if (!(length && length > 0) || !(width && width > 0) || !(height && height > 0)) return null;
  return `${trim(length, 2)} × ${trim(width, 2)} × ${trim(height, 2)} cm`;
}

// Under a kilogram it is easier to read in grams.
export function fmtWeight(kg?: number | null): string | null {
  if (!(kg && kg > 0)) return null;
  return kg < 1 ? `${trim(kg * 1000, 0)} g` : `${trim(kg, 2)} kg`;
}