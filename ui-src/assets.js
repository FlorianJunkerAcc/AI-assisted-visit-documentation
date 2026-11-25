// Slim replacement for "@ui5/webcomponents/dist/Assets.js" & "@ui5/webcomponents-fiori/dist/Assets.js".
// The stock Assets files register ALL 10 themes, ~50 languages and the CLDR data (≈15 MB bundle).
// This app only needs SAP Horizon Light + Dark and the languages DE/EN, and no date components (no CLDR).
//
// If another theme or language is needed later, add it to THEMES / LOCALES below.
import { registerThemePropertiesLoader } from '@ui5/webcomponents-base/dist/asset-registries/Themes.js'
import { registerI18nLoader } from '@ui5/webcomponents-base/dist/asset-registries/i18n.js'
import { registerLocaleDataLoader } from '@ui5/webcomponents-base/dist/asset-registries/LocaleData.js'

const THEMES = {
  '@ui5/webcomponents': {
    sap_horizon:      () => import('@ui5/webcomponents/dist/generated/assets/themes/sap_horizon/parameters-bundle.css.json'),
    sap_horizon_dark: () => import('@ui5/webcomponents/dist/generated/assets/themes/sap_horizon_dark/parameters-bundle.css.json')
  },
  '@ui5/webcomponents-fiori': {
    sap_horizon:      () => import('@ui5/webcomponents-fiori/dist/generated/assets/themes/sap_horizon/parameters-bundle.css.json'),
    sap_horizon_dark: () => import('@ui5/webcomponents-fiori/dist/generated/assets/themes/sap_horizon_dark/parameters-bundle.css.json')
  },
  '@ui5/webcomponents-theming': {
    sap_horizon:      () => import('@ui5/webcomponents-theming/dist/generated/assets/themes/sap_horizon/parameters-bundle.css.json'),
    sap_horizon_dark: () => import('@ui5/webcomponents-theming/dist/generated/assets/themes/sap_horizon_dark/parameters-bundle.css.json')
  }
}
// The stock files pass "host" as 4th argument for webcomponents and fiori, none for theming.
const THEME_EXTRA = { '@ui5/webcomponents': 'host', '@ui5/webcomponents-fiori': 'host' }

for (const [pkg, themes] of Object.entries(THEMES)) {
  for (const [name, load] of Object.entries(themes)) {
    registerThemePropertiesLoader(pkg, name, async () => (await load()).default, THEME_EXTRA[pkg])
  }
}

// CLDR locale data (number/date formats). Without it UI5 falls back to loading it from a CDN at runtime.
const CLDR = {
  en: () => import('@ui5/webcomponents-localization/dist/generated/assets/cldr/en.json'),
  de: () => import('@ui5/webcomponents-localization/dist/generated/assets/cldr/de.json')
}
for (const [id, load] of Object.entries(CLDR)) {
  registerLocaleDataLoader(id, async () => (await load()).default)
}

const LOCALES = {
  '@ui5/webcomponents': {
    en: () => import('@ui5/webcomponents/dist/generated/assets/i18n/messagebundle_en.json'),
    de: () => import('@ui5/webcomponents/dist/generated/assets/i18n/messagebundle_de.json')
  },
  '@ui5/webcomponents-fiori': {
    en: () => import('@ui5/webcomponents-fiori/dist/generated/assets/i18n/messagebundle_en.json'),
    de: () => import('@ui5/webcomponents-fiori/dist/generated/assets/i18n/messagebundle_de.json')
  }
}

for (const [pkg, locales] of Object.entries(LOCALES)) {
  for (const [id, load] of Object.entries(locales)) {
    registerI18nLoader(pkg, id, async () => (await load()).default)
  }
}
