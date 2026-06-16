FROM node:22-alpine AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS go-builder
WORKDIR /app
ARG VERSION=dev
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web-builder /app/web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags "-s -w -X main.version=${VERSION}" -o /zwoop ./cmd/zwoop

FROM alpine:3.21
RUN apk add --no-cache ca-certificates \
 && addgroup -S zwoop && adduser -S -G zwoop zwoop
COPY --from=go-builder /zwoop /zwoop
USER zwoop
EXPOSE 8080
ENTRYPOINT ["/zwoop"]
