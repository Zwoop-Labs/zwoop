export interface SignalMessage {
  type: string;
  payload?: unknown;
}

export type MessageHandler = (msg: SignalMessage) => void;

export class SignalingClient {
  private ws: WebSocket;
  private handlers: MessageHandler[] = [];
  private _open: Promise<void>;

  constructor(code: string, role: "sender" | "receiver") {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws/${code}?role=${role}`);

    this._open = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("WebSocket error")));
    });

    this.ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as SignalMessage;
        this.handlers.forEach((h) => h(msg));
      } catch {
        // ignore malformed frames
      }
    });
  }

  ready(): Promise<void> {
    return this._open;
  }

  on(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  send(msg: SignalMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }

  onClose(handler: () => void): void {
    this.ws.addEventListener("close", handler);
  }
}
