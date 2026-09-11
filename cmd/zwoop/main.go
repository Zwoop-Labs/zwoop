package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Zwoop-Labs/zwoop/internal/config"
	"github.com/Zwoop-Labs/zwoop/internal/server"
	"github.com/Zwoop-Labs/zwoop/internal/session"
)

var version = "dev"

func run(ctx context.Context, cfg *config.Config) error {
	if cfg.Environment == "production" && cfg.AllowedOrigin == "" {
		return fmt.Errorf("ENVIRONMENT=production requires ALLOWED_ORIGIN to be set")
	}

	store := session.NewStore()
	defer store.Close()

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           server.New(store, cfg, version),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	serveErr := make(chan error, 1)
	go func() {
		slog.Info("server listening", "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			serveErr <- err
		}
	}()

	select {
	case err := <-serveErr:
		return err
	case <-ctx.Done():
	}

	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func main() {
	textHandler := slog.NewTextHandler(os.Stdout, nil)
	slog.SetDefault(slog.New(textHandler))

	cfg := config.Load()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, cfg); err != nil {
		slog.Error("server error", "err", err)
		os.Exit(1)
	}
	slog.Info("shutdown complete")
}
