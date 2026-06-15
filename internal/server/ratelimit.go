package server

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	sessionRateLimitMax = 5
	rateLimitWindow     = 60 * time.Second
	// maxTrackedIPs caps the in-memory map so a botnet rotating through millions
	// of unique IPs cannot exhaust heap. New IPs are denied when the cap is hit.
	maxTrackedIPs = 100_000
)

type clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

type ipLimiter struct {
	mu         sync.Mutex
	windows    map[string][]time.Time
	clock      clock
	trustProxy bool
	max        int
	window     time.Duration
}

func newIPLimiter(trustProxy bool, max int, window time.Duration) *ipLimiter {
	return &ipLimiter{windows: make(map[string][]time.Time), clock: realClock{}, trustProxy: trustProxy, max: max, window: window}
}

func (l *ipLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.clock.Now()
	cutoff := now.Add(-l.window)

	ts := l.windows[ip]
	i := 0
	for i < len(ts) && ts[i].Before(cutoff) {
		i++
	}
	ts = ts[i:]

	// Lazy cleanup: delete the map entry when the window is empty.
	if len(ts) == 0 {
		delete(l.windows, ip)
		// Enforce the map cap for new IPs — deny when saturated to prevent
		// unbounded memory growth from botnet IP rotation.
		if len(l.windows) >= maxTrackedIPs {
			return false
		}
	}

	if len(ts) >= l.max {
		l.windows[ip] = ts
		return false
	}

	l.windows[ip] = append(ts, now)
	return true
}

// extractIP returns the client IP. Proxy headers are only trusted when
// trustProxy is true — set via TRUST_PROXY_HEADERS=true — to prevent spoofing
// when the server is exposed directly without a reverse proxy.
func extractIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if ip := r.Header.Get("X-Real-IP"); ip != "" {
			return strings.TrimSpace(ip)
		}
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if first, _, ok := strings.Cut(xff, ","); ok {
				return strings.TrimSpace(first)
			}
			return strings.TrimSpace(xff)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func rateLimitMiddleware(l *ipLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !l.allow(extractIP(r, l.trustProxy)) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "rate limit exceeded"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
