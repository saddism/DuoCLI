package main

// DuoCLI Android media helper.
//
// The helper is deliberately a separate process: Electron owns ADB, auth and
// control arbitration, while this process owns Pion peer/RTP state. Node and
// the helper communicate over authenticated length-prefixed loopback sockets.
// stdout is reserved for one JSON handshake; diagnostics go to stderr.

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

const (
	maxControlMessage = 64 * 1024
	maxMediaPacket    = 16 * 1024 * 1024
	maxPeerCount      = 32
)

type message struct {
	Type        string                   `json:"type"`
	RequestID   string                   `json:"requestId,omitempty"`
	Token       string                   `json:"token,omitempty"`
	PeerID      string                   `json:"peerId,omitempty"`
	SourceID    uint32                   `json:"sourceId,omitempty"`
	SDP         string                   `json:"sdp,omitempty"`
	Candidate   *webrtc.ICECandidateInit `json:"candidate,omitempty"`
	EndOfCand   bool                     `json:"endOfCandidates,omitempty"`
	MediaEpoch  uint32                   `json:"mediaEpoch,omitempty"`
	Negotiation string                   `json:"negotiationId,omitempty"`
	Payload     json.RawMessage          `json:"payload,omitempty"`
}

type handshake struct {
	Version int    `json:"version"`
	Control string `json:"controlAddr"`
	Media   string `json:"mediaAddr"`
	Token   string `json:"token"`
	PID     int    `json:"pid"`
	Build   string `json:"buildId"`
}

type helper struct {
	token   string
	control net.Listener
	media   net.Listener
	peersMu sync.RWMutex
	peers   map[string]*peer
	sources map[uint32]rtp.Packetizer
	ctx     context.Context
	cancel  context.CancelFunc
}

type peer struct {
	id         string
	sourceID   uint32
	pc         *webrtc.PeerConnection
	track      *webrtc.TrackLocalStaticRTP
	packetMu   sync.Mutex
	packetizer rtp.Packetizer
	lastRTP    uint32
	hasRTP     bool
	writeMu    sync.Mutex
	control    *bufio.Writer
}

func (p *peer) send(value any) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	return writeJSON(p.control, value)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "[android-media]", err)
		os.Exit(1)
	}
}

func run() error {
	control, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	media, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = control.Close()
		return err
	}
	tokenBytes := make([]byte, 24)
	if _, err := rand.Read(tokenBytes); err != nil {
		return err
	}
	token := hex.EncodeToString(tokenBytes)
	ctx, cancel := context.WithCancel(context.Background())
	h := &helper{token: token, control: control, media: media, peers: make(map[string]*peer), sources: make(map[uint32]rtp.Packetizer), ctx: ctx, cancel: cancel}
	defer func() { cancel(); _ = control.Close(); _ = media.Close(); h.closePeers() }()

	handshakeJSON, _ := json.Marshal(handshake{Version: 1, Control: control.Addr().String(), Media: media.Addr().String(), Token: token, PID: os.Getpid(), Build: "pion-v4"})
	if _, err := fmt.Fprintln(os.Stdout, string(handshakeJSON)); err != nil {
		return err
	}
	go h.acceptControl()
	go h.acceptMedia()
	if parentPID, _ := strconv.Atoi(os.Getenv("DUOCLI_PARENT_PID")); parentPID > 1 {
		go h.watchParent(parentPID)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	select {
	case <-signals:
		return nil
	case <-ctx.Done():
		return nil
	}
}

func (h *helper) acceptControl() {
	for {
		conn, err := h.control.Accept()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				fmt.Fprintln(os.Stderr, "control accept:", err)
			}
			return
		}
		go h.serveControl(conn)
	}
}

func (h *helper) acceptMedia() {
	for {
		conn, err := h.media.Accept()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				fmt.Fprintln(os.Stderr, "media accept:", err)
			}
			return
		}
		go h.serveMedia(conn)
	}
}

func (h *helper) serveControl(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	writer := bufio.NewWriter(conn)
	first := true
	for {
		payload, err := readFrame(reader, maxControlMessage)
		if err != nil {
			return
		}
		var msg message
		if json.Unmarshal(payload, &msg) != nil {
			return
		}
		if first {
			first = false
			if msg.Type != "hello" || msg.Token != h.token {
				return
			}
			_ = writeJSON(writer, message{Type: "hello.ok"})
			continue
		}
		h.handleControl(writer, msg)
	}
}

