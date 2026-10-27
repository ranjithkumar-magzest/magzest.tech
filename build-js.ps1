# Regenerates the minified js/*.min.js files (the ones actually linked
# from the HTML pages) from their readable js/*.js sources, using the
# standalone esbuild binary in tools/esbuild.exe (no Node/npm needed).
#
# Run this after editing any of: js/main.js, js/components.js,
# js/careers.js, js/contact.js, js/portfolio.js.
#
# If tools/esbuild.exe is missing, redownload the win32-x64 binary from:
# https://registry.npmjs.org/@esbuild/win32-x64/-/win32-x64-<version>.tgz
# (it's a plain native binary inside the npm tarball; check the latest
# version at https://registry.npmjs.org/@esbuild/win32-x64/latest)

$root = $PSScriptRoot
$files = @("main", "components", "careers", "contact", "portfolio")

foreach ($name in $files) {
  & "$root\tools\esbuild.exe" "$root\js\$name.js" --minify --outfile="$root\js\$name.min.js"
}

Write-Host "Built js/*.min.js"
