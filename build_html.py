"""
Regenerates the flat, deployable HTML pages (index.html, about.html, ...)
from templates/*.html + pages/*.html. Run after editing anything in
pages/ or templates/.

pages/<name>.html format:
  KEY: value       (front-matter, see keys below)
  ...
  ---
  <main-content>   (everything that goes inside <main id="main-content">)

Front-matter keys:
  TITLE, DESCRIPTION, PATH, TEMPLATE (main|legal) - required
  KEYWORDS, OG_TITLE, OG_DESCRIPTION, EXTRA_SCRIPT - optional

profile.html is hand-authored outside this system (different layout,
no header/footer injection, no AOS) and is left untouched.
"""
import pathlib

ROOT = pathlib.Path(__file__).parent
PAGES_DIR = ROOT / "pages"
TEMPLATES_DIR = ROOT / "templates"


def parse_page(path):
    text = path.read_text(encoding="utf-8")
    front, main = text.split("\n---\n", 1)
    meta = {}
    for line in front.strip().splitlines():
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip()
    meta["MAIN"] = main.rstrip("\n")
    return meta


def render(template_text, values):
    for key, value in values.items():
        template_text = template_text.replace("{{" + key + "}}", value)
    return template_text


def build(meta, heads):
    values = {
        "TITLE": meta["TITLE"],
        "DESCRIPTION": meta["DESCRIPTION"],
        "PATH": meta["PATH"],
        # Homepage is canonicalised to the bare domain, not /index.html
        "URL_PATH": "" if meta["PATH"] == "index.html" else meta["PATH"],
        "OG_TITLE": meta.get("OG_TITLE") or meta["TITLE"],
        "OG_DESCRIPTION": meta.get("OG_DESCRIPTION") or meta["DESCRIPTION"],
        "KEYWORDS_LINE": (
            f'<meta name="keywords" content="{meta["KEYWORDS"]}" />\n' if meta.get("KEYWORDS") else ""
        ),
    }
    head_tpl = heads["legal"] if meta["TEMPLATE"] == "legal" else heads["main"]
    head = render(head_tpl, values)

    extra_script = meta.get("EXTRA_SCRIPT")
    foot_values = {
        "EXTRA_SCRIPT_TAG": (
            f'<script defer src="js/{extra_script}.min.js?v=6"></script>\n' if extra_script else ""
        )
    }
    foot = render(heads["foot"], foot_values)

    return head + meta["MAIN"] + "\n" + foot


def main():
    heads = {
        "main": (TEMPLATES_DIR / "head-main.html").read_text(encoding="utf-8"),
        "legal": (TEMPLATES_DIR / "head-legal.html").read_text(encoding="utf-8"),
        "foot": (TEMPLATES_DIR / "foot.html").read_text(encoding="utf-8"),
    }

    for page_path in sorted(PAGES_DIR.glob("*.html")):
        meta = parse_page(page_path)
        html = build(meta, heads)
        out_path = ROOT / meta["PATH"]
        out_path.write_text(html, encoding="utf-8", newline="\n")
        print(f"Built {meta['PATH']}")


if __name__ == "__main__":
    main()