func (h *helper) handleControl(writer *bufio.Writer, msg message) {
	switch msg.Type {
	case "peer.create":
		h.peersMu.RLock()
		peerCount := len(h.peers)
		h.peersMu.RUnlock()
		if peerCount >= maxPeerCount {
			_ = writeJSON(writer, message{Type: "error", RequestID: msg.RequestID, Payload: json.RawMessage(`{"code":"PEER_LIMIT"}`)})
			return
		}
		if err := h.createPeer(writer, msg); err != nil {
			_ = writeJSON(writer, message{Type: "error", RequestID: msg.RequestID, Payload: json.RawMessage(fmt.Sprintf(`{"code":"PEER_CREATE_FAILED","message":%q}`, err.Error()))})
		}
	case "peer.answer":
		if err := h.setAnswer(msg); err != nil {
			_ = writeJSON(writer, message{Type: "error", RequestID: msg.RequestID, Payload: json.RawMessage(fmt.Sprintf(`{"code":"PEER_ANSWER_FAILED","message":%q}`, err.Error()))})
		}
	case "peer.ice":
		if err := h.addICE(msg); err != nil {
			_ = writeJSON(writer, message{Type: "error", RequestID: msg.RequestID, Payload: json.RawMessage(fmt.Sprintf(`{"code":"ICE_FAILED","message":%q}`, err.Error()))})
		}
	case "peer.close":
		h.closePeer(msg.PeerID)
	case "source.remove":
		h.sourcesDelete(msg.SourceID)
	case "source.add":
		// Source packets arrive on the media socket. Keeping an explicit source
		// command makes lifecycle/restart races observable to the parent.
		_ = writeJSON(writer, message{Type: "source.ready", SourceID: msg.SourceID, RequestID: msg.RequestID})
	default:
		_ = writeJSON(writer, message{Type: "error", RequestID: msg.RequestID, Payload: json.RawMessage(`{"code":"PROTOCOL_UNSUPPORTED"}`)})
	}
}

func (h *helper) createPeer(writer *bufio.Writer, msg message) error {
	if msg.PeerID == "" {
		return errors.New("peerId is required")
	}
	h.peersMu.RLock()
	_, exists := h.peers[msg.PeerID]
	h.peersMu.RUnlock()
	if exists {
		return errors.New("peer already exists")
	}
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "packetization-mode=1", RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}}}, PayloadType: 96}, webrtc.RTPCodecTypeVideo); err != nil {
		return err
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return err
	}
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "packetization-mode=1"}, "video", "duocli")
	if err != nil {
		_ = pc.Close()
		return err
	}
	if _, err = pc.AddTrack(track); err != nil {
		_ = pc.Close()
		return err
	}
	p := &peer{id: msg.PeerID, sourceID: msg.SourceID, pc: pc, track: track, control: writer, packetizer: rtp.NewPacketizer(1200, 96, 0, &codecs.H264Payloader{}, rtp.NewRandomSequencer(), 90000)}
	h.peersMu.Lock()
	h.peers[msg.PeerID] = p
	h.peersMu.Unlock()
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			_ = p.send(message{Type: "rtc.ice", PeerID: msg.PeerID, Negotiation: msg.Negotiation, Candidate: func() *webrtc.ICECandidateInit { c := candidate.ToJSON(); return &c }()})
		}
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		_ = p.send(message{Type: "peer.state", PeerID: msg.PeerID, Payload: json.RawMessage(fmt.Sprintf(`{"state":%q}`, state.String()))})
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			h.closePeer(msg.PeerID)
		}
	})
	if sender, ok := pc.GetSenders()[0], true; ok {
		go h.readRTCP(msg.PeerID, sender)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	if err = pc.SetLocalDescription(offer); err != nil {
		return err
	}
	return writeJSON(writer, message{Type: "rtc.offer", PeerID: msg.PeerID, Negotiation: msg.Negotiation, SDP: offer.SDP})
}

func (h *helper) setAnswer(msg message) error {
	h.peersMu.RLock()
	p := h.peers[msg.PeerID]
	h.peersMu.RUnlock()
	if p == nil {
		return errors.New("unknown peer")
	}
	return p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: msg.SDP})
}
func (h *helper) addICE(msg message) error {
	h.peersMu.RLock()
	p := h.peers[msg.PeerID]
	h.peersMu.RUnlock()
	if p == nil || msg.Candidate == nil {
		return errors.New("unknown peer/candidate")
	}
	return p.pc.AddICECandidate(*msg.Candidate)
}

