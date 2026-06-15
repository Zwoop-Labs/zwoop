BINARY_NAME := "zwoop"
BINARY_PATH := "./" + BINARY_NAME
CMD_PATH := "./cmd/" + BINARY_NAME
VERSION := `git describe --tags --always --dirty 2>/dev/null || echo "dev"`
BUILD_FLAGS := "-ldflags \"-X main.version=" + VERSION + "\""

build-web:
    @echo "Building frontend..."
    @cd web && npm install && npm run build
    @echo "Frontend built"

build:
    @echo "Building {{BINARY_NAME}}..."
    @go build {{BUILD_FLAGS}} -o {{BINARY_PATH}} {{CMD_PATH}}
    @echo "Build complete: {{BINARY_PATH}}"

build-all: build-web build

run: build-all
    @echo "Running {{BINARY_NAME}}..."
    @{{BINARY_PATH}}

# Start backend (Go) and frontend (Vite) together — Ctrl-C stops both
dev: build-web build
    #!/usr/bin/env bash
    set -euo pipefail
    {{BINARY_PATH}} &
    BACKEND_PID=$!
    trap "kill $BACKEND_PID 2>/dev/null" EXIT
    cd web && npm run dev

e2e: build-all
    #!/usr/bin/env bash
    set -euo pipefail
    pkill -f "{{BINARY_PATH}}" 2>/dev/null || true
    {{BINARY_PATH}} &
    SERVER_PID=$!
    trap "kill $SERVER_PID 2>/dev/null" EXIT
    until curl -sf http://localhost:8080/api/ice-servers >/dev/null; do sleep 0.2; done
    cd e2e && npm install --silent && node test.mjs

test:
    @echo "Running tests..."
    @go test ./...

test-cover:
    @go test ./... -coverprofile=coverage.out
    @go tool cover -html=coverage.out -o coverage.html
    @go tool cover -func=coverage.out | tail -1
    @echo "Report: coverage.html"

test-verbose:
    @go test -v ./...

fmt:
    @go fmt ./...

lint:
    @golangci-lint run ./... 2>/dev/null || echo "golangci-lint not installed. Install with: brew install golangci-lint"

clean:
    @rm -f {{BINARY_PATH}}
    @rm -f coverage.out coverage.html
    @go clean

version:
    @echo "Current: $(svu current)"
    @echo "Next:    $(svu next)"

tag:
    #!/usr/bin/env bash
    set -euo pipefail
    NEXT=$(svu next)
    CURRENT=$(svu current)
    if [ "$NEXT" = "$CURRENT" ]; then
        echo "No commits requiring a version bump since $CURRENT"
        exit 0
    fi
    git tag "$NEXT"
    echo "Tagged $NEXT"

release:
    #!/usr/bin/env bash
    set -euo pipefail
    NEXT=$(svu next)
    CURRENT=$(svu current)
    if [ "$NEXT" = "$CURRENT" ]; then
        echo "No commits requiring a version bump since $CURRENT"
        exit 0
    fi
    git tag "$NEXT"
    git push origin "$NEXT"
    echo "Released $NEXT"
