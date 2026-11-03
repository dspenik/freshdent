"""Fail when a template uses a CSS class that no stylesheet defines.

The theme stylesheet is a frozen, purged Tailwind/daisyUI build, so a class missing
from it silently does nothing. Usage: python3 check-css-classes.py <theme-dir>
"""

import re
import sys
from pathlib import Path

# Classes that are intentionally unstyled or have no effect at the moment.
ALLOWED = {
    "Menu",
    "Page",
    "font-base",
    "font-heading",
    "max-width-100",
    "sm:h-600",
    "sm:hero",
    "sm:hidden",
    "sm:morphism-hero",
    "sm:navbar-center",
    "sm:navbar-end",
    "sm:navbar-start",
}

SELECTOR_CLASS = re.compile(r"\.((?:[A-Za-z0-9_-]|\\.)+)")
CLASS_ATTR = re.compile(r'class="([^"]*)"')
STYLE_BLOCK = re.compile(r"<style[^>]*>(.*?)</style>", re.DOTALL)
TEMPLATE_EXPR = re.compile(r"\{\{.*?\}\}", re.DOTALL)


def defined_classes(css: str) -> set[str]:
    return {m.replace("\\", "") for m in SELECTOR_CLASS.findall(css)}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check-css-classes.py <theme-dir>", file=sys.stderr)
        return 2
    theme = Path(sys.argv[1])
    stylesheets = list(theme.glob("static/**/*.css")) + list(
        theme.glob("assets/**/*.css")
    )
    templates = sorted(theme.glob("layouts/**/*.html"))
    if not stylesheets or not templates:
        print(f"no stylesheets or templates found under {theme}", file=sys.stderr)
        return 2

    defined: set[str] = set()
    for css in stylesheets:
        defined |= defined_classes(css.read_text(encoding="utf-8"))

    missing: list[str] = []
    for tpl in templates:
        text = tpl.read_text(encoding="utf-8")
        local = set()
        for block in STYLE_BLOCK.findall(text):
            local |= defined_classes(block)
        for lineno, line in enumerate(text.splitlines(), 1):
            for attr in CLASS_ATTR.findall(line):
                for cls in TEMPLATE_EXPR.sub(" ", attr).split():
                    if cls not in defined and cls not in local and cls not in ALLOWED:
                        missing.append(f"{tpl.relative_to(theme)}:{lineno}: .{cls}")

    for item in missing:
        print(item)
    if missing:
        print(
            f"{len(missing)} class(es) used in templates but not defined in any stylesheet"
        )
        return 1
    print(f"ok: all classes in {len(templates)} templates are defined")
    return 0


if __name__ == "__main__":
    sys.exit(main())
