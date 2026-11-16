#!/usr/bin/env python3
"""End-to-end check for Flute Timer.

Run:
    python3 tests/test_e2e.py

It serves the app on localhost, injects a synthetic Web Audio microphone that
alternates flute-like tones with quiet rests, and verifies automatic laps.
"""
import functools
import http.server
import json
import pathlib
import socketserver
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAKE_MIC = pathlib.Path(__file__).resolve().with_name("fake_mic.js")
SHOTS = pathlib.Path(__file__).resolve().parent / "shots"
SHOTS.mkdir(exist_ok=True)
PORT = 8899


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True


def start_server():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ReusableServer(("127.0.0.1", PORT), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def snapshot(page):
    return page.evaluate("window.fluteTimer.snapshot()")


def wait_mode(page, mode, timeout=8000):
    page.wait_for_selector(f'body[data-mode="{mode}"]', timeout=timeout)


def main():
    server = start_server()
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--autoplay-policy=no-user-gesture-required"],
            )
            context = browser.new_context(
                viewport={"width": 1440, "height": 980},
                color_scheme="light",
            )
            page = context.new_page()
            page.add_init_script(path=str(FAKE_MIC))
            page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
            page.on(
                "console",
                lambda msg: errors.append(f"console {msg.type}: {msg.text}")
                if msg.type == "error"
                else None,
            )

            page.goto(f"http://127.0.0.1:{PORT}/app/", wait_until="networkidle")
            page.screenshot(path=str(SHOTS / "01-idle-light.png"), full_page=True)
            assert page.locator("text=No laps yet").is_visible()

            started = time.time()
            page.click("#primaryBtn")
            wait_mode(page, "listening", timeout=8000)
            print(f"listening after {time.time() - started:.2f}s")

            page.wait_for_selector('body[data-phase="play"]', timeout=8000)
            page.wait_for_timeout(700)
            snap_play = snapshot(page)
            print("first play:", json.dumps(snap_play))
            assert snap_play["mode"] == "listening"
            assert snap_play["phase"] == "play"
            assert snap_play["audio"] is True
            assert snap_play["thresholdDb"] > snap_play["floorDb"]
            assert page.locator("#currentLapRow").is_visible()
            assert page.locator("#statusText").inner_text() == "Playing"
            page.screenshot(path=str(SHOTS / "02-playing.png"), full_page=True)

            page.wait_for_selector('body[data-phase="rest"]', timeout=8000)
            page.wait_for_timeout(250)
            snap_rest = snapshot(page)
            print("first rest:", json.dumps(snap_rest))
            assert snap_rest["phase"] == "rest"
            assert len(snap_rest["segments"]) == 1, "first play lap should be complete"
            assert snap_rest["segments"][0]["type"] == "play"
            assert snap_rest["segments"][0]["ms"] > 2500
            assert page.locator("#statusText").inner_text() == "Resting"
            page.wait_for_timeout(600)
            page.screenshot(path=str(SHOTS / "03-resting.png"), full_page=True)

            page.wait_for_selector('body[data-phase="play"]', timeout=8000)
            page.wait_for_timeout(450)
            snap_play2 = snapshot(page)
            print("second play:", json.dumps(snap_play2))
            assert [seg["type"] for seg in snap_play2["segments"]][:2] == ["play", "rest"]
            assert page.locator(".lap-row.current").is_visible()
            page.screenshot(path=str(SHOTS / "06-session.png"), full_page=True)

            # Pause freezes and releases the mic; resume reconnects.
            page.click("#primaryBtn")
            wait_mode(page, "paused", timeout=3000)
            paused = snapshot(page)
            assert paused["audio"] is False
            assert paused["phase"] is None
            print("paused:", json.dumps(paused))
            page.wait_for_timeout(500)
            page.click("#primaryBtn")
            wait_mode(page, "listening", timeout=5000)
            assert snapshot(page)["audio"] is True

            # Reset needs a second click, then clears everything.
            page.click("#resetBtn")
            assert "Confirm reset" in page.locator("#resetBtn").inner_text()
            page.click("#resetBtn")
            wait_mode(page, "idle", timeout=3000)
            cleared = snapshot(page)
            print("after reset:", json.dumps(cleared))
            assert cleared["segments"] == []
            assert cleared["sessionStarted"] is False
            assert page.locator("text=No laps yet").is_visible()
            page.evaluate("document.activeElement && document.activeElement.blur()")
            page.wait_for_timeout(3100)

            # Visual checks at phone width and in dark mode.
            page.emulate_media(color_scheme="dark")
            page.wait_for_timeout(450)
            page.screenshot(path=str(SHOTS / "04-idle-dark.png"), full_page=True)
            page.emulate_media(color_scheme="light")
            page.wait_for_timeout(400)
            page.set_viewport_size({"width": 900, "height": 1000})
            page.wait_for_timeout(450)
            page.screenshot(path=str(SHOTS / "07-idle-tablet.png"), full_page=True)
            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(450)
            page.screenshot(path=str(SHOTS / "05-idle-mobile.png"), full_page=True)

            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    if errors:
        print("Browser errors:")
        for error in errors:
            print(" -", error)
        raise SystemExit(1)
    print("All checks passed.")
    print(f"Screenshots: {SHOTS}")


if __name__ == "__main__":
    main()
