import type { Response } from "express";
import { nanoid } from "nanoid";
import type { CodexEvent } from "./codex/types";

type Client = {
  id: string;
  response: Response;
};

const clients = new Map<string, Client>();

export function addEventClient(response: Response) {
  const id = nanoid();
  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no"
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ id })}\n\n`);

  clients.set(id, { id, response });
  response.on("close", () => {
    clients.delete(id);
  });
}

export function emitCodexEvent(event: CodexEvent) {
  const payload = `event: codex\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients.values()) {
    client.response.write(payload);
  }
}

export function emitWorkspaceEvent(event: { type: "agents-updated"; root: string; content: string; exists: boolean }) {
  const payload = `event: workspace\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients.values()) {
    client.response.write(payload);
  }
}
