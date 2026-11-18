//go:build js && wasm

// Hub mode: the bridge as the tunnel's listening end.
//
//	tcsyncServe({keyJSON, allowed: ["nodekey:…"], onRequest}) -> Promise<{addr, keyJSON}>
//	  onRequest({method, url, headers, body, peer}) -> Promise<{status, headers, body}>
//	tcsyncServeAllow("nodekey:…") -> Promise<void>   admit one more device now
//	tcsyncServeClose() -> Promise<void>              stop listening (serve again to restart)
//
// keyJSON is the server identity (tailcat.PrivateKey JSON with its pre-shared key and pinned DERP
// region); pass it back to keep the same address. Removing a device = close, then serve again
// without its key: tailcat has no way to un-allow a key at runtime.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

const hubPort = 5984

var (
	serveMu sync.Mutex
	hubSrv  *tailcat.Server
	hubLn   net.Listener
	hubHTTP *http.Server
)

func registerServe(g js.Value) {
	g.Set("tcsyncServe", js.FuncOf(serve))
	g.Set("tcsyncServeAllow", js.FuncOf(serveAllow))
	// Both return Promises: tailcat takes locks and talks to the network, and blocking inside a
	// js.FuncOf callback deadlocks Go's js/wasm runtime.
	g.Set("tcsyncServeClose", js.FuncOf(func(js.Value, []js.Value) any {
		return promise(func() (any, error) { closeServe(); return js.Undefined(), nil })
	}))
}

// allowedKeys parses the allowlist. tailcat admits EVERY client while its list is empty, so an
// empty list gets one random key that no device holds.
func allowedKeys(v js.Value) ([]key.NodePublic, error) {
	var out []key.NodePublic
	if v.Type() == js.TypeObject {
		for i := 0; i < v.Length(); i++ {
			var k key.NodePublic
			if err := k.UnmarshalText([]byte(v.Index(i).String())); err != nil {
				return nil, fmt.Errorf("invalid device key %q: %w", v.Index(i).String(), err)
			}
			out = append(out, k)
		}
	}
	if len(out) == 0 {
		out = append(out, key.NewNode().Public())
	}
	return out, nil
}

func serve(_ js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejected(errors.New("tcsyncServe requires an options object"))
	}
	o := args[0]
	onRequest := o.Get("onRequest")
	keyJSON := str(o, "keyJSON")
	allowed, err := allowedKeys(o.Get("allowed"))
	if err != nil {
		return rejected(err)
	}
	return promise(func() (any, error) {
		if onRequest.Type() != js.TypeFunction {
			return nil, errors.New("onRequest is required")
		}
		closeServe()
		pk := &tailcat.PrivateKey{}
		if keyJSON != "" {
			if err := json.Unmarshal([]byte(keyJSON), pk); err != nil {
				return nil, fmt.Errorf("invalid hub key: %w", err)
			}
		} else {
			pk = tailcat.NewPrivateKey()
			pk.Public.RegionID = -1 // pick the nearest relay below, then pin it
		}
		if pk.Public.PresharedKey.IsZero() {
			pk.Public.PresharedKey = tailcat.NewPresharedKey()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ci := pk.Public
		if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(tailcat.DefaultDERPMapURL)); err != nil {
			return nil, fmt.Errorf("could not reach the relay network: %w", err)
		}
		reg := ci.Region[0]
		pk.Public.RegionID = reg.RegionID
		out, err := json.Marshal(pk)
		if err != nil {
			return nil, err
		}
		srv := &tailcat.Server{Key: pk.Private, PresharedKey: pk.Public.PresharedKey, Logf: logger.Discard,
			Region: reg, AllowedClients: allowed}
		ln, err := srv.Listen(ctx, "tcp", fmt.Sprintf(":%d", hubPort))
		if err != nil {
			srv.Close()
			return nil, fmt.Errorf("listen: %w", err)
		}
		hs := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			handleHub(onRequest, peerKey(srv, ln, r.RemoteAddr), w, r)
		})}
		serveMu.Lock()
		hubSrv, hubLn, hubHTTP = srv, ln, hs
		serveMu.Unlock()
		go hs.Serve(ln)
		return map[string]any{"addr": string(pk.Public.Addr()), "keyJSON": string(out)}, nil
	})
}

