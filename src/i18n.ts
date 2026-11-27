// What the server says itself, aloud on a device or in Kkachi Home, in Settings' language (settings.lang).
// The app's own words are src/web/i18n.js's.
import { settings } from "./settings";

export const say = (ko: string, en: string) => (settings().lang === "en" ? en : ko);
