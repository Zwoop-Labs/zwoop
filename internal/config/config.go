package config

import "os"

type Config struct {
	Port          string
	TrustedProxy  bool   // TRUST_PROXY_HEADERS=true — trust X-Real-IP / X-Forwarded-For
	AllowedOrigin string // ALLOWED_ORIGIN — WebSocket origin allowlist (e.g. https://zwoop.example.com)
	Environment   string // ENVIRONMENT — e.g. production, development
}

func Load() *Config {
	return &Config{
		Port:          getEnv("PORT", "8080"),
		TrustedProxy:  os.Getenv("TRUST_PROXY_HEADERS") == "true",
		AllowedOrigin: os.Getenv("ALLOWED_ORIGIN"),
		Environment:   getEnv("ENVIRONMENT", "development"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
