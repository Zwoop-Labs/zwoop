package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Zwoop-Labs/zwoop/internal/config"
	"github.com/Zwoop-Labs/zwoop/internal/session"
	"github.com/Zwoop-Labs/zwoop/web"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func newTestServer(t *testing.T, cfg *config.Config) *httptest.Server {
	t.Helper()
	store := session.NewStore()
	t.Cleanup(store.Close)
	return httptest.NewServer(newWithLimiter(store, cfg, newIPLimiter(false, sessionRateLimitMax, rateLimitWindow)))
}

type fakeClock struct{ t time.Time }

func (f *fakeClock) Now() time.Time          { return f.t }
func (f *fakeClock) advance(d time.Duration) { f.t = f.t.Add(d) }

func newTestServerWithLimiter(t *testing.T, cfg *config.Config, sessionLimiter *ipLimiter) *httptest.Server {
	t.Helper()
	store := session.NewStore()
	t.Cleanup(store.Close)
	return httptest.NewServer(newWithLimiter(store, cfg, sessionLimiter))
}

func defaultCfg() *config.Config {
	return &config.Config{Port: "0"}
}

func mustDecode(t *testing.T, resp *http.Response, v any) {
	t.Helper()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	_ = resp.Body.Close()
}

// ── /healthz ─────────────────────────────────────────────────────────────────

func TestHealthz(t *testing.T) {
	srv := newTestServer(t, defaultCfg())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]string
	mustDecode(t, resp, &body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if body["status"] != "ok" {
		t.Fatalf("expected status=ok, got %v", body)
	}
}

// ── POST /api/session ─────────────────────────────────────────────────────────

func TestSessionHandler(t *testing.T) {
	srv := newTestServer(t, defaultCfg())
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/session", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]string
	mustDecode(t, resp, &body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	code := body["code"]
	if len(code) != 8 {
		t.Fatalf("expected 8-char code, got %q", code)
	}
	for _, c := range code {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
			t.Fatalf("code contains character outside [a-z0-9]: %q", code)
		}
	}
}

// ── GET /api/ice-servers ──────────────────────────────────────────────────────

func TestIceServers(t *testing.T) {
	srv := newTestServer(t, defaultCfg())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/ice-servers")
	if err != nil {
		t.Fatal(err)
	}
	var servers []iceServer
	mustDecode(t, resp, &servers)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if len(servers) != 1 {
		t.Fatalf("expected 1 ICE server, got %d", len(servers))
	}
	if len(servers[0].URLs) == 0 || !strings.HasPrefix(servers[0].URLs[0], "stun:") {
		t.Fatalf("expected a STUN URL, got %v", servers[0].URLs)
	}
}

// ── WebSocket relay ───────────────────────────────────────────────────────────

func createSession(t *testing.T, srvURL string) string {
	t.Helper()
	resp, err := http.Post(srvURL+"/api/session", "", nil)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	var body map[string]string
	mustDecode(t, resp, &body)
	return body["code"]
}

func TestWSRelay(t *testing.T) {
	srv := newTestServer(t, defaultCfg())
	defer srv.Close()

	code := createSession(t, srv.URL)
	wsBase := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx := context.Background()

	rConn, _, err := websocket.Dial(ctx, wsBase+"/ws/"+code+"?role=receiver", nil)
	if err != nil {
		t.Fatalf("receiver dial: %v", err)
	}
	defer func() { _ = rConn.CloseNow() }()

	sConn, _, err := websocket.Dial(ctx, wsBase+"/ws/"+code+"?role=sender", nil)
	if err != nil {
		t.Fatalf("sender dial: %v", err)
	}
	defer func() { _ = sConn.CloseNow() }()

	// Both sides should receive {"type":"paired"}.
	var sMsg, rMsg signalMessage
	if err := wsjson.Read(ctx, sConn, &sMsg); err != nil {
		t.Fatalf("sender read paired: %v", err)
	}
	if sMsg.Type != "paired" {
		t.Fatalf("expected paired, got %q", sMsg.Type)
	}
	if err := wsjson.Read(ctx, rConn, &rMsg); err != nil {
		t.Fatalf("receiver read paired: %v", err)
	}
	if rMsg.Type != "paired" {
		t.Fatalf("expected paired, got %q", rMsg.Type)
	}

	// Sender relays a message → receiver should receive it.
	payload, _ := json.Marshal("hello")
	if err := wsjson.Write(ctx, sConn, signalMessage{Type: "offer", Payload: payload}); err != nil {
		t.Fatalf("sender write: %v", err)
	}
	var relayed signalMessage
	if err := wsjson.Read(ctx, rConn, &relayed); err != nil {
		t.Fatalf("receiver read relayed: %v", err)
	}
	if relayed.Type != "offer" {
		t.Fatalf("expected offer, got %q", relayed.Type)
	}
}

