package session

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"
)

// ErrStoreFull is returned by Create when the session cap is reached.
var ErrStoreFull = errors.New("session store full")

const (
	ttl         = 5 * time.Minute
	maxSessions = 10_000
	// codeChars excludes visually ambiguous characters (0/O, 1/l/I).
	codeChars = "abcdefghjkmnpqrstuvwxyz23456789"
	codeLen   = 8
)

type peer struct {
	ch chan []byte
}

type Session struct {
	mu       sync.RWMutex
	receiver *peer
	sender   *peer
	created  time.Time
}

type Store struct {
	mu       sync.Mutex
	sessions map[string]*Session
	quit     chan struct{}
}

func NewStore() *Store {
	s := &Store{
		sessions: make(map[string]*Session),
		quit:     make(chan struct{}),
	}
	go s.reap()
	return s
}

// Close stops the background reaper goroutine.
func (s *Store) Close() {
	close(s.quit)
}

func (s *Store) Create() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.sessions) >= maxSessions {
		return "", ErrStoreFull
	}

	base := big.NewInt(int64(len(codeChars)))
	for range 10 {
		buf := make([]byte, codeLen)
		for i := range buf {
			n, err := rand.Int(rand.Reader, base)
			if err != nil {
				return "", err
			}
			buf[i] = codeChars[n.Int64()]
		}
		code := string(buf)
		if _, exists := s.sessions[code]; !exists {
			s.sessions[code] = &Session{created: time.Now()}
			return code, nil
		}
	}
	return "", fmt.Errorf("failed to generate unique session code after 10 attempts")
}

// Join claims a role slot in an existing session. Returns the session and the
// channel on which this peer will receive inbound messages. Returns nil if the
// session doesn't exist or the role is already taken.
func (s *Store) Join(code, role string) (*Session, chan []byte, bool) {
	s.mu.Lock()
	sess, ok := s.sessions[code]
	s.mu.Unlock()
	if !ok {
		return nil, nil, false
	}

	ch := make(chan []byte, 64)
	p := &peer{ch: ch}

	sess.mu.Lock()
	defer sess.mu.Unlock()

	switch role {
	case "receiver":
		if sess.receiver != nil {
			return nil, nil, false
		}
		sess.receiver = p
	case "sender":
		if sess.sender != nil {
			return nil, nil, false
		}
		sess.sender = p
	default:
		return nil, nil, false
	}

	return sess, ch, true
}

// Paired reports whether both peers have connected.
func (sess *Session) Paired() bool {
	sess.mu.RLock()
	defer sess.mu.RUnlock()
	return sess.receiver != nil && sess.sender != nil
}

// Other returns the outbound channel of the peer that is not the given role.
func (sess *Session) Other(role string) chan []byte {
	sess.mu.RLock()
	defer sess.mu.RUnlock()
	if role == "receiver" && sess.sender != nil {
		return sess.sender.ch
	}
	if role == "sender" && sess.receiver != nil {
		return sess.receiver.ch
	}
	return nil
}

// OtherIfPaired returns the other peer's channel only if both peers are
// currently connected, under a single lock so Paired + Other is atomic.
func (sess *Session) OtherIfPaired(role string) chan []byte {
	sess.mu.RLock()
	defer sess.mu.RUnlock()
	if sess.receiver == nil || sess.sender == nil {
		return nil
	}
	if role == "receiver" {
		return sess.sender.ch
	}
	if role == "sender" {
		return sess.receiver.ch
	}
	return nil
}

// ClearAndGetOther removes the given role from the session (allowing
// reconnection) and returns the other peer's channel so the caller can send
// a peer-left notification. Safe to call concurrently.
func (s *Store) ClearAndGetOther(code, role string) chan []byte {
	s.mu.Lock()
	sess, ok := s.sessions[code]
	s.mu.Unlock()
	if !ok {
		return nil
	}

	sess.mu.Lock()
	defer sess.mu.Unlock()

	var other chan []byte
	switch role {
	case "receiver":
		sess.receiver = nil
		if sess.sender != nil {
			other = sess.sender.ch
		}
	case "sender":
		sess.sender = nil
		if sess.receiver != nil {
			other = sess.receiver.ch
		}
	}
	// Reset the creation time so the reaper evicts this half-empty session after
	// the TTL, even if it was previously paired (paired sessions are exempt from
	// the reaper's age check while both peers are connected).
	sess.created = time.Now()
	return other
}

func (s *Store) Delete(code string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, code)
}

func (s *Store) reap() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			s.mu.Lock()
			now := time.Now()
			for code, sess := range s.sessions {
				if !sess.Paired() && now.Sub(sess.created) > ttl {
					delete(s.sessions, code)
				}
			}
			s.mu.Unlock()
		case <-s.quit:
			return
		}
	}
}
