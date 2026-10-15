import { randomBytes } from "node:crypto";
import type { FetchFn } from "./client.ts";

/** One request the fake received: method, path without the query, the query, and the body. */
export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

interface StoredTool {
  readonly id: string;
  toolConfig: Record<string, unknown>;
}

interface StoredAgent {
  readonly agentId: string;
  config: Record<string, unknown>;
}

export interface FakeWebhook {
  readonly webhookId: string;
  readonly name: string;
  readonly webhookUrl: string;
  isDisabled: boolean;
  retryEnabled: boolean;
}

export interface FakeOutboundCall {
  readonly body: Record<string, unknown>;
}

type Json = Record<string, unknown>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {};
}

/**
 * An in-memory stand-in for the parts of the ElevenLabs API Booker uses, served through a `fetch`
 * function so the real client runs against it: workspace secrets, webhook tools, workspace
 * webhooks, agents, the LLM list, phone numbers, outbound calls, and conversations. It keeps
 * state across requests, so a second sync sees what the first one created. Test support only;
 * nothing here reaches the network.
 */
export class FakeElevenLabs {
  readonly requests: FakeRequest[] = [];
  readonly secrets = new Map<string, { name: string; value: string }>();
  readonly tools = new Map<string, StoredTool>();
  readonly webhooks: FakeWebhook[] = [];
  readonly agents = new Map<string, StoredAgent>();
  readonly phoneNumbers = new Map<string, { phoneNumber: string; body: Json }>();
  readonly outboundCalls: FakeOutboundCall[] = [];
  /** Conversation status by id, for `GET /v1/convai/conversations/{id}`. */
  readonly conversations = new Map<string, string>();
  llms: string[] = ["gpt-6-sol", "gpt-6-astra"];
  /** The signing secret of the last webhook this fake created. */
  lastWebhookSecret: string | undefined;
  /** What the next outbound call answers; defaults to a success with fresh ids. */
  nextOutboundCall: ((body: Json) => { status: number; body: unknown }) | undefined;
  private counter = 0;