func TestWSRelayPeerLeft(t *testing.T) {
	srv := newTestServer(t, defaultCfg())
	defer srv.Close()

	code := createSession(t, srv.URL)
	wsBase := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx := context.Background()

	rConn, _, err := websocket.Dial(ctx, wsBase+"/ws/"+code+"?role=receiver", nil)
	if err != nil {
		t.Fatalf("receiver dial: %v", err)
	}
	defer func() { _ = rConn.CloseNow() }()

	sConn, _, err := websocket.Dial(ctx, wsBase+"/ws/"+code+"?role=sender", nil)
	if err != nil {
		t.Fatalf("sender dial: %v", err)
	}

	// Drain the "paired" messages.
	var m signalMessage
	if err := wsjson.Read(ctx, sConn, &m); err != nil {
		t.Fatalf("sender read paired: %v", err)
	}
	if err := wsjson.Read(ctx, rConn, &m); err != nil {
		t.Fatalf("receiver read paired: %v", err)
	}

	// Sender disconnects abruptly.
	_ = sConn.CloseNow()

	// Receiver should get "peer-left".
	if err := wsjson.Read(ctx, rConn, &m); err != nil {
		t.Fatalf("receiver read after sender left: %v", err)
	}
	if m.Type != "peer-left" {
		t.Fatalf("expected peer-left, got %q", m.Type)
	}
}

func TestWSUnknownCode(t *testing.T) {
	srv := newTestServer(t, defaultCfg())
	defer srv.Close()

	wsBase := "ws" + strings.TrimPrefix(srv.URL, "http")
	// WebSocket upgrade succeeds; server then closes the connection because the
	// session code is unknown (Join is called after Accept now to avoid leaking
	// the role slot on upgrade failures).
	conn, _, err := websocket.Dial(context.Background(), wsBase+"/ws/00000000?role=receiver", nil)
	if err != nil {
		t.Fatalf("unexpected dial error: %v", err)
	}
	defer conn.CloseNow()
	_, _, err = conn.Read(context.Background())
	if err == nil {
		t.Fatal("expected connection to be closed by server for unknown code")
	}
}

// ── extractIP ────────────────────────────────────────────────────────────────

func TestExtractIP(t *testing.T) {
	cases := []struct {
		name       string
		realIP     string
		xff        string
		remoteAddr string
		trust      bool
		want       string
	}{
		{name: "X-Real-IP trusted", realIP: "  1.2.3.4  ", trust: true, want: "1.2.3.4"},
		{name: "XFF single trusted", xff: " 5.6.7.8 ", trust: true, want: "5.6.7.8"},
		{name: "XFF comma trusted", xff: "5.6.7.8, 9.10.11.12", trust: true, want: "5.6.7.8"},
		// With trustProxy=false, proxy headers must be ignored and RemoteAddr used instead.
		{name: "X-Real-IP untrusted", realIP: "1.2.3.4", remoteAddr: "10.0.0.1:1234", trust: false, want: "10.0.0.1"},
		{name: "RemoteAddr with port", remoteAddr: "192.168.1.1:9999", trust: false, want: "192.168.1.1"},
		{name: "RemoteAddr no port", remoteAddr: "192.168.1.1", trust: false, want: "192.168.1.1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, _ := http.NewRequest(http.MethodGet, "/", nil)
			if tc.realIP != "" {
				r.Header.Set("X-Real-IP", tc.realIP)
			}
			if tc.xff != "" {
				r.Header.Set("X-Forwarded-For", tc.xff)
			}
			if tc.remoteAddr != "" {
				r.RemoteAddr = tc.remoteAddr
			}
			if got := extractIP(r, tc.trust); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// ── server.New ────────────────────────────────────────────────────────────────

func TestNew(t *testing.T) {
	store := session.NewStore()
	t.Cleanup(store.Close)
	srv := httptest.NewServer(New(store, defaultCfg()))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
}

// ── spaHandler ────────────────────────────────────────────────────────────────

func TestSPARoot(t *testing.T) {
	srv := newTestServer(t, defaultCfg())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if resp.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("expected no-cache, got %q", resp.Header.Get("Cache-Control"))
	}
}

func TestSPAFallback(t *testing.T) {
	srv := newTestServer(t, defaultCfg())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/join/12345678")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for SPA fallback, got %d", resp.StatusCode)
	}
	if resp.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("expected no-cache, got %q", resp.Header.Get("Cache-Control"))
	}
}

