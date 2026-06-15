package server

import (
	"io/fs"
	"log/slog"
	"net/http"
	"strings"

	"github.com/Zwoop-Labs/zwoop/internal/config"
	"github.com/Zwoop-Labs/zwoop/internal/session"
	"github.com/Zwoop-Labs/zwoop/web"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func cspMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:; object-src 'none'; base-uri 'none'")
		next.ServeHTTP(w, r)
	})
}

func New(store *session.Store, cfg *config.Config, version string) http.Handler {
	return newWithLimiter(store, cfg, version, newIPLimiter(cfg.TrustedProxy, sessionRateLimitMax, rateLimitWindow))
}

func newWithLimiter(store *session.Store, cfg *config.Config, version string, sessionLimiter *ipLimiter) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.StripSlashes)
	r.Use(cspMiddleware)

	r.Get("/healthz", healthHandler)
	r.Route("/api", func(r chi.Router) {
		r.With(rateLimitMiddleware(sessionLimiter)).Post("/session", sessionHandler(store))
		r.Get("/ice-servers", iceServersHandler(cfg))
		r.Get("/version", versionHandler(version))
	})
	r.Get("/ws/{code}", wsHandler(store, cfg))

	r.Handle("/*", spaHandler())

	return r
}

func spaHandler() http.Handler {
	sub, err := fs.Sub(web.FS, "dist")
	if err != nil {
		panic("failed to sub static files: " + err.Error())
	}
	fsHandler := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "."
		}

		if f, err := sub.Open(name); err == nil {
			if err := f.Close(); err != nil {
				slog.Warn("failed to close static file probe", "name", name, "err", err)
			}
			// Cache hashed assets indefinitely; everything else no-cache.
			if strings.HasPrefix(name, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			fsHandler.ServeHTTP(w, r)
			return
		}

		// SPA fallback: serve index.html for client-side routes.
		w.Header().Set("Cache-Control", "no-cache")
		r.URL.Path = "/"
		fsHandler.ServeHTTP(w, r)
	})
}
