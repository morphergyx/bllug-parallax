/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  // Scan every HTML page (and script.js for any dynamic class strings) so
  // every class actually used anywhere on the site gets generated.
  content: ["./src/**/*.html", "./src/**/*.js"],
  theme: {
    extend: {
      colors: {
        "tertiary-fixed": "#ffdad2",
        "inverse-surface": "#e5e2e1",
        "surface-container-highest": "#353534",
        "surface-container-low": "#1c1b1b",
        "outline-variant": "#444748",
        "tertiary-container": "#ffdad2",
        "on-surface": "#e5e2e1",
        "on-secondary-fixed": "#1b1c1c",
        "on-background": "#e5e2e1",
        "on-tertiary": "#611200",
        "surface-container-lowest": "#0e0e0e",
        "error-container": "#93000a",
        "outline": "#8e9192",
        "primary": "#ffffff",
        "surface-dim": "#131313",
        "on-primary-fixed-variant": "#454747",
        "secondary-fixed-dim": "#c7c6c6",
        "tertiary-fixed-dim": "#ffb4a2",
        "background": "#131313",
        "on-secondary": "#303031",
        "surface-tint": "#c6c6c7",
        "surface-container-high": "#2a2a2a",
        "surface-variant": "#353534",
        "on-tertiary-fixed-variant": "#891d00",
        "primary-container": "#e2e2e2",
        "inverse-on-surface": "#313030",
        "on-primary-container": "#636565",
        "on-error-container": "#ffdad6",
        "surface-container": "#201f1f",
        "surface": "#131313",
        "tertiary": "#ffffff",
        "on-tertiary-container": "#be2c00",
        "error": "#ffb4ab",
        "secondary": "#c7c6c6",
        "on-secondary-container": "#b5b5b5",
        "on-primary-fixed": "#1a1c1c",
        "secondary-container": "#464747",
        "surface-bright": "#393939",
        "on-surface-variant": "#c4c7c8",
        "on-tertiary-fixed": "#3c0700",
        "on-primary": "#2f3131",
        "primary-fixed": "#e2e2e2",
        "on-secondary-fixed-variant": "#464747",
        "inverse-primary": "#5d5f5f",
        "secondary-fixed": "#e3e2e2",
        "on-error": "#690005",
        "primary-fixed-dim": "#c6c6c7"
      },
      borderRadius: {
        "DEFAULT": "0.25rem",
        "lg": "0.5rem",
        "xl": "0.75rem",
        "full": "9999px"
      },
      spacing: {
        "unit": "8px",
        "margin-mobile": "1.25rem",
        "gutter": "1.5rem",
        "margin-desktop": "4rem"
      },
      fontFamily: {
        "headline-lg-mobile": ["Space Grotesk"],
        "headline-lg": ["Space Grotesk"],
        "label-mono": ["JetBrains Mono"],
        "headline-xl": ["Space Grotesk"],
        "body-md": ["Inter"],
        "label-limit": ["JetBrains Mono"]
      },
      fontSize: {
        "headline-lg-mobile": ["32px", {"lineHeight": "36px", "fontWeight": "700"}],
        "headline-lg": ["48px", {"lineHeight": "52px", "letterSpacing": "-0.02em", "fontWeight": "700"}],
        "label-mono": ["12px", {"lineHeight": "16px", "fontWeight": "500"}],
        "headline-xl": ["80px", {"lineHeight": "80px", "letterSpacing": "-0.04em", "fontWeight": "700"}],
        "body-md": ["16px", {"lineHeight": "24px", "fontWeight": "400"}],
        "label-limit": ["14px", {"lineHeight": "18px", "letterSpacing": "0.1em", "fontWeight": "700"}]
      }
    }
  },
  // forms + container-queries plugins were loaded via the CDN query string
  // (?plugins=forms,container-queries) — replicate them here so form resets
  // and any @container usage keep working identically.
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/container-queries")
  ]
}
