# Changelog

All notable changes to popcornpals are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-16

### Added

- Rooms for up to 5 people, joined with six words, a QR code or an invite link (`#join=`), all carrying the same words. Opening the link joins at once and clears the words from the address bar. Pasting the words into any box spreads them one per box.
- Six confirmation words, made from both connection certificates, that the host types before a guest gets in.
- The host streams one local video file to every guest, with a quality readout, plus a best quality mode where everyone opens the same file and a quick fingerprint checks it.
- Subtitles from .srt and .vtt files for everyone.
- YouTube sync in the official embedded player: play, pause, seek and speed.
- Screen share of a tab, a window or the whole screen.
- An optional browser extension that syncs each person's own player on a streaming site, downloadable as a zip from the website with an install guide and its SHA-256.
- Text chat with replies, reactions and clickable video times; floating reactions; a shared queue; a host lock.
- Voice for everyone with mute, ducking of the movie while someone talks, and noise suppression (the browser's own and a Strong DSP mode in an AudioWorklet).
- Cameras shown as seats under the screen, and pickers for the microphone, the camera and the speakers.
- One accessible context menu (right click, long press, Shift+F10 or the Menu key) with submenus and keyboard support: on the player, play or pause, sync everyone to me, copy timestamp, speed, picture in picture and fullscreen; on people, volume, mute for me and make host; on messages, copy, reply and react.
- A landing page where cinema curtains open on the screen, light and dark themes, English and Portuguese, and an installable app that works offline once loaded.
