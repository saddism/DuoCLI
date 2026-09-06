export interface AndroidWebRtcOptions {
  sendSignal: (message: Record<string, unknown>) => void;
  onState?: (state: string) => void;
  onFrame?: () => void;
  onError?: (error: Error) => void;
  iceServers?: RTCIceServer[];
}

/**
 * Small browser-side WebRTC sink used by the optional Pion helper. Signalling
 * remains on the authenticated control WSS; this class only owns a peer and a
 * video element, so a failed peer can be replaced without touching controls.
 */
export class AndroidWebRtcClient {
  private peer: RTCPeerConnection | null = null;
  private video: HTMLVideoElement | null = null;
  private generation = 0;
  private negotiationId = '';
  private remoteDescriptionSet = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(private readonly options: AndroidWebRtcOptions) {}

  async connect(video: HTMLVideoElement, peerId: string, sessionId: string, subscriptionId: string): Promise<void> {
    this.close();
    const generation = ++this.generation;
    this.video = video;
    this.negotiationId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
    if (typeof RTCPeerConnection !== 'function') {
      this.fail(new Error('当前浏览器没有 WebRTC 能力'));
      return;
    }
    const peer = new RTCPeerConnection({ iceServers: this.options.iceServers || [] });
    this.peer = peer;
    peer.onicecandidate = (event) => {
      if (generation !== this.generation || !event.candidate) return;
      this.options.sendSignal({ v: 2, type: 'rtc.ice', peerId, sessionId, subscriptionId, negotiationId: this.negotiationId, candidate: event.candidate.toJSON() });
    };
    peer.onconnectionstatechange = () => {
      if (generation !== this.generation) return;
      this.options.onState?.(peer.connectionState);
      if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) this.fail(new Error(`WebRTC 连接状态: ${peer.connectionState}`));
    };
    peer.ontrack = (event) => {
      if (generation !== this.generation || !this.video) return;
      this.video.muted = true;
      this.video.autoplay = true;
      this.video.playsInline = true;
      this.video.srcObject = event.streams[0] || new MediaStream([event.track]);
      const markFrame = () => this.options.onFrame?.();
      if ('requestVideoFrameCallback' in this.video) (this.video as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(markFrame);
      else this.video.addEventListener('loadeddata', markFrame, { once: true });
      void this.video.play().catch((error) => this.fail(Object.assign(new Error('浏览器阻止自动播放，请点击开始画面'), { code: 'PLAYBACK_BLOCKED', cause: error })));
    };
    this.options.sendSignal({ v: 2, type: 'rtc.ready', peerId, sessionId, subscriptionId, negotiationId: this.negotiationId });
  }

  async handleSignal(message: any): Promise<void> {
    const peer = this.peer;
    if (!peer || !message || message.negotiationId !== this.negotiationId) return;
    try {
      if (message.type === 'rtc.offer') {
        const sdp = String(message.sdp || '');
        if (!sdp || sdp.length > 64 * 1024) throw Object.assign(new Error('WebRTC SDP 过大或为空'), { code: 'PROTOCOL_UNSUPPORTED' });
        await peer.setRemoteDescription({ type: 'offer', sdp });
        this.remoteDescriptionSet = true;
        const candidates = this.pendingCandidates.splice(0);
        for (const candidate of candidates) await peer.addIceCandidate(candidate);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        this.options.sendSignal({ v: 2, type: 'rtc.answer', peerId: message.peerId, negotiationId: this.negotiationId, sdp: answer.sdp || '' });
      } else if (message.type === 'rtc.ice' && message.candidate) {
        const candidate = message.candidate as RTCIceCandidateInit;
        const serialized = JSON.stringify(candidate);
        if (serialized.length > 16 * 1024) throw Object.assign(new Error('WebRTC ICE candidate 过大'), { code: 'PROTOCOL_UNSUPPORTED' });
        if (!this.remoteDescriptionSet) {
          if (this.pendingCandidates.length < 128) this.pendingCandidates.push(candidate);
        } else {
          await peer.addIceCandidate(candidate);
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(): void {
    this.generation++;
    const peer = this.peer;
    this.peer = null;
    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
    if (peer) peer.close();
    if (this.video) this.video.srcObject = null;
    this.video = null;
  }

  private fail(error: Error): void {
    const value = error as Error & { code?: string; stage?: string };
    value.code ||= 'ICE_FAILED';
    value.stage ||= 'transport';
    this.options.onError?.(value);
  }
}
