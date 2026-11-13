/**
 * A plan's title after "<host> wants to": "Grab dinner" reads "Hana wants to grab dinner". The first letter is lowered only
 * when the first word is an ordinary capitalised word; a first word with another capital or a digit is an acronym or a
 * name written that way (QA, BBQ, iPhone, F1) and stays as typed. Before 1 Nov 2026, "QA noodle night" showed as
 * "qA noodle night" on every plan card and share message.
 */
export function planTitleAfterVerb(title: string): string {
  const first = title.split(/\s/)[0] ?? '';
  if (!first || /[\p{Lu}\d]/u.test(first.slice(1))) return title;
  return first.charAt(0).toLowerCase() + title.slice(1);
}
