package config

import "os"

type Config struct {
	Port          string
	TrustedProxy  bool   // TRUST_PROXY_HEADERS=true — trust X-Real-IP / X-Forwarded-For
	AllowedOrigin string // ALLOWED_ORIGIN — WebSocket origin allowlist (e.g. https://zwoop.example.com)
	SentryDSN     string // SENTRY_DSN — empty disables error reporting
	Environment   string // ENVIRONMENT — e.g. production, development
}

func Load() *Config {
	return &Config{
		Port:          getEnv("PORT", "8080"),
		TrustedProxy:  os.Getenv("TRUST_PROXY_HEADERS") == "true",
		AllowedOrigin: os.Getenv("ALLOWED_ORIGIN"),
		SentryDSN:     os.Getenv("SENTRY_DSN"),
		Environment:   getEnv("ENVIRONMENT", "development"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
