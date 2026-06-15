package session

import (
	"testing"
)

func TestCreate(t *testing.T) {
	s := NewStore()
	code, err := s.Create()
	if err != nil {
		t.Fatalf("Create() error: %v", err)
	}
	if len(code) != 8 {
		t.Fatalf("expected 8-char code, got %q (len %d)", code, len(code))
	}
	for _, c := range code {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
			t.Fatalf("code contains character outside [a-z0-9]: %q", code)
		}
	}
}

func TestCreateUnique(t *testing.T) {
	s := NewStore()
	seen := make(map[string]bool)
	for range 100 {
		code, err := s.Create()
		if err != nil {
			t.Fatalf("Create() error: %v", err)
		}
		if seen[code] {
			t.Fatalf("duplicate code generated: %q", code)
		}
		seen[code] = true
	}
}

func TestJoinUnknownCode(t *testing.T) {
	s := NewStore()
	_, _, ok := s.Join("00000000", "receiver")
	if ok {
		t.Fatal("Join() on unknown code should return ok=false")
	}
}

func TestJoinBothRoles(t *testing.T) {
	s := NewStore()
	code, _ := s.Create()

	_, rCh, ok := s.Join(code, "receiver")
	if !ok {
		t.Fatal("Join() as receiver failed")
	}
	if rCh == nil {
		t.Fatal("receiver channel is nil")
	}

	_, sCh, ok := s.Join(code, "sender")
	if !ok {
		t.Fatal("Join() as sender failed")
	}
	if sCh == nil {
		t.Fatal("sender channel is nil")
	}
}

func TestJoinDuplicateRoleRejected(t *testing.T) {
	s := NewStore()
	code, _ := s.Create()

	s.Join(code, "receiver")
	_, _, ok := s.Join(code, "receiver")
	if ok {
		t.Fatal("second Join() with the same role should return ok=false")
	}
}

func TestPaired(t *testing.T) {
	s := NewStore()
	code, _ := s.Create()

	sess, _, _ := s.Join(code, "receiver")
	if sess.Paired() {
		t.Fatal("Paired() should be false with only one peer")
	}

	sess, _, _ = s.Join(code, "sender")
	if !sess.Paired() {
		t.Fatal("Paired() should be true after both peers join")
	}
}

func TestOther(t *testing.T) {
	s := NewStore()
	code, _ := s.Create()

	_, rCh, _ := s.Join(code, "receiver")
	sess, sCh, _ := s.Join(code, "sender")

	if got := sess.Other("sender"); got != rCh {
		t.Fatal("Other(sender) should return the receiver's channel")
	}
	if got := sess.Other("receiver"); got != sCh {
		t.Fatal("Other(receiver) should return the sender's channel")
	}
}

func TestOtherBeforePaired(t *testing.T) {
	s := NewStore()
	code, _ := s.Create()
	sess, _, _ := s.Join(code, "receiver")
	if ch := sess.Other("receiver"); ch != nil {
		t.Fatal("Other() should return nil before the other peer joins")
	}
}

func TestOtherIfPaired(t *testing.T) {
	s := NewStore()
	code, _ := s.Create()

	sess, rCh, _ := s.Join(code, "receiver")

	// Only one peer — OtherIfPaired should return nil.
	if ch := sess.OtherIfPaired("receiver"); ch != nil {
		t.Fatal("OtherIfPaired should return nil when only one peer is connected")
	}

	_, sCh, _ := s.Join(code, "sender")

	// Both peers connected — each side should see the other's channel.
	if got := sess.OtherIfPaired("receiver"); got != sCh {
		t.Fatal("OtherIfPaired(receiver) should return the sender's channel")
	}
	if got := sess.OtherIfPaired("sender"); got != rCh {
		t.Fatal("OtherIfPaired(sender) should return the receiver's channel")
	}
	if got := sess.OtherIfPaired("unknown"); got != nil {
		t.Fatal("OtherIfPaired(unknown) should return nil")
	}
}

func TestClearAndGetOther(t *testing.T) {
	s := NewStore()
	code, _ := s.Create()

	s.Join(code, "receiver")
	_, sCh, _ := s.Join(code, "sender")

	// Clearing receiver should return the sender's channel.
	other := s.ClearAndGetOther(code, "receiver")
	if other != sCh {
		t.Fatal("ClearAndGetOther(receiver) should return the sender's channel")
	}

	// Receiver slot is now free — a new receiver can join.
	_, _, ok := s.Join(code, "receiver")
	if !ok {
		t.Fatal("Join() as receiver should succeed after ClearAndGetOther")
	}
}

func TestClearAndGetOtherUnknownCode(t *testing.T) {
	s := NewStore()
	if ch := s.ClearAndGetOther("00000000", "receiver"); ch != nil {
		t.Fatal("ClearAndGetOther() on unknown code should return nil")
	}
}

func TestClearAndGetOtherSenderRole(t *testing.T) {
	s := NewStore()
	code, _ := s.Create()

	_, rCh, _ := s.Join(code, "receiver")
	s.Join(code, "sender")

	// Clearing sender should return the receiver's channel.
	other := s.ClearAndGetOther(code, "sender")
	if other != rCh {
		t.Fatal("ClearAndGetOther(sender) should return the receiver's channel")
	}

	// Sender slot is now free — a new sender can join.
	_, _, ok := s.Join(code, "sender")
	if !ok {
		t.Fatal("Join() as sender should succeed after ClearAndGetOther")
	}
}

func TestClose(t *testing.T) {
	s := NewStore()
	// Populate a session so the reaper has something to inspect on its next tick.
	s.Create()
	// Close must not block or panic; it signals the reaper goroutine to exit.
	s.Close()
}

func TestDelete(t *testing.T) {
	s := NewStore()
	code, _ := s.Create()
	s.Delete(code)
	_, _, ok := s.Join(code, "receiver")
	if ok {
		t.Fatal("Join() should fail after Delete()")
	}
}
