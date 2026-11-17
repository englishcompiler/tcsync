import { describe, it, expect } from "vitest";
import { matchesHost, rewriteToDirect } from "../src/route";

describe("matchesHost", () => {
  it("matches the tunnel host regardless of port and path", () => {
    expect(matchesHost("http://couch.tailcat:5984/db/_changes", "couch.tailcat")).toBe(true);
  });
  it("does not match other hosts", () => {
    expect(matchesHost("https://example.com/db", "couch.tailcat")).toBe(false);
  });
  it("is case-insensitive on the host", () => {
    expect(matchesHost("http://COUCH.Tailcat:5984/", "couch.tailcat")).toBe(true);
  });
  it("returns false for an invalid URL without throwing", () => {
    expect(matchesHost("not a url", "couch.tailcat")).toBe(false);
  });
});

describe("rewriteToDirect", () => {
  it("keeps path and query and swaps origin", () => {
    expect(rewriteToDirect("http://couch.tailcat:5984/db/x?a=1", "http://127.0.0.1:5984")).toBe("http://127.0.0.1:5984/db/x?a=1");
  });
  it("tolerates a trailing slash on the direct URL", () => {
    expect(rewriteToDirect("http://couch.tailcat:5984/", "http://127.0.0.1:5984/")).toBe("http://127.0.0.1:5984/");
  });
});
