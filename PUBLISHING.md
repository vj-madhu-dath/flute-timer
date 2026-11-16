# Publishing the Flute Timer site

Maintainer notes for the website and its GitHub Pages deployment. The separate [README.md](README.md) is the download and usage guide for people who want to run the app themselves.

## The site

Flute Timer is a small static website with four parts:

| Page | Address | What it is |
| --- | --- | --- |
| Homepage | `/` | What the timer is and how it works |
| The timer | `/app/` | The app itself |
| About | `/about.html` | The idea, the privacy model, and common questions |
| Practice notes | `/blog/` | Essays on rest, calibration, and using the log |

Once published, the site lives at `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/` and the app at `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/app/`.

## Using the timer

Open the `/app/` page in a current version of Safari, Chrome, Firefox, or Edge. Press **Start listening**, allow the microphone, and play. The clock starts when the timer hears a sustained note.

Microphone access requires a secure page. The hosted GitHub Pages site is served over HTTPS, so it works. A local server such as `http://127.0.0.1:8787` also counts as secure. Opening `app/index.html` directly from the file system does not.

### On a Mac, the short way

Double-click **`start.command`**. It starts a local web server and opens the timer at `http://127.0.0.1:8787/app/`. Keep the Terminal window open while you practice.

If macOS refuses to open the file the first time, right-click it, choose **Open**, and confirm.

### Any computer

From this folder, run:

```bash
python3 -m http.server 8787
```

Then open <http://127.0.0.1:8787/> for the site or <http://127.0.0.1:8787/app/> for the timer. On Windows, use `python -m http.server 8787`.

## Publish to GitHub Pages

Everything is static — no build step, no dependencies, no server. The included workflow at `.github/workflows/pages.yml` publishes the site whenever you push to `main`.

### One-time setup

1. Create a new **public** repository on GitHub. Do not add a README or license; this folder already has what it needs.
2. In this folder, connect the folder to the new repository:

   ```bash
   git init -b main
   git add .
   git commit -m "Add Flute Timer site"
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
   git push -u origin main
   ```

3. In the GitHub repository, go to **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to **GitHub Actions**.
5. Open the **Actions** tab and watch the “Deploy site to GitHub Pages” run. When it finishes, the Pages URL appears in the deployment summary and under Settings → Pages.

Every later push to `main` republishes the site. You can also run the workflow manually from the Actions tab.

The workflow copies only the public site files into the deployment artifact: the four page locations plus `assets/`. Tests, the README, and `start.command` stay in the repository but are not part of the published site.

### Why it works on GitHub Pages

- All links are relative, so they work whether the repository is served at a username root or under a project path.
- `.nojekyll` is included, so no Jekyll processing is needed.
- The microphone works because GitHub Pages serves the site over HTTPS.

## Project layout

```text
.
├── index.html                    Homepage
├── about.html                    About page
├── blog/
│   ├── index.html                Practice notes index
│   ├── long-tones-and-airy-sound.html
│   ├── why-rest-is-practice.html
│   ├── how-the-timer-hears-you.html
│   └── making-a-practice-log.html
├── app/
│   ├── index.html                The timer
│   ├── app.js                    Microphone detection, laps, settings
│   └── styles.css                App styles
├── assets/
│   ├── site.css                  Shared site styles
│   ├── site.js                   Mobile navigation and footer year
│   ├── favicon.svg
│   ├── apple-touch-icon.png
│   └── screenshot*.png/webp
├── tests/
│   ├── test_e2e.py               Fake-microphone app test
│   ├── test_site.py              Page and link smoke test
│   └── fake_mic.js
├── .github/workflows/pages.yml   GitHub Pages deployment
├── start.command                 Mac local launcher
├── README.md                     Download and usage guide
└── PUBLISHING.md                 This maintainer guide
```

## Tests

The app test simulates a flute with a synthetic microphone and checks that play/rest laps, pause, resume, and reset all behave. It needs [Playwright](https://playwright.dev/python/):

```bash
python3 -m pip install playwright
python3 -m playwright install chromium
python3 tests/test_e2e.py
```

The site test checks every page and local link at desktop and phone widths:

```bash
python3 tests/test_site.py
```

## Privacy

Microphone audio is measured live in the browser and then discarded. Nothing is recorded, saved, or sent anywhere. There is no account, sign-in, analytics, or tracking. Settings and room calibration are kept in the browser's local storage. The current session's laps live only in the open tab.

## Troubleshooting

**The app says it needs a local server.** Open it through `http://localhost`, `http://127.0.0.1`, or the HTTPS GitHub Pages address. Opening the HTML file directly will not give the page microphone access.

**The browser cannot hear the flute.** Allow the microphone for the page, check the operating system's microphone privacy settings, close other apps that may be using the mic, and watch the Mic level meter while you clap or speak.

**The timer starts when I am not playing.** Lower Sensitivity, raise “Note must last,” or run Calibrate room while the room is quiet.

**A phrase keeps splitting into two laps.** Raise “Silence before rest” under Fine tuning.

**The timer misses quiet notes.** Raise Sensitivity, move the microphone closer, or recalibrate in the room where you practice.

**`start.command` closes immediately.** It needs Python 3. Install it from <https://www.python.org/downloads/>, then try again.
