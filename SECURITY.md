# Security policy

## What popcornpals protects, and how

- **Media and messages.** Video, voice, cameras, screen shares and chat travel straight between browsers over WebRTC. Every connection is encrypted with DTLS, and audio and video with SRTP. No server of ours is involved.
- **Pairing.** The six words derive a meeting place and an AES-GCM key. Both browsers meet on public MQTT relays and exchange the connection offer encrypted with that key, so the relays only see ciphertext. Each invite works once and expires after 10 minutes.
- **Invite links.** The words sit in the part of the link after the `#`, which browsers never send to any server. The app reads them and clears them from the address bar at once.
- **Confirmation.** After connecting, the guest sees six words made from both connection certificates and a nonce. The host types them before the guest gets in, and three wrong tries turn the guest away. Someone who only saw the invite words gets different confirmation words.
- **TURN.** A TURN relay, when you add one, only forwards encrypted packets and cannot read them.

## Limits

- Private is not anonymous: people in a room connect directly and can see each other's network address.
- Anyone in the room can record what they see or hear with another program.
- The extension can only play, pause and seek a player on pages you allow it on. It reads no account data and sends nothing to any server.

## Reporting a vulnerability

Please do not open a public issue. Use [GitHub private vulnerability reporting](https://github.com/kwy404/popcornpals/security/advisories/new) with steps to reproduce and the browser and version. You should get an answer within 7 days.
