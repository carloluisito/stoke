// tests/integration/mock-upstream.ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockHandlerInput {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface MockHandlerOutput {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function startMockUpstream(
  handler: (req: MockHandlerInput) => MockHandlerOutput,
): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const out = handler({
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers,
          body,
        });
        res.writeHead(out.status, out.headers);
        res.end(out.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}
