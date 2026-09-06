# DuoCLI Android media helper

This optional Go/Pion process owns WebRTC peer and RTP state outside Electron.
The parent sends one length-prefixed JSON control stream and one media stream
(`uint32 sourceId`, `uint32 packetLength`, DVM2 packet) over loopback. The first
control message must be `hello` with the random token printed in the single
stdout handshake line; diagnostics are written to stderr.

Build for the host release architecture with:

```sh
npm run build:android-media
```

The helper is deliberately not enabled just because it compiles. DuoCLI only
advertises `webRtc: true` when the executable is present in the packaged
resources, and public use still requires a configured TURN service and relay
verification. Without it, the repaired WebCodecs WSS and bounded JPEG WSS
paths remain the supported transports.
