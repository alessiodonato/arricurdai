package chi

// Acceptance test of the experiment, copied into the clone only after the sessions: the agent never sees it.

import (
	"net/http"
	"reflect"
	"testing"
)

func TestArricurdaiAcceptanceListRoutes(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	r := NewRouter()
	r.Get("/b", h)
	r.Post("/a", h)
	r.Route("/api", func(r Router) {
		r.Get("/users/{id}", h)
	})

	got := ListRoutes(r)
	want := []string{"GET /api/users/{id}", "GET /b", "POST /a"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ListRoutes() = %q, want %q", got, want)
	}
}
