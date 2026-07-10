import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

const baseUrl = () => {
  const value = process.env.TELEBIRR_INTERNAL_API_URL;
  if (!value) throw new Error("TELEBIRR_INTERNAL_API_URL is required");
  return value.replace(/\/$/, "");
};

async function callInternal(path: string, init?: RequestInit): Promise<ToolResult> {
  const token = process.env.TELEBIRR_OPENCLAW_SERVICE_TOKEN;
  if (!token) throw new Error("TELEBIRR_OPENCLAW_SERVICE_TOKEN is required");

  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "x-ai-client": "openclaw",
      ...(init?.headers ?? {})
    },
    signal: AbortSignal.timeout(8_000)
  });

  if (!response.ok) {
    throw new Error(`Telebirr advisory API returned ${response.status}`);
  }

  const body = await response.json();
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

export default definePluginEntry({
  id: "telebirr-operations",
  name: "Telebirr Operations (Advisory)",
  description: "Read-only operational analysis and approval proposals; no financial execution.",
  register(api: {
    registerTool(tool: unknown, options?: { optional?: boolean }): void;
  }) {
    api.registerTool({
      name: "telebirr_fleet_summary",
      description: "Read aggregate, redacted fleet health and liquidity. Never returns PINs, raw SMS or full phone numbers.",
      parameters: Type.Object({
        merchantId: Type.Optional(Type.String({ minLength: 1 })),
        groupId: Type.Optional(Type.String({ minLength: 1 }))
      }),
      async execute(_id: string, params: { merchantId?: string; groupId?: string }) {
        const query = new URLSearchParams();
        if (params.merchantId) query.set("merchantId", params.merchantId);
        if (params.groupId) query.set("groupId", params.groupId);
        return callInternal(`/internal/ai/fleet-summary?${query.toString()}`);
      }
    });

    api.registerTool({
      name: "telebirr_case_summary",
      description: "Read a redacted reconciliation or payout case and its deterministic evidence.",
      parameters: Type.Object({ caseId: Type.String({ minLength: 1 }) }),
      async execute(_id: string, params: { caseId: string }) {
        return callInternal(`/internal/ai/cases/${encodeURIComponent(params.caseId)}`);
      }
    });

    api.registerTool({
      name: "telebirr_name_review",
      description: "Compare two person names for likely spelling or transliteration differences. Receives names only and cannot approve a payout.",
      parameters: Type.Object({
        expectedName: Type.String({ minLength: 1, maxLength: 160 }),
        observedName: Type.String({ minLength: 1, maxLength: 160 })
      }),
      async execute(_id: string, params: { expectedName: string; observedName: string }) {
        return callInternal("/internal/ai/name-review", {
          method: "POST",
          body: JSON.stringify(params)
        });
      }
    });

    api.registerTool({
      name: "telebirr_propose_action",
      description: "Create a non-executing proposal for platform staff. The proposal always requires authenticated human approval.",
      parameters: Type.Object({
        caseId: Type.String({ minLength: 1 }),
        proposalType: Type.Union([
          Type.Literal("approve_name_match"),
          Type.Literal("request_balance_refresh"),
          Type.Literal("quarantine_device"),
          Type.Literal("request_manual_reconciliation")
        ]),
        rationale: Type.String({ minLength: 10, maxLength: 2_000 })
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return callInternal("/internal/ai/proposals", {
          method: "POST",
          body: JSON.stringify(params)
        });
      }
    }, { optional: true });
  }
});
