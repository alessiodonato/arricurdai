package middleware

// Acceptance test of the experiment, copied into the clone only after the sessions: the agent never sees it.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestArricurdaiAcceptanceMethodAllowList(t *testing.T) {
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	h := MethodAllowList("GET", "POST")(next)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", nil))
	if !called || rec.Code != http.StatusOK {
		t.Fatalf("POST should reach the handler: called=%v code=%d", called, rec.Code)
	}

	called = false
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/", nil))
	allow := rec.Header().Get("Allow")
	if called || rec.Code != http.StatusMethodNotAllowed || !strings.Contains(allow, "GET") || !strings.Contains(allow, "POST") {
		t.Fatalf("DELETE should get 405 with Allow: called=%v code=%d allow=%q", called, rec.Code, allow)
	}

	called = false
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodOptions, "/", nil))
	if called || rec.Code != http.StatusNoContent || rec.Header().Get("Allow") == "" {
		t.Fatalf("OPTIONS should get 204 with Allow: called=%v code=%d allow=%q", called, rec.Code, rec.Header().Get("Allow"))
	}
}