func TestSPAAssetCacheHeader(t *testing.T) {
	srv := newTestServer(t, defaultCfg())
	defer srv.Close()

	// Pick any real asset from the embedded dist.
	var assetPath string
	entries, err := web.FS.ReadDir("dist/assets")
	if err != nil || len(entries) == 0 {
		t.Skip("no assets in dist — run build-web first")
	}
	assetPath = "/assets/" + entries[0].Name()

	resp, err := http.Get(srv.URL + assetPath)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for asset, got %d", resp.StatusCode)
	}
	cc := resp.Header.Get("Cache-Control")
	if cc != "public, max-age=31536000, immutable" {
		t.Fatalf("expected immutable cache header, got %q", cc)
	}
}

// ── wsHandler bad role ────────────────────────────────────────────────────────

func TestWSBadRole(t *testing.T) {
	srv := newTestServer(t, defaultCfg())
	defer srv.Close()

	wsBase := "ws" + strings.TrimPrefix(srv.URL, "http")
	code := createSession(t, srv.URL)
	_, resp, err := websocket.Dial(context.Background(), wsBase+"/ws/"+code+"?role=observer", nil)
	if err == nil {
		t.Fatal("expected dial to fail for bad role")
	}
	if resp == nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %v", resp)
	}
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

func TestRateLimitSessionHandler(t *testing.T) {
	fc := &fakeClock{t: time.Now()}
	l := &ipLimiter{windows: make(map[string][]time.Time), clock: fc, trustProxy: false, max: sessionRateLimitMax, window: rateLimitWindow}
	srv := newTestServerWithLimiter(t, defaultCfg(), l)
	defer srv.Close()

	for i := range 5 {
		resp, err := http.Post(srv.URL+"/api/session", "", nil)
		if err != nil {
			t.Fatalf("request %d: %v", i+1, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("request %d: expected 200, got %d", i+1, resp.StatusCode)
		}
	}

	resp, err := http.Post(srv.URL+"/api/session", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusTooManyRequests {
		_ = resp.Body.Close()
		t.Fatalf("expected 429 on 6th request, got %d", resp.StatusCode)
	}
	var body map[string]string
	mustDecode(t, resp, &body)
	if body["error"] != "rate limit exceeded" {
		t.Fatalf("unexpected body: %v", body)
	}
}

func TestRateLimitWindowReset(t *testing.T) {
	fc := &fakeClock{t: time.Now()}
	l := &ipLimiter{windows: make(map[string][]time.Time), clock: fc, trustProxy: false, max: sessionRateLimitMax, window: rateLimitWindow}
	srv := newTestServerWithLimiter(t, defaultCfg(), l)
	defer srv.Close()

	for range 5 {
		resp, _ := http.Post(srv.URL+"/api/session", "", nil)
		_ = resp.Body.Close()
	}

	fc.advance(61 * time.Second)

	resp, err := http.Post(srv.URL+"/api/session", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 after window reset, got %d", resp.StatusCode)
	}
}
