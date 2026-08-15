// Command serve is the static file server baked into the Veilio CE image.
//
// Why this exists: the site is 1.1 MB and nginx:1.27-alpine-slim is 20.6 MB
// before a single file is copied in, so the distro was ~95% of the image. A
// static binary on `scratch` removes the distro entirely.
//
// It reproduces exactly the four behaviours docker/nginx.conf specified, and
// nothing else, because nothing else was in use:
//
//  1. SPA fallback returning 200 — not 404. Client-side routing means /pricing
//     must serve index.html, and a 404 status would be wrong for a page that
//     exists. This is the one thing the cheaper options (busybox httpd's
//     E404 directive) get wrong, and the README documents it as the single
//     hard requirement for self-hosting.
//  2. Fingerprinted assets get `public, immutable` for a year.
//  3. index.html is never cached, so a deploy is picked up immediately.
//  4. gzip, served from sidecars the image builds ahead of time rather than
//     compressing per request.
//
// Only the standard library is used. A privacy tool arguing about supply chain
// should not pull a third-party server in to save a few megabytes.
//
// docker/nginx.conf stays in the repo: the README points self-hosters at it as
// a working reference for serving the release tarball behind their own nginx.
package main

import (
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Vite fingerprints these, so a given URL's bytes never change.
var immutableExt = map[string]bool{
	".js": true, ".css": true, ".woff": true, ".woff2": true, ".ttf": true,
	".ico": true, ".svg": true, ".png": true, ".jpg": true, ".jpeg": true,
	".webp": true, ".avif": true, ".map": true,
}

// scratch has no /etc/mime.types and Go's built-in table misses some webfonts,
// so the types actually shipped are declared here rather than guessed at.
var mimeByExt = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".svg":   "image/svg+xml",
	".ico":   "image/x-icon",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".webp":  "image/webp",
	".avif":  "image/avif",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".ttf":   "font/ttf",
	".txt":   "text/plain; charset=utf-8",
	".map":   "application/json; charset=utf-8",
}

func main() {
	addr := flag.String("addr", ":80", "listen address")
	root := flag.String("root", "/site", "directory to serve")
	probe := flag.Bool("healthcheck", false, "probe a running server and exit")
	flag.Parse()

	// The image has no shell, so HEALTHCHECK has to call back into this binary.
	if *probe {
		os.Exit(healthcheck(*addr))
	}

	if _, err := os.Stat(filepath.Join(*root, "index.html")); err != nil {
		log.Fatalf("serve: no index.html under %s: %v", *root, err)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           &siteHandler{root: *root},
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("serve: listening on %s, root %s", *addr, *root)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}

type siteHandler struct{ root string }

func (h *siteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		// Set before the early return: a response that skips the policy is a
		// response an audit will find, and "it was only a 405" is not an answer.
		setSecurityHeaders(w)
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// path.Clean on a rooted path collapses ".." before it can escape, so the
	// join below cannot address anything outside root.
	upath := path.Clean("/" + r.URL.Path)

	name, ok := h.resolve(upath)
	if !ok {
		// try_files' last term: hand unknown paths to the SPA with a 200.
		name = filepath.Join(h.root, "index.html")
	}
	h.write(w, r, name)
}

// resolve reports the file backing upath, mirroring `try_files $uri $uri/`.
func (h *siteHandler) resolve(upath string) (string, bool) {
	name := filepath.Join(h.root, filepath.FromSlash(upath))
	fi, err := os.Stat(name)
	if err != nil {
		return "", false
	}
	if fi.IsDir() {
		idx := filepath.Join(name, "index.html")
		if _, err := os.Stat(idx); err != nil {
			return "", false
		}
		return idx, true
	}
	return name, true
}

func (h *siteHandler) write(w http.ResponseWriter, r *http.Request, name string) {
	ext := strings.ToLower(filepath.Ext(name))

	if ct := mimeByExt[ext]; ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if immutableExt[ext] {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		// index.html and anything else unfingerprinted: a stale shell would
		// keep pointing at asset names that no longer exist after a deploy.
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	setSecurityHeaders(w)

	// Prefer the sidecar the build produced. Vary matters even when we don't
	// use it, so a shared cache never serves gzip to a client that can't read it.
	w.Header().Add("Vary", "Accept-Encoding")
	f, fi, err := openBest(name, r.Header.Get("Accept-Encoding"), w.Header())
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	// Content-Type is already set, and ServeContent must not re-sniff a gzip
	// stream, so the name passed in is deliberately extension-free.
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// csp is the whole point of the exercise: the app's claim is that nothing you
// paste leaves your machine, and until now that was a property of the code
// rather than something the browser enforced. `default-src 'self'` with
// `connect-src 'self'` turns "we do not exfiltrate your source" into "we
// cannot".
//
// It can be this strict only because the web fonts are vendored (ROADMAP A4).
// While they came from Google, style-src and font-src had to name a third-party
// origin, and an origin allowed to serve CSS is an origin trusted rather far.
//
// 'unsafe-inline' in style-src is required by CodeMirror, which injects its
// theme into a <style> element at runtime. It is confined to styles: script-src
// stays strict, which is the directive that matters for exfiltration.
const csp = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; " +
	"font-src 'self'; " +
	"connect-src 'self'; " +
	"object-src 'none'; " +
	"base-uri 'none'; " +
	"form-action 'none'; " +
	"frame-ancestors 'none'"

func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", csp)
	// No referrer at all: the URL alone can carry which legal document — or, in
	// Cloud, which workspace — someone was reading.
	w.Header().Set("Referrer-Policy", "no-referrer")
	// frame-ancestors above covers modern browsers; this covers the rest.
	w.Header().Set("X-Frame-Options", "DENY")
	// The app asks for none of these, so denying them costs nothing and means a
	// future dependency cannot quietly start asking.
	w.Header().Set("Permissions-Policy",
		"geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()")
}

// openBest returns the .gz sidecar when the client accepts gzip and one exists,
// falling back to the plain file. It sets Content-Encoding as a side effect.
func openBest(name, accept string, hdr http.Header) (io.ReadSeekCloser, os.FileInfo, error) {
	if acceptsGzip(accept) {
		if f, err := os.Open(name + ".gz"); err == nil {
			if fi, err := f.Stat(); err == nil {
				hdr.Set("Content-Encoding", "gzip")
				return f, fi, nil
			}
			f.Close()
		}
	}
	f, err := os.Open(name)
	if err != nil {
		return nil, nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, fi, nil
}

// acceptsGzip is deliberately strict about `gzip;q=0`, which means "do not".
func acceptsGzip(accept string) bool {
	for _, part := range strings.Split(accept, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(fields[0]), "gzip") {
			for _, p := range fields[1:] {
				if strings.EqualFold(strings.ReplaceAll(strings.TrimSpace(p), " ", ""), "q=0") {
					return false
				}
			}
			return true
		}
	}
	return false
}

func healthcheck(addr string) int {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		log.Printf("healthcheck: bad addr %q: %v", addr, err)
		return 1
	}
	if host == "" {
		host = "127.0.0.1"
	}
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + net.JoinHostPort(host, port) + "/")
	if err != nil {
		log.Printf("healthcheck: %v", err)
		return 1
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		log.Printf("healthcheck: status %d", resp.StatusCode)
		return 1
	}
	return 0
}
