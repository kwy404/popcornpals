# Contributing to popcornpals

Thanks for helping. popcornpals is a static web app: no backend, no accounts, no analytics. Contributions keep it that way.

## Getting started

```bash
git clone https://github.com/kwy404/popcornpals.git
cd popcornpals
npm install
npm test
npm run serve   # http://127.0.0.1:8080/
```

Node 18.18 or newer is required for the tooling. The app itself runs in any current browser.

## Where things live

| Path | What it is |
| --- | --- |
| `src/` | Shared modules (sync, pairing, words, QR encoder, crypto, mesh, DSP), tested with Vitest. `npm run core` copies them to `docs/app/core/`. |
| `docs/app/` | The app: HTML, CSS, UI modules, the noise suppression worklet, the service worker and the manifest. |
| `docs/index.html`, `docs/site/` | The landing page. |
| `extension/` | The optional extension. `npm run extension` builds the zip in `docs/extension/`. |
| `assets/` | The approved art. `assets/readme/` holds the animated copies for the README, built by `npm run readme:art`. |
| `test/` | Unit tests, and the browser tests `e2e.mjs` and `e2e-extension.mjs`. |

## Before you open a pull request

Run every check CI runs:

```bash
npm run lint
npm run rules
npm run core:check
npm run extension:check
npm run readme:check
npm test
npm run links
npm run e2e
```

`npm run e2e:yt` checks YouTube sync and needs the network. The browser tests need a Chromium based browser. Set `BROWSER` to its path if it is not found.

## House rules

- No emoji and no en or em dash characters in any file (`npm run rules` checks this).
- Keep security wording true. Say what WebRTC, DTLS and TURN relays really do. Never claim "impossible to hack" or "anonymous".
- The extension never captures, records, downloads or re-streams video, and never touches copy protection.
- No tracking, analytics or calls to servers other than STUN, the pairing relays and the TURN servers a user configures.
- Art is original. Do not copy brand assets.

## Reporting bugs

Open an issue with the browser and version, what you did, what you expected and what happened. For connection problems, say whether everyone was on the same network. For security issues, follow [SECURITY.md](SECURITY.md) instead.

## License

By contributing you agree that your work is released under the [MIT License](LICENSE).
