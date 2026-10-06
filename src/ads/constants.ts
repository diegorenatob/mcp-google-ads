/** Google Ads language constant IDs for common ISO-639-1 codes. */
export const LANGUAGE_IDS: Record<string, number> = {
  en: 1000, de: 1001, fr: 1002, es: 1003, it: 1004, ja: 1005, nl: 1010, pt: 1014, ru: 1031, zh: 1017,
};

/** Google Ads geo target constant IDs for common countries (ISO-3166 alpha-2). */
export const COUNTRY_GEO_IDS: Record<string, number> = {
  AR: 2032, BR: 2076, CA: 2124, CL: 2152, CO: 2170, DE: 2276, ES: 2724, FR: 2250, GB: 2826,
  IT: 2380, MX: 2484, PE: 2604, PT: 2620, US: 2840, UY: 2858,
};

export function languageResource(code: string): string {
  const id = LANGUAGE_IDS[code.toLowerCase()];
  if (!id) throw new Error(`Unsupported language_code "${code}". Supported: ${Object.keys(LANGUAGE_IDS).join(', ')}`);
  return `languageConstants/${id}`;
}

export function countryGeoResource(code: string): string {
  const id = COUNTRY_GEO_IDS[code.toUpperCase()];
  if (!id) {
    throw new Error(
      `Unsupported country_code "${code}". Use location_ids from search_locations, or one of: ${Object.keys(COUNTRY_GEO_IDS).join(', ')}`,
    );
  }
  return `geoTargetConstants/${id}`;
}

/** Question modifiers used to expand autocomplete queries. */
export const QUESTION_MODIFIERS: Record<string, string[]> = {
  pt: ['como', 'quanto', 'quando', 'qual', 'onde', 'porque', 'o que', 'quem', 'pode', 'tem direito'],
  es: ['como', 'cuanto', 'cuando', 'cual', 'donde', 'por que', 'que', 'quien', 'puedo', 'tengo derecho'],
  en: ['how', 'what', 'when', 'why', 'where', 'who', 'can', 'is', 'does', 'should'],
};
