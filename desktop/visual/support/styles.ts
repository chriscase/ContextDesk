/**
 * Production stylesheet chain for visual tests, mirroring
 * desktop/src/main.tsx (imports at main.tsx:7-28) in the same order.
 *
 * Browser-mode tests render components directly and bypass main.tsx, so
 * without this import the DOM would be unstyled and every geometry or theme
 * assertion would silently measure var(--token, fallback) hex fallbacks
 * instead of the shipped skin. Import this module first in every visual test.
 *
 * If main.tsx gains or loses a stylesheet import, update this list to match.
 */
import "../../src/assets/fonts/fonts.css";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/themes/dark.css";
import "../../src/styles/themes/light.css";
import "../../src/styles/themes/slate.css";
import "../../src/styles/themes/sand.css";
import "../../src/styles/themes/forest.css";
import "../../src/styles/themes/grokptah.css";
import "../../src/styles/layout.css";
import "../../src/styles/components/composer.css";
import "../../src/styles/components/tools.css";
import "../../src/styles/components/chat.css";
import "../../src/styles/components/forms.css";
import "../../src/styles/components/help-tip.css";
import "../../src/styles/components/theme-picker.css";
import "../../src/styles/components/settings.css";
import "../../src/styles/components/command-palette.css";
import "../../src/styles/components/composition.css";
import "../../src/styles/components/panes.css";
import "../../src/styles/components/session-wizard.css";
import "../../src/styles/components/log-explorer.css";
import "../../src/styles/components/import-flow.css";
import "../../src/styles/components/investigation-report.css";
import "../../src/styles/components/activity-inspector.css";
import "../../src/styles/components/evidence-set.css";
import "../../src/styles/components/logging-quality.css";
import "../../src/styles/help.css";
