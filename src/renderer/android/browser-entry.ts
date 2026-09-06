/** Browser-facing entry point for the shared Android transport modules. */
export { AndroidMirrorClient } from '../android-mirror-client';
export { AndroidWebRtcClient } from './webrtc';

import { AndroidMirrorClient } from '../android-mirror-client';
import { AndroidWebRtcClient } from './webrtc';

const target = globalThis as typeof globalThis & {
  DuoAndroidMirrorClient?: typeof AndroidMirrorClient;
  DuoAndroidWebRtcClient?: typeof AndroidWebRtcClient;
};
target.DuoAndroidMirrorClient ||= AndroidMirrorClient;
target.DuoAndroidWebRtcClient ||= AndroidWebRtcClient;
