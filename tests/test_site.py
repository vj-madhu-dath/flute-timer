#!/usr/bin/env python3
"""Smoke test for the Flute Timer website.

Run:
    python3 tests/test_site.py

Serves the repository, checks every page at desktop and phone widths, verifies
the mobile menu, checks the timer shell, and confirms that every local link and
asset resolves. Screenshots are written to tests/shots/site-*.png.
"""
import functools
import http.server
import pathlib
import socketserver
import threading
from html.parser import HTMLParser
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = pathlib.Path(__file__).resolve().parent / "shots"
SHOTS.mkdir(exist_ok=True)
PORT = 8898

PAGES = [
    ("/", "home"),
    ("/about.html", "about"),
    ("/blog/", "blog"),
    ("/blog/long-tones-and-airy-sound.html", "post-airy"),
    ("/blog/why-rest-is-practice.html", "post-rest"),
    ("/blog/how-the-timer-hears-you.html", "post-hearing"),
    ("/blog/making-a-practice-log.html", "post-log"),
    ("/app/", "app"),
]

EXTERNAL_PREFIXES = ("http:", "https:", "mailto:", "tel:", "data:", "javascript:")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True


class RefParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.refs = []
        self.ids = set()

    def handle_starttag(self, _tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.add(attrs["id"])
        for name in ("href", "src"):
            value = attrs.get(name)
            if value:
                self.refs.append(value)
        srcset = attrs.get("srcset")
        if srcset:
            for candidate in srcset.split(","):
                candidate = candidate.strip()
                if candidate:
                    self.refs.append(candidate.split()[0])


def parse(path):
    parser = RefParser()
    parser.feed(path.read_text(encoding="utf-8"))
    return parser


def check_links():
    pages = sorted(p for p in ROOT.rglob("*.html") if "tests" not in p.parts and "_site" not in p.parts)
    parsed = {page: parse(page) for page in pages}
    checked = 0

    for page, parser in parsed.items():
        for ref in parser.refs:
            if ref.startswith(EXTERNAL_PREFIXES) or ref.startswith("#"):
                if ref.startswith("#") and len(ref) > 1:
                    assert ref[1:] in parser.ids, f"{page.relative_to(ROOT)}: missing anchor {ref}"
                continue

            split = urlsplit(ref)
            target = (page.parent / split.path).resolve() if split.path else page
            if split.path.endswith("/") or target.is_dir():
                target = target / "index.html"

            assert target.exists(), f"{page.relative_to(ROOT)}: broken link {ref!r}"
            assert target.is_relative_to(ROOT), f"{page.relative_to(ROOT)}: link escapes the site {ref!r}"

            if split.fragment:
                target_parser = parsed.get(target)
                if target_parser is None and target.suffix == ".html":
                    target_parser = parse(target)
                    parsed[target] = target_parser
                assert target_parser is not None, f"{page.relative_to(ROOT)}: cannot check anchor in {ref!r}"
                assert split.fragment in target_parser.ids, (
                    f"{page.relative_to(ROOT)}: missing anchor #{split.fragment} in {ref!r}"
                )
            checked += 1

    return len(pages), checked


def main():
    page_count, link_count = check_links()
    print(f"Link check: {link_count} local references across {page_count} HTML files.")

    server = ReusableServer(("127.0.0.1", PORT), functools.partial(QuietHandler, directory=str(ROOT)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1440, "height": 1000},
                color_scheme="light",
            )
            page = context.new_page()
            page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
            page.on(
                "console",
                lambda msg: errors.append(f"console {msg.type}: {msg.text}")
                if msg.type == "error"
                else None,
            )

            base = f"http://127.0.0.1:{PORT}"

            for path, label in PAGES:
                response = page.goto(base + path, wait_until="networkidle")
                assert response is not None and response.ok, f"{path}: HTTP {response.status if response else 'none'}"
                assert page.title().strip(), f"{path}: empty title"

                headings = page.locator("h1")
                assert headings.count() == 1, f"{path}: expected one h1, found {headings.count()}"
                if path != "/app/":
                    assert headings.first.is_visible(), f"{path}: h1 is not visible"

                overflow = page.evaluate(
                    "document.documentElement.scrollWidth - window.innerWidth"
                )
                assert overflow <= 1, f"{path}: horizontal overflow of {overflow}px at 1440px"

                page.screenshot(path=str(SHOTS / f"site-{label}-desktop.png"), full_page=True)

            page.goto(base + "/", wait_until="networkidle")
            assert page.locator(".post-card").count() == 3, "homepage should preview three notes"
            page.goto(base + "/blog/", wait_until="networkidle")
            assert page.locator(".post-card").count() == 3, "blog index should list three more notes"
            assert page.locator(".featured-post").count() == 1, "blog index needs a featured note"
            page.goto(base + "/app/", wait_until="networkidle")
            assert page.locator("#primaryBtn").is_visible()
            assert page.locator("#resetBtn").is_disabled()
            assert page.locator("#sensitivity").is_visible()

            # Phone layout and the mobile menu.
            page.set_viewport_size({"width": 390, "height": 844})
            for path, label in [
                ("/", "home"),
                ("/about.html", "about"),
                ("/blog/", "blog"),
                ("/blog/long-tones-and-airy-sound.html", "post-airy"),
                ("/blog/why-rest-is-practice.html", "post"),
                ("/app/", "app"),
            ]:
                page.goto(base + path, wait_until="networkidle")
                overflow = page.evaluate(
                    "document.documentElement.scrollWidth - window.innerWidth"
                )
                assert overflow <= 1, f"{path}: horizontal overflow of {overflow}px at 390px"
                page.screenshot(path=str(SHOTS / f"site-{label}-mobile.png"), full_page=True)

            page.goto(base + "/", wait_until="networkidle")
            toggle = page.locator(".nav-toggle")
            nav = page.locator("#site-nav")
            assert toggle.is_visible(), "mobile menu button is not visible"
            assert not nav.is_visible(), "mobile menu should start closed"
            toggle.click()
            assert nav.is_visible(), "mobile menu did not open"
            assert toggle.get_attribute("aria-expanded") == "true"
            page.keyboard.press("Escape")
            assert not nav.is_visible(), "Escape did not close the mobile menu"

            # Dark mode pass.
            page.set_viewport_size({"width": 1440, "height": 1000})
            page.emulate_media(color_scheme="dark")
            page.goto(base + "/", wait_until="networkidle")
            page.screenshot(path=str(SHOTS / "site-home-dark.png"), full_page=True)
            page.emulate_media(color_scheme="light")

            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    if errors:
        print("Browser errors:")
        for error in errors:
            print(" -", error)
        raise SystemExit(1)

    print("All site checks passed.")
    print(f"Screenshots: {SHOTS}")


if __name__ == "__main__":
    main()
