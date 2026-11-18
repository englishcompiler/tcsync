import { toBridgeRequest } from "../fetchAdapter";
import type { HubRequest, HubResponse } from "./handler";

/** A fetch call from this computer's LiveSync, as a hub request (handled in-process, no network). */
export async function toHubRequest(req: RequestInfo | URL, init?: RequestInit): Promise<HubRequest> {
  const b = await toBridgeRequest(req, init);
  const u = new URL(b.url);
  return { method: b.method, url: u.pathname + u.search, headers: b.headers, body: b.body ?? new Uint8Array() };
}

export function fromHubResponse(r: HubResponse, method: string): Response {
  const noBody = method === "HEAD" || r.status === 204 || r.status === 304;
  return new Response(noBody ? null : (r.body as BodyInit), { status: r.status, headers: r.headers });
}