func serveAllow(_ js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		return rejected(errors.New("tcsyncServeAllow(nodekey: string)"))
	}
	var k key.NodePublic
	if err := k.UnmarshalText([]byte(args[0].String())); err != nil {
		return rejected(fmt.Errorf("invalid device key: %w", err))
	}
	return promise(func() (any, error) {
		serveMu.Lock()
		s := hubSrv
		serveMu.Unlock()
		if s == nil {
			return nil, errors.New("hub is not serving")
		}
		s.AddAllowedClient(k)
		return js.Undefined(), nil
	})
}

func closeServe() {
	serveMu.Lock()
	s, ln, hs := hubSrv, hubLn, hubHTTP
	hubSrv, hubLn, hubHTTP = nil, nil, nil
	serveMu.Unlock()
	if hs != nil {
		hs.Close()
	}
	if ln != nil {
		ln.Close()
	}
	if s != nil {
		s.Close()
	}
}

// peerKey returns the "nodekey:…" of the device behind remote ("ip:port"), or "".
func peerKey(s *tailcat.Server, ln net.Listener, remote string) string {
	ap, err := netip.ParseAddrPort(remote)
	if err != nil {
		return ""
	}
	for _, kv := range s.PeerEnv(ln.Addr(), net.TCPAddrFromAddrPort(ap)) {
		if v, ok := strings.CutPrefix(kv, "TAILCAT_PEER_KEY="); ok {
			return v
		}
	}
	return ""
}

type hubResp struct {
	status int
	hdr    map[string]string
	body   []byte
	err    error
}

func handleHub(onRequest js.Value, peer string, w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	hdr := map[string]any{}
	for k := range r.Header {
		hdr[strings.ToLower(k)] = r.Header.Get(k)
	}
	u8 := js.Global().Get("Uint8Array").New(len(body))
	js.CopyBytesToJS(u8, body)
	req := map[string]any{"method": r.Method, "url": r.URL.RequestURI(), "headers": hdr, "body": u8, "peer": peer}

	ch := make(chan hubResp, 1)
	var ok, fail js.Func
	release := func() { ok.Release(); fail.Release() }
	ok = js.FuncOf(func(_ js.Value, a []js.Value) any {
		v := a[0]
		res := hubResp{status: v.Get("status").Int(), hdr: map[string]string{}}
		if h := v.Get("headers"); h.Type() == js.TypeObject {
			keys := js.Global().Get("Object").Call("keys", h)
			for i := 0; i < keys.Length(); i++ {
				k := keys.Index(i).String()
				res.hdr[k] = h.Get(k).String()
			}
		}
		if b := v.Get("body"); b.Type() == js.TypeObject && !b.IsNull() {
			res.body = make([]byte, b.Get("length").Int())
			js.CopyBytesToGo(res.body, b)
		}
		ch <- res
		release()
		return nil
	})
	fail = js.FuncOf(func(_ js.Value, a []js.Value) any {
		ch <- hubResp{err: errors.New(a[0].Call("toString").String())}
		release()
		return nil
	})
	onRequest.Invoke(req).Call("then", ok, fail)

	select {
	case res := <-ch:
		if res.err != nil {
			http.Error(w, res.err.Error(), http.StatusInternalServerError)
			return
		}
		for k, v := range res.hdr {
			w.Header().Set(k, v)
		}
		w.WriteHeader(res.status)
		w.Write(res.body)
	case <-r.Context().Done():
		// The device went away; the JS side finishes on its own and the callbacks release then.
	}
}
