//go:build js && wasm

// Command tcsync-bridge is the WebAssembly half of the tcsync Obsidian plugin.
//
// It keeps one persistent tailcat client and runs Go's net/http over it, so
// the plugin can send ordinary HTTP requests (LiveSync's CouchDB traffic)
// through a WireGuard tunnel relayed by DERP over WebSockets.
//
// JavaScript API (installed on globalThis; onTcsyncReady() is called once ready):
//
//	tcsyncNewKey() -> {privateKey: "privkey:…", publicKey: "nodekey:…"}
//	tcsyncPublicKey(privateKey) -> "nodekey:…"
//	tcsyncInit({addr, privateKey, dialTimeoutMs?}) -> Promise<void>
//	tcsyncFetch({method, url, headers, body?}) -> Promise<{status, headers, body}>
//	tcsyncPing(timeoutMs, port) -> Promise<void>  (rejects if the server doesn't answer)
//	tcsyncClose()
//
// Hub mode (serve_js.go): tcsyncServe, tcsyncServeAllow, tcsyncServeClose.
//
// The URL host passed to tcsyncFetch is ignored; its port selects the TCP
// port on the tailcat server.
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

const defaultDialTimeout = 30 * time.Second

var (
	mu     sync.Mutex
	client *tailcat.Client
	hc     *http.Client
)

func main() {
	g := js.Global()
	g.Set("tcsyncNewKey", js.FuncOf(newKey))
	g.Set("tcsyncPublicKey", js.FuncOf(publicKey))
	g.Set("tcsyncInit", js.FuncOf(initTunnel))
	g.Set("tcsyncFetch", js.FuncOf(fetch))
	g.Set("tcsyncClose", js.FuncOf(closeTunnel))
	g.Set("tcsyncPing", js.FuncOf(ping))
	registerServe(g)
	if f := g.Get("onTcsyncReady"); f.Type() == js.TypeFunction {
		f.Invoke()
	}
	select {}
}

func newKey(js.Value, []js.Value) any {
	k := key.NewNode()
	priv, _ := k.MarshalText()
	return map[string]any{"privateKey": string(priv), "publicKey": k.Public().String()}
}

func parsePrivate(s string) (key.NodePrivate, error) {
	var k key.NodePrivate
	if err := k.UnmarshalText([]byte(s)); err != nil {
		return k, fmt.Errorf("invalid private key: %w", err)
	}
	return k, nil
}

func publicKey(_ js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		panic("tcsyncPublicKey(privateKey: string)")
	}
	k, err := parsePrivate(args[0].String())
	if err != nil {
		panic(err.Error())
	}
	return k.Public().String()
}

func initTunnel(_ js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejected(errors.New("tcsyncInit requires an options object"))
	}
	o := args[0]
	addr, priv := str(o, "addr"), str(o, "privateKey")
	timeout := defaultDialTimeout
	if v := o.Get("dialTimeoutMs"); v.Type() == js.TypeNumber && v.Int() > 0 {
		timeout = time.Duration(v.Int()) * time.Millisecond
	}
	return promise(func() (any, error) {
		if addr == "" {
			return nil, errors.New("server address is required")
		}
		k, err := parsePrivate(priv)
		if err != nil {
			return nil, err
		}
		c := &tailcat.Client{Server: tailcat.Addr(addr), Key: k, Logf: logger.Discard}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		if err := pingUntil(ctx, c); err != nil {
			c.Close()
			return nil, err
		}
		tr := &http.Transport{
			DialContext: func(ctx context.Context, _, hostport string) (net.Conn, error) {
				_, p, err := net.SplitHostPort(hostport)
				if err != nil {
					return nil, err
				}
				port, err := strconv.ParseUint(p, 10, 16)
				if err != nil {
					return nil, err
				}
				dctx, cancel := context.WithTimeout(ctx, defaultDialTimeout)
				defer cancel()
				return c.DialTCPPort(dctx, uint16(port))
			},
			MaxIdleConnsPerHost: 8,
			IdleConnTimeout:     90 * time.Second,
		}
		mu.Lock()
		old := client
		client, hc = c, &http.Client{Transport: tr}
		mu.Unlock()
		if old != nil {
			old.Close()
		}
		return js.Undefined(), nil
	})
}

