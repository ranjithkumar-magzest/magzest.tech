"""
Builds the deploy ZIP for the VPS: dist/magzest-deploy-<date>.zip

Run build.ps1 first so the built pages/CSS/JS are current, then:
  python deploy/make_bundle.py

Includes only what the server needs at runtime: the built pages,
css/, js/, assets/, templates/ and pages/ (read by the server),
server/ and deploy/setup-vps.sh. Never includes node_modules,
local databases (server/data*), .env files or build tools.

On the VPS:
  unzip magzest-deploy-<date>.zip && sudo bash magzest/deploy/setup-vps.sh
"""
import datetime
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

INCLUDE_DIRS = ["css", "js", "assets", "templates", "pages", "server"]
INCLUDE_ROOT_GLOBS = ["*.html", "robots.txt", "sitemap.xml", "favicon.ico"]
EXCLUDE_PARTS = {"node_modules", ".git", "__pycache__"}


def excluded(rel):
    parts = rel.parts
    if EXCLUDE_PARTS & set(parts):
        return True
    if parts[0] == "server" and len(parts) > 1 and (parts[1].startswith("data") or parts[1].startswith(".env") and parts[1] != ".env.example"):
        return True
    return rel.name.endswith((".log", ".db", ".db-wal", ".db-shm"))


def files():
    for pattern in INCLUDE_ROOT_GLOBS:
        yield from sorted(ROOT.glob(pattern))
    for d in INCLUDE_DIRS:
        for p in sorted((ROOT / d).rglob("*")):
            if p.is_file() and not excluded(p.relative_to(ROOT)):
                yield p
    yield ROOT / "deploy" / "setup-vps.sh"


def main():
    DIST.mkdir(exist_ok=True)
    out = DIST / f"magzest-deploy-{datetime.date.today():%Y-%m-%d}.zip"
    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files():
            rel = p.relative_to(ROOT).as_posix()
            data = p.read_bytes()
            info = zipfile.ZipInfo(f"magzest/{rel}", date_time=datetime.datetime.fromtimestamp(p.stat().st_mtime).timetuple()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            if rel.endswith(".sh"):
                data = data.replace(b"\r\n", b"\n")  # bash breaks on CRLF
                info.external_attr = 0o755 << 16
            else:
                info.external_attr = 0o644 << 16
            z.writestr(info, data)
            count += 1
    print(f"Wrote {out.relative_to(ROOT)} ({count} files, {out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
