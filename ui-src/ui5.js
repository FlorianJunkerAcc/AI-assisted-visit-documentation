// Entry point of the UI5 Web Components bundle (SAP Horizon / Fiori).
// Built with `npm run build:ui` into app/ui5.bundle.js (esbuild, one file, no CDN at runtime).
// Only the components that app/index.html actually uses are imported.

// Assets (theme parameters, i18n) – slim version, see assets.js. Must come before setTheme/setLanguage.
import './assets.js'

// Components
import '@ui5/webcomponents-fiori/dist/ShellBar.js'
import '@ui5/webcomponents-fiori/dist/ShellBarItem.js'
import '@ui5/webcomponents/dist/Button.js'
import '@ui5/webcomponents/dist/Card.js'
import '@ui5/webcomponents/dist/CardHeader.js'
import '@ui5/webcomponents/dist/Icon.js'
import '@ui5/webcomponents/dist/Input.js'
import '@ui5/webcomponents/dist/Label.js'
import '@ui5/webcomponents/dist/List.js'
import '@ui5/webcomponents/dist/ListItemCustom.js'
import '@ui5/webcomponents/dist/MessageStrip.js'
import '@ui5/webcomponents/dist/Panel.js'
import '@ui5/webcomponents/dist/Tag.js'
import '@ui5/webcomponents/dist/Text.js'
import '@ui5/webcomponents/dist/Title.js'

// Icons used in index.html
import '@ui5/webcomponents-icons/dist/ai.js'
import '@ui5/webcomponents-icons/dist/dark-mode.js'
import '@ui5/webcomponents-icons/dist/light-mode.js'
import '@ui5/webcomponents-icons/dist/media-pause.js'
import '@ui5/webcomponents-icons/dist/media-play.js'
import '@ui5/webcomponents-icons/dist/microphone.js'
import '@ui5/webcomponents-icons/dist/person-placeholder.js'
import '@ui5/webcomponents-icons/dist/stop.js'
import '@ui5/webcomponents-icons/dist/document-text.js'

import { setTheme, getTheme } from '@ui5/webcomponents-base/dist/config/Theme.js'
import { setLanguage } from '@ui5/webcomponents-base/dist/config/Language.js'

// Exposed for the page script (index.html is a classic script, not a module)
window.UI5 = { setTheme, getTheme, setLanguage }