func (h *helper) serveMedia(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	for {
		header := make([]byte, 8)
		if _, err := io.ReadFull(reader, header); err != nil {
			return
		}
		sourceID := binary.BigEndian.Uint32(header)
		length := binary.BigEndian.Uint32(header[4:])
		if length == 0 || length > maxMediaPacket {
			return
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return
		}
		h.broadcastRTP(sourceID, payload)
	}
}

func (h *helper) broadcastRTP(sourceID uint32, packet []byte) {
	if len(packet) < 56 || string(packet[:4]) != "DVM2" || packet[4] != 2 || packet[5] != 1 {
		return
	}
	flags := binary.BigEndian.Uint16(packet[6:8])
	if flags&^uint16(3) != 0 || binary.BigEndian.Uint32(packet[52:56]) != 0 {
		return
	}
	payloadLength := binary.BigEndian.Uint32(packet[44:48])
	if payloadLength == 0 || int(payloadLength)+56 != len(packet) {
		return
	}
	pts := binary.BigEndian.Uint64(packet[24:32])
	h.peersMu.RLock()
	defer h.peersMu.RUnlock()
	for _, p := range h.peers {
		p.packetMu.Lock()
		if p.sourceID != 0 && p.sourceID != sourceID {
			p.packetMu.Unlock()
			continue
		}
		if p.packetizer == nil {
			p.packetizer = rtp.NewPacketizer(1200, 96, 0, &codecs.H264Payloader{}, rtp.NewRandomSequencer(), 90000)
		}
		// DVM2 carries source PTS in microseconds. Keep a 90 kHz RTP clock;
		// a zero/unknown PTS falls back to a monotonic frame step.
		// Split before multiplying so a malicious/maximal uint64 PTS cannot
		// overflow the 64-bit product. RTP timestamps intentionally wrap at
		// uint32 after the safe conversion.
		timestamp := uint32((pts/1000000)*90 + ((pts%1000000)*90)/1000000)
		if pts == 0 {
			if p.hasRTP {
				timestamp = p.lastRTP + 3000 // 33ms fallback on the 90kHz clock
			}
		} else if p.hasRTP && timestamp <= p.lastRTP {
			timestamp = p.lastRTP + 1
		}
		p.lastRTP, p.hasRTP = timestamp, true
		packets := p.packetizer.Packetize(packet[56:], timestamp)
		for i := range packets {
			_ = p.track.WriteRTP(packets[i])
		}
		p.packetMu.Unlock()
	}
}

func (h *helper) readRTCP(peerID string, sender *webrtc.RTPSender) {
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, packet := range packets {
			data, _ := json.Marshal(packet)
			_ = func() error {
				h.peersMu.RLock()
				p := h.peers[peerID]
				h.peersMu.RUnlock()
				if p == nil {
					return nil
				}
				return p.send(message{Type: "media.feedback", PeerID: peerID, Payload: data})
			}()
		}
	}
}

func (h *helper) closePeer(id string) {
	h.peersMu.Lock()
	p := h.peers[id]
	delete(h.peers, id)
	h.peersMu.Unlock()
	if p != nil {
		_ = p.pc.Close()
	}
}
func (h *helper) closePeers() {
	h.peersMu.Lock()
	peers := h.peers
	h.peers = make(map[string]*peer)
	h.peersMu.Unlock()
	for _, p := range peers {
		_ = p.pc.Close()
	}
}
func (h *helper) sourcesDelete(id uint32) { delete(h.sources, id) }

func (h *helper) watchParent(parentPID int) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-h.ctx.Done():
			return
		case <-ticker.C:
			if err := syscall.Kill(parentPID, 0); err != nil {
				h.cancel()
				return
			}
		}
	}
}

func readFrame(reader *bufio.Reader, max int) ([]byte, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, err
	}
	length := binary.BigEndian.Uint32(header)
	if length == 0 || length > uint32(max) {
		return nil, errors.New("frame too large")
	}
	payload := make([]byte, length)
	_, err := io.ReadFull(reader, payload)
	return payload, err
}
func writeJSON(writer *bufio.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil || len(payload) > maxControlMessage {
		return errors.New("invalid control message")
	}
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(payload)))
	if _, err = writer.Write(header); err != nil {
		return err
	}
	if _, err = writer.Write(payload); err != nil {
		return err
	}
	return writer.Flush()
}
