# Rebuilds everything: CSS (Tailwind), JS (esbuild), and HTML (templates).
# Run this after editing anything in css/style.css, src/tailwind-input.css,
# js/*.js, templates/*.html, or pages/*.html.

$root = $PSScriptRoot

& "$root\build-css.ps1"
& "$root\build-js.ps1"
python "$root\build_html.py"
# Security headers for static hosting; must follow the HTML build.
node "$root\deploy\make-htaccess.mjs"
