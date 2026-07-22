import { randomUUID } from "node:crypto";

export const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const RPC_VERSION = 1;

export interface RpcReply {
	version: number;
	requestId: string;
	method?: string;
	success: boolean;
	data?: { text?: string; details?: Record<string, unknown> };
	error?: { code?: string; message?: string };
}

export interface RpcEventBus {
	on(event: string, handler: (payload: unknown) => void): () => void;
	emit(event: string, payload: unknown): void;
}

export class ShipyardRpcClient {
	readonly #events: RpcEventBus;
	readonly #timeoutMs: number;
	readonly #pending = new Map<string, (reason: string) => void>();
	#disposed = false;

	constructor(events: RpcEventBus, timeoutMs = 15_000) {
		this.#events = events;
		this.#timeoutMs = timeoutMs;
	}

	async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<RpcReply> {
		if (this.#disposed) throw new Error("Shipyard RPC client is disposed.");
		if (signal?.aborted) throw new Error(`Shipyard ${method} request cancelled before launch.`);
		const requestId = randomUUID();
		const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
		return new Promise<RpcReply>((resolve, reject) => {
			let settled = false;
			let unsubscribe = () => undefined;
			let timer: ReturnType<typeof setTimeout>;
			const cleanup = () => {
				clearTimeout(timer);
				unsubscribe();
				signal?.removeEventListener("abort", onAbort);
				this.#pending.delete(requestId);
			};
			const cancel = (reason: string) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new Error(reason));
			};
			const onAbort = () => cancel(`Shipyard ${method} request cancelled.`);
			timer = setTimeout(
				() => cancel("Timed out waiting for pi-subagents RPC. Confirm pi-subagents is installed and run /subagents-doctor."),
				this.#timeoutMs,
			);
			unsubscribe = this.#events.on(replyEvent, (payload) => {
				if (settled || !payload || typeof payload !== "object") return;
				const reply = payload as Partial<RpcReply>;
				if (
					reply.version !== RPC_VERSION
					|| reply.requestId !== requestId
					|| (reply.method !== undefined && reply.method !== method)
					|| typeof reply.success !== "boolean"
				) return;
				settled = true;
				cleanup();
				resolve(reply as RpcReply);
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#pending.set(requestId, cancel);
			if (signal?.aborted) {
				onAbort();
				return;
			}
			this.#events.emit(RPC_REQUEST_EVENT, {
				version: RPC_VERSION,
				requestId,
				method,
				params,
				source: { extension: "@danish/pi-shipyard" },
			});
		});
	}

	dispose(reason = "Shipyard RPC request cancelled because the Pi session shut down or reloaded."): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const cancel of [...this.#pending.values()]) cancel(reason);
		this.#pending.clear();
	}

	get pendingCount(): number {
		return this.#pending.size;
	}
}
