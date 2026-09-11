package config

import (
	"os"
	"strconv"
)

// DefaultSessionRateLimitMax is sessions/min per IP; override via
// SESSION_RATE_LIMIT_MAX (used by the e2e suite).
const DefaultSessionRateLimitMax = 5

type Config struct {
	Port                string
	TrustedProxy        bool   // TRUST_PROXY_HEADERS=true — trust X-Real-IP / X-Forwarded-For
	AllowedOrigin       string // ALLOWED_ORIGIN — WebSocket origin allowlist (e.g. https://zwoop.example.com)
	Environment         string // ENVIRONMENT — e.g. production, development
	SessionRateLimitMax int    // SESSION_RATE_LIMIT_MAX — sessions/min per IP
	TurnURL             string // TURN_URL — e.g. turn:turn.example.com:3478
	TurnUsername        string // TURN_USERNAME
	TurnCredential      string // TURN_CREDENTIAL
}

func Load() *Config {
	return &Config{
		Port:                getEnv("PORT", "8080"),
		TrustedProxy:        os.Getenv("TRUST_PROXY_HEADERS") == "true",
		AllowedOrigin:       os.Getenv("ALLOWED_ORIGIN"),
		Environment:         getEnv("ENVIRONMENT", "development"),
		SessionRateLimitMax: getEnvInt("SESSION_RATE_LIMIT_MAX", DefaultSessionRateLimitMax),
		TurnURL:             os.Getenv("TURN_URL"),
		TurnUsername:        os.Getenv("TURN_USERNAME"),
		TurnCredential:      os.Getenv("TURN_CREDENTIAL"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	v, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return v
}