  readonly fetch: FetchFn = async (url, init) => {
    const parsed = new URL(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const request: FakeRequest = {
      method: init.method ?? "GET",
      path: parsed.pathname,
      query: parsed.searchParams,
      body,
    };
    this.requests.push(request);
    return this.handle(request);
  };

  /** Adds a workspace webhook as if the owner had created it in the dashboard. */
  addWebhook(name: string, webhookUrl: string): FakeWebhook {
    const webhook = {
      webhookId: this.nextId("wh"),
      name,
      webhookUrl,
      isDisabled: false,
      retryEnabled: false,
    };
    this.webhooks.push(webhook);
    return webhook;
  }

  /** Requests other than reads: what a sync changed. */
  writes(): FakeRequest[] {
    return this.requests.filter((request) => request.method !== "GET");
  }

  agentByName(name: string): Json | undefined {
    for (const agent of this.agents.values()) {
      if (agent.config["name"] === name) return agent.config;
    }
    return undefined;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${String(this.counter).padStart(4, "0")}`;
  }

  private handle(request: FakeRequest): Response {
    const { method, path } = request;
    const body = asObject(request.body);
    const segments = path.split("/").filter(Boolean);
    const id = segments.at(-1) ?? "";

    if (method === "GET" && path === "/v1/convai/llm/list") {
      return json(200, {
        llms: this.llms.map((llm) => ({ llm, is_checkpoint: false })),
        default_deprecation_config: {},
      });
    }

    if (path === "/v1/convai/secrets") {
      if (method === "GET") {
        const search = request.query.get("search") ?? "";
        const secrets = [...this.secrets.entries()]
          .filter(([, secret]) => secret.name.includes(search))
          .map(([secretId, secret]) => ({
            type: "stored",
            secret_id: secretId,
            name: secret.name,
            used_by: { tools: [], agents: [], others: [] },
          }));
        return json(200, { secrets, next_cursor: null });
      }
      const secretId = this.nextId("secret");
      this.secrets.set(secretId, { name: String(body["name"]), value: String(body["value"]) });
      return json(200, { type: "stored", secret_id: secretId, name: body["name"] });
    }
    if (path.startsWith("/v1/convai/secrets/") && method === "PATCH") {
      const secret = this.secrets.get(id);
      if (secret === undefined) return json(404, { detail: { status: "not_found" } });
      secret.value = String(body["value"]);
      return json(200, { type: "stored", secret_id: id, name: secret.name });
    }

    if (path === "/v1/convai/tools") {
      if (method === "GET") {
        const tools = [...this.tools.values()].map((tool) => ({
          id: tool.id,
          tool_config: tool.toolConfig,
          access_info: {},
          usage_stats: {},
        }));
        return json(200, { tools, has_more: false, next_cursor: null });
      }
      const tool = { id: this.nextId("tool"), toolConfig: asObject(body["tool_config"]) };
      this.tools.set(tool.id, tool);
      return json(200, { id: tool.id, tool_config: tool.toolConfig });
    }
    if (path.startsWith("/v1/convai/tools/") && method === "PATCH") {
      const tool = this.tools.get(id);
      if (tool === undefined) return json(404, { detail: { status: "not_found" } });
      tool.toolConfig = asObject(body["tool_config"]);
      return json(200, { id, tool_config: tool.toolConfig });
    }

    if (path === "/v1/workspace/webhooks") {
      if (method === "GET") {
        return json(200, {
          webhooks: this.webhooks.map((webhook) => ({
            name: webhook.name,
            webhook_id: webhook.webhookId,
            webhook_url: webhook.webhookUrl,
            is_disabled: webhook.isDisabled,
            is_auto_disabled: false,
            created_at_unix: 0,
            auth_type: "hmac",
          })),
        });
      }
      const settings = asObject(body["settings"]);
      const webhook = this.addWebhook(String(settings["name"]), String(settings["webhook_url"]));
      this.lastWebhookSecret = randomBytes(24).toString("hex");
      return json(200, { webhook_id: webhook.webhookId, webhook_secret: this.lastWebhookSecret });
    }
    if (path.startsWith("/v1/workspace/webhooks/") && method === "PATCH") {
      const webhook = this.webhooks.find((candidate) => candidate.webhookId === id);
      if (webhook === undefined) return json(404, { detail: { status: "not_found" } });
      webhook.isDisabled = body["is_disabled"] === true;
      webhook.retryEnabled = body["retry_enabled"] === true;
      return json(200, { status: "ok" });
    }

    if (path === "/v1/convai/agents" && method === "GET") {
      const search = request.query.get("search") ?? "";
      const tags = request.query.getAll("tags");
      const agents = [...this.agents.values()]
        .filter((agent) => String(agent.config["name"]).includes(search))
        .filter((agent) => {
          const agentTags = (agent.config["tags"] as string[] | undefined) ?? [];
          return tags.every((tag) => agentTags.includes(tag));
        })
        .map((agent) => ({
          agent_id: agent.agentId,
          name: agent.config["name"],
          tags: agent.config["tags"] ?? [],
          voice_id: "voice",
          created_at_unix_secs: 0,
          access_info: {},
        }));
      return json(200, { agents, has_more: false, next_cursor: null });
    }
    if (path === "/v1/convai/agents/create" && method === "POST") {
      const agent = { agentId: this.nextId("agent"), config: body };
      this.agents.set(agent.agentId, agent);
      return json(200, { agent_id: agent.agentId });
    }
    if (path.startsWith("/v1/convai/agents/") && method === "PATCH") {
      const agent = this.agents.get(id);
      if (agent === undefined) return json(404, { detail: { status: "not_found" } });
      agent.config = { ...agent.config, ...body };
      return json(200, { agent_id: id, ...agent.config });
    }

    if (path === "/v1/convai/v2/phone-numbers" && method === "GET") {
      const wanted = request.query.get("phone_number");
      const phoneNumbers = [...this.phoneNumbers.entries()]
        .filter(([, number]) => wanted === null || number.phoneNumber === wanted)
        .map(([phoneNumberId, number]) => ({
          phone_number: number.phoneNumber,
          label: number.body["label"],
          phone_number_id: phoneNumberId,
          provider: "twilio",
        }));
      return json(200, { phone_numbers: phoneNumbers, has_more: false, next_cursor: null });
    }
    if (path === "/v1/convai/phone-numbers" && method === "POST") {
      const phoneNumberId = this.nextId("phnum");
      this.phoneNumbers.set(phoneNumberId, { phoneNumber: String(body["phone_number"]), body });
      return json(200, { phone_number_id: phoneNumberId });
    }

    if (path === "/v1/convai/twilio/outbound-call" && method === "POST") {
      this.outboundCalls.push({ body });
      if (this.nextOutboundCall !== undefined) {
        const answer = this.nextOutboundCall(body);
        return json(answer.status, answer.body);
      }
      const conversationId = this.nextId("conv");
      this.conversations.set(conversationId, "initiated");
      return json(200, {
        success: true,
        message: "Success",
        conversation_id: conversationId,
        callSid: `CA${"0".repeat(28)}${String(this.counter).padStart(4, "0")}`,
      });
    }
    if (path.startsWith("/v1/convai/conversations/") && method === "GET") {
      const status = this.conversations.get(id);
      if (status === undefined) return json(404, { detail: { status: "not_found" } });
      return json(200, { agent_id: "agent", conversation_id: id, status });
    }

    return json(404, { detail: { status: "unknown_route" } });
  }
}
