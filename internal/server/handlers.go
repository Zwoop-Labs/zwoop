package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/Zwoop-Labs/zwoop/internal/config"
	"github.com/Zwoop-Labs/zwoop/internal/session"
	"github.com/coder/websocket"
)

type signalMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

func sessionHandler(store *session.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code, err := store.Create()
		if err != nil {
			if errors.Is(err, session.ErrStoreFull) {
				http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			} else {
				slog.Error("failed to create session", "err", err)
				http.Error(w, "internal error", http.StatusInternalServerError)
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"code": code})
	}
}

func wsHandler(store *session.Store, cfg *config.Config) http.HandlerFunc {
	acceptOpts := &websocket.AcceptOptions{}
	if cfg.AllowedOrigin != "" {
		acceptOpts.OriginPatterns = []string{cfg.AllowedOrigin}
	} else {
		// Dev mode or no reverse proxy: skip origin check. Set ALLOWED_ORIGIN in production.
		acceptOpts.InsecureSkipVerify = true
	}

	return func(w http.ResponseWriter, r *http.Request) {
		code := r.PathValue("code")
		role := r.URL.Query().Get("role")
		if role != "sender" && role != "receiver" {
			http.Error(w, "role must be sender or receiver", http.StatusBadRequest)
			return
		}

		conn, err := websocket.Accept(w, r, acceptOpts)
		if err != nil {
			slog.Error("ws accept failed", "err", err)
			return
		}
		// 64 KB is generous for WebRTC signaling (SDP + ICE candidates are a few KB each).
		conn.SetReadLimit(64 * 1024)

		sess, inCh, ok := store.Join(code, role)
		if !ok {
			_ = conn.Close(websocket.StatusNormalClosure, "session not found or role already taken")
			return
		}

		defer func() {
			if err := conn.CloseNow(); err != nil {
				slog.Debug("ws close", "err", err)
			}
			// Clear the role slot so this peer can reconnect, and notify the
			// other peer if one was connected.
			if other := store.ClearAndGetOther(code, role); other != nil {
				msg, _ := json.Marshal(signalMessage{Type: "peer-left"})
				select {
				case other <- msg:
				default:
					// Channel full — deliver asynchronously so this goroutine
					// is not held hostage by a slow or adversarial peer.
					go func() {
						select {
						case other <- msg:
						case <-time.After(5 * time.Second):
						}
					}()
				}
			}
		}()

		ctx := r.Context()

		// If already paired after joining, notify both sides atomically.
		if other := sess.OtherIfPaired(role); other != nil {
			paired, _ := json.Marshal(signalMessage{Type: "paired"})
			if err := conn.Write(ctx, websocket.MessageText, paired); err != nil {
				return
			}
			select {
			case other <- paired:
			case <-ctx.Done():
				return
			}
		}

		// Forward messages between peers.
		readDone := make(chan struct{})

		go func() {
			defer close(readDone)
			for {
				_, msg, err := conn.Read(ctx)
				if err != nil {
					return
				}
				// Re-check Other() each read — the other peer may have joined after us.
				if ch := sess.Other(role); ch != nil {
					select {
					case ch <- msg:
					case <-ctx.Done():
						return
					}
				}
			}
		}()

		pingTicker := time.NewTicker(30 * time.Second)
		defer pingTicker.Stop()

		for {
			select {
			case msg, ok := <-inCh:
				if !ok {
					return
				}
				if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
					return
				}
			case <-pingTicker.C:
				if err := conn.Ping(ctx); err != nil {
					return
				}
			case <-readDone:
				return
			case <-ctx.Done():
				return
			}
		}
	}
}

type iceServer struct {
	URLs []string `json:"urls"`
}

var iceServersResponse = mustMarshal([]iceServer{{URLs: []string{"stun:stun.l.google.com:19302"}}})

func mustMarshal(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func iceServersHandler(_ *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(iceServersResponse)
	}
}

func versionHandler(version string) http.HandlerFunc {
	body, _ := json.Marshal(map[string]string{"version": version})
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
