export type CaptureState = 'idle' | 'starting' | 'ready' | 'restarting' | 'offline' | 'error';
export type PlaybackState = 'probing' | 'connecting' | 'awaiting-keyframe' | 'playing' | 'recovering' | 'suspended' | 'unavailable';
export type ControlState = 'view-only' | 'claiming' | 'ready' | 'recovering' | 'unavailable';
export type VideoTransport = 'webrtc' | 'webcodecs-ws' | 'jpeg-ws' | 'screenshot-http';

export interface AndroidMirrorState {
  capture: CaptureState;
  playback: PlaybackState;
  control: ControlState;
  transport: VideoTransport;
  captureGeneration: number;
  geometryVersion: number;
  configVersion: number;
  mediaEpoch: number;
  controlEpoch: number;
  lastPresentedAt: number;
}

export function initialAndroidMirrorState(): AndroidMirrorState {
  return { capture: 'idle', playback: 'probing', control: 'view-only', transport: 'screenshot-http', captureGeneration: 0, geometryVersion: 0, configVersion: 0, mediaEpoch: 0, controlEpoch: 0, lastPresentedAt: 0 };
}

/** Monotonic metadata guard shared by sinks when WSS messages reorder. */
export function applyAndroidMetadata(state: AndroidMirrorState, metadata: Partial<AndroidMirrorState>): AndroidMirrorState {
  const next = { ...state };
  if (Number.isInteger(metadata.captureGeneration) && Number(metadata.captureGeneration) >= state.captureGeneration) next.captureGeneration = Number(metadata.captureGeneration);
  if (Number.isInteger(metadata.geometryVersion) && Number(metadata.geometryVersion) >= state.geometryVersion) next.geometryVersion = Number(metadata.geometryVersion);
  if (Number.isInteger(metadata.configVersion) && Number(metadata.configVersion) >= state.configVersion) next.configVersion = Number(metadata.configVersion);
  if (Number.isInteger(metadata.mediaEpoch) && Number(metadata.mediaEpoch) >= state.mediaEpoch) next.mediaEpoch = Number(metadata.mediaEpoch);
  return next;
}

export function markPresented(state: AndroidMirrorState, at = Date.now()): AndroidMirrorState {
  return { ...state, playback: 'playing', lastPresentedAt: at };
}