// pingUntil retries the handshake until it succeeds or ctx expires; the
// first pings can be lost while either side's DERP connection comes up.
// It waits between attempts: under js/wasm a goroutine that never blocks
// starves the JavaScript event loop (and with it every timer).
func pingUntil(ctx context.Context, c *tailcat.Client) error {
	var lastErr error
	for {
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := c.Ping(pctx)
		cancel()
		if err == nil {
			return nil
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return fmt.Errorf("server unreachable: %w", lastErr)
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func fetch(_ js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejected(errors.New("tcsyncFetch requires a request object"))
	}
	o := args[0]
	method, url := str(o, "method"), str(o, "url")
	if method == "" {
		method = http.MethodGet
	}
	var body []byte
	if b := o.Get("body"); b.Type() == js.TypeObject && !b.IsNull() {
		body = make([]byte, b.Get("length").Int())
		js.CopyBytesToGo(body, b)
	}
	hdr := http.Header{}
	if h := o.Get("headers"); h.Type() == js.TypeObject {
		keys := js.Global().Get("Object").Call("keys", h)
		for i := 0; i < keys.Length(); i++ {
			k := keys.Index(i).String()
			hdr.Set(k, h.Get(k).String())
		}
	}
	return promise(func() (any, error) {
		mu.Lock()
		c := hc
		mu.Unlock()
		if c == nil {
			return nil, errors.New("tunnel not initialised")
		}
		var rd io.Reader
		if body != nil {
			rd = bytes.NewReader(body)
		}
		req, err := http.NewRequest(method, url, rd)
		if err != nil {
			return nil, err
		}
		req.Header = hdr
		resp, err := c.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, err
		}
		u8 := js.Global().Get("Uint8Array").New(len(b))
		js.CopyBytesToJS(u8, b)
		// Lower-case names only: a JS Headers object built from both "Content-Type"
		// and "content-type" would join the two values.
		rh := map[string]any{}
		for k := range resp.Header {
			rh[strings.ToLower(k)] = resp.Header.Get(k)
		}
		return map[string]any{"status": resp.StatusCode, "headers": rh, "body": u8}, nil
	})
}

// ping checks that the server still answers by opening (and closing) a TCP
// connection to `port` through the tunnel. tailcat's Client.Ping can't be used
// for this: after the first successful handshake it returns immediately.
func ping(_ js.Value, args []js.Value) any {
	timeout := 10 * time.Second
	if len(args) >= 1 && args[0].Type() == js.TypeNumber && args[0].Int() > 0 {
		timeout = time.Duration(args[0].Int()) * time.Millisecond
	}
	port := 5984
	if len(args) >= 2 && args[1].Type() == js.TypeNumber && args[1].Int() > 0 {
		port = args[1].Int()
	}
	return promise(func() (any, error) {
		mu.Lock()
		c := client
		mu.Unlock()
		if c == nil {
			return nil, errors.New("tunnel not initialised")
		}
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		conn, err := c.DialTCPPort(ctx, uint16(port))
		if err != nil {
			return nil, fmt.Errorf("server did not answer: %w", err)
		}
		conn.Close()
		return js.Undefined(), nil
	})
}

func closeTunnel(js.Value, []js.Value) any {
	mu.Lock()
	c := client
	client, hc = nil, nil
	mu.Unlock()
	if c != nil {
		c.Close()
	}
	return nil
}

func str(v js.Value, name string) string {
	if p := v.Get(name); p.Type() == js.TypeString {
		return p.String()
	}
	return ""
}

func rejected(err error) js.Value {
	return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New(err.Error()))
}

func promise(f func() (any, error)) js.Value {
	// The executor runs synchronously inside the Promise constructor, so it can
	// be released right away. Unreleased js.Funcs stay in Go's function table
	// forever, together with everything their closures captured (for fetch,
	// the whole request body).
	exec := js.FuncOf(func(_ js.Value, a []js.Value) any {
		resolve, reject := a[0], a[1]
		go func() {
			if r, err := f(); err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
			} else {
				resolve.Invoke(r)
			}
		}()
		return nil
	})
	defer exec.Release()
	return js.Global().Get("Promise").New(exec)
}
