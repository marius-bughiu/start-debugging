import en from "./en.json";
import es from "./es.json";
import ptBr from "./pt-br.json";
import de from "./de.json";
import ru from "./ru.json";
import ja from "./ja.json";
import type { Locale } from "../lib/blog";

// The English dictionary defines the authoritative key set. Other locales
// are typed as partials: missing keys fall back to English, then to the key
// literal itself.
export type TranslationKey = keyof typeof en;

type Dict = Partial<Record<TranslationKey, string>>;

const dicts: Record<Locale, Dict> = {
  en: en as Dict,
  es: es as Dict,
  "pt-br": ptBr as Dict,
  de: de as Dict,
  ru: ru as Dict,
  ja: ja as Dict,
};

/**
 * Look up a UI string for `lang`. Falls back to English, then to the key
 * literal so unknown keys show up loudly in dev rather than silently rendering
 * as empty strings.
 */
export function t(key: TranslationKey, lang: Locale = "en"): string {
  return dicts[lang]?.[key] ?? dicts.en[key] ?? key;
}
