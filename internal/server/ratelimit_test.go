package server

import (
	"strconv"
	"testing"
	"time"
)

// BenchmarkAllowNoSweep measures steady-state allow() cost with no sweep due.
func BenchmarkAllowNoSweep(b *testing.B) {
	fc := &fakeClock{t: time.Now()}
	l := &ipLimiter{windows: make(map[string][]time.Time), clock: fc, max: sessionRateLimitMax, window: rateLimitWindow, lastSweep: fc.t}
	for i := 0; b.Loop(); i++ {
		l.allow("1.2.3.4")
		fc.advance(time.Millisecond)
	}
}

// BenchmarkAllowWithSweep measures the cost of the one allow() call that
// triggers a full-map sweep, at varying map sizes full of stale entries.
func BenchmarkAllowWithSweep(b *testing.B) {
	for _, n := range []int{1_000, 10_000, 99_999} {
		b.Run(strconv.Itoa(n), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				b.StopTimer()
				fc := &fakeClock{t: time.Now()}
				l := &ipLimiter{windows: make(map[string][]time.Time), clock: fc, max: sessionRateLimitMax, window: rateLimitWindow}
				for j := 0; j < n; j++ {
					l.windows["ip-"+strconv.Itoa(j)] = []time.Time{fc.t}
				}
				// Age every entry past the window and past sweepInterval so the
				// sweep both triggers and has everything to evict.
				fc.advance(sweepInterval + time.Second)
				b.StartTimer()

				l.allow("trigger")
			}
		})
	}
}

// BenchmarkAllowConcurrentDuringSweep measures how long other goroutines'
// allow() calls stall behind the mutex while one triggers a 100k-entry sweep.
func BenchmarkAllowConcurrentDuringSweep(b *testing.B) {
	fc := &fakeClock{t: time.Now()}
	l := &ipLimiter{windows: make(map[string][]time.Time), clock: fc, max: sessionRateLimitMax, window: rateLimitWindow}
	for j := 0; j < 100_000; j++ {
		l.windows["ip-"+strconv.Itoa(j)] = []time.Time{fc.t}
	}
	fc.advance(sweepInterval + time.Second)

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			l.allow("concurrent")
		}
	})
}
