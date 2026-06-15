package main

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/Zwoop-Labs/zwoop/internal/config"
)

func TestRunGracefulShutdown(t *testing.T) {
	cfg := &config.Config{Port: "18080"}

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() {
		done <- run(ctx, cfg)
	}()

	// Wait until the server is up.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get("http://localhost:18080/healthz")
		if err == nil {
			resp.Body.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run() returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run() did not return after context cancellation")
	}
}

func TestRunBadPort(t *testing.T) {
	cfg := &config.Config{Port: "99999"} // out-of-range port — bind will fail on all platforms

	ctx := context.Background()
	err := run(ctx, cfg)
	if err == nil {
		t.Fatal("expected error binding to port 1, got nil")
	}
}
