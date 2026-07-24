// English pluralizer for the plural GraphQL query field (opportunity ->
// opportunities, company -> companies, person -> people). Twenty's standard
// objects follow these rules; a custom object with an irregular plural would
// need its plural passed explicitly (documented limitation).
const IRREGULAR_PLURALS: Record<string, string> = {
  person: 'people',
};

export const pluralize = (singular: string): string => {
  if (IRREGULAR_PLURALS[singular]) {
    return IRREGULAR_PLURALS[singular];
  }
  if (/[^aeiou]y$/.test(singular)) {
    return `${singular.slice(0, -1)}ies`;
  }
  if (/(s|x|z|ch|sh)$/.test(singular)) {
    return `${singular}es`;
  }
  return `${singular}s`;
};
