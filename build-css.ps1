# Rebuilds css/tailwind.css from src/tailwind-input.css after editing
# tailwind classes/theme. Run this from PowerShell after any change to
# the HTML/JS files' Tailwind usage or to src/tailwind-input.css itself.
#
# Uses the standalone Tailwind CLI in tools/tailwindcss.exe (no Node/npm
# needed). If tools/tailwindcss.exe is missing, download it from:
# https://github.com/tailwindlabs/tailwindcss/releases/latest/download/tailwindcss-windows-x64.exe

$root = $PSScriptRoot
$tmpDir = Join-Path $root "css_build_tmp"

if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }

# Building straight to css/tailwind.css fails with EEXIST on Windows
# (bug in the CLI's bundled Bun runtime when the output dir already
# exists), so build to a fresh temp dir and move the result into place.
& "$root\tools\tailwindcss.exe" -i "$root\src\tailwind-input.css" -o "$tmpDir\tailwind.css" --minify

if ($LASTEXITCODE -eq 0) {
  Move-Item -Force "$tmpDir\tailwind.css" "$root\css\tailwind.css"
  Remove-Item $tmpDir -Recurse -Force
  Write-Host "Built css/tailwind.css"
} else {
  Write-Host "Tailwind build failed - see output above."
}
