# Bundled webfonts

These files are redistributed from [Google Fonts](https://fonts.google.com/) so the
app renders identically offline and makes no third-party request per page view.
They are unmodified apart from subsetting (the icon face carries only the ~64
symbols this app uses; the text faces keep Google's own unicode-range subsets).

| Files | Family | Licence |
| ----- | ------ | ------- |
| `symbols-*.woff2` | [Material Symbols Outlined](https://fonts.google.com/icons) | [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) |
| `hanken-*.woff2` | [Hanken Grotesk](https://fonts.google.com/specimen/Hanken+Grotesk) | [SIL Open Font License 1.1](https://openfontlicense.org/) |
| `jetbrains-*.woff2` | [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) | [SIL Open Font License 1.1](https://openfontlicense.org/) |

Both licences permit redistribution, including bundled in a larger work, provided
the licence and attribution travel with the files — which is what this file is for.
The OFL additionally requires that the fonts not be sold on their own and that
derivatives not use the reserved names; neither applies here, as they ship
unmodified as part of the application.

To regenerate after changing which icons the app uses, re-run the generator
documented in the project README ("Fonts").
