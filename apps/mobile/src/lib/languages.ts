// Languages people can pick for their profile. Stored by name (users.languages, max 8 in the API).
export const LANGUAGES = [
  'English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch', 'Hindi', 'Punjabi', 'Bengali', 'Tamil',
  'Urdu', 'Arabic', 'Turkish', 'Russian', 'Ukrainian', 'Polish', 'Swedish', 'Chinese', 'Japanese', 'Korean', 'Thai',
  'Vietnamese', 'Indonesian', 'Hebrew', 'Greek',
] as const;
export const MAX_LANGUAGES = 8;
export const toggleLanguage = (list: string[], l: string) =>
  list.includes(l) ? list.filter(x => x !== l) : list.length < MAX_LANGUAGES ? [...list, l] : list;
