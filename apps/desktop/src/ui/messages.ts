// Every text a person sees in the app's local windows, in Czech and English. Components never
// carry text of their own.

export const messages = {
  cs: {
    generation: "Generace",
    version: "Verze",
    helpers: "Pomocné procesy",
    ready: "Běží",
    failed: "Nespustil se",
  },
  en: {
    generation: "Generation",
    version: "Version",
    helpers: "Helper processes",
    ready: "Running",
    failed: "Did not start",
  },
} as const;

export type Locale = keyof typeof messages;

export const localeOf = (language: string): Locale =>
  language.toLowerCase().startsWith("cs") ? "cs" : "en";
