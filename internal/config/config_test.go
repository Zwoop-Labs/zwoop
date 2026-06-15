package config

import (
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("PORT", "")

	cfg := Load()

	if cfg.Port != "8080" {
		t.Fatalf("expected default Port=8080, got %q", cfg.Port)
	}
}

func TestLoadPortOverride(t *testing.T) {
	t.Setenv("PORT", "9090")

	cfg := Load()

	if cfg.Port != "9090" {
		t.Fatalf("expected Port=9090, got %q", cfg.Port)
	}
}
