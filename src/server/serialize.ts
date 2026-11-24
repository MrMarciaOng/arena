import "server-only";
import {
  LIMITS,
  type AgentDetail,
  type AgentEvent,
  type AgentPublic,
  type ArenaPublic,
  type PresenceMessage,
} from "@/lib/domain";
import type { AgentRow, ArenaRow, EventRow } from "./db/schema";

const iso = (ms: number) => new Date(ms).toISOString();

export function toArenaPublic(row: ArenaRow): ArenaPublic {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    theme: row.theme,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function preview(text: string | null): string | null {
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length <= LIMITS.resultPreviewChars
    ? text
    : `${chars.slice(0, LIMITS.resultPreviewChars).join("")}…`;
}

export function toAgentPublic(row: AgentRow, arenaSlug: string): AgentPublic {
  return {
    id: row.id,
    arenaId: row.arenaId,
    arena: arenaSlug,
    key: row.key,
    displayName: row.displayName,
    role: row.role,
    appearance: row.appearance ?? null,
    status: row.status,
    activity: row.activity,
    waitingOn: row.waitingOn,
    waitingFor: row.waitingFor,
    progress: row.progress,
    hasResult: row.result !== null && row.result !== "",
    resultPreview: preview(row.result),
    resultTruncated: row.resultTruncated,
    error: row.error,
    seat: row.seat,
    version: row.version,
    ttlSeconds: row.ttlSeconds,
    lastSeenAt: iso(row.lastSeenAt),
    awaySince: row.awaySince === null ? null : iso(row.awaySince),
    statusChangedAt: iso(row.statusChangedAt),
    createdAt: iso(row.createdAt),
    metadata: row.metadata ?? null,
  };
}

export function toAgentDetail(row: AgentRow, arenaSlug: string): AgentDetail {
  return { ...toAgentPublic(row, arenaSlug), result: row.result };
}

export function toPresence(row: AgentRow, seq: number): PresenceMessage {
  return {
    type: "presence",
    seq,
    arenaId: row.arenaId,
    agentId: row.id,
    key: row.key,
    lastSeenAt: iso(row.lastSeenAt),
    awaySince: row.awaySince === null ? null : iso(row.awaySince),
    ttlSeconds: row.ttlSeconds,
  };
}

export function toEvent(row: EventRow): AgentEvent {
  return {
    id: row.id,
    agentKey: row.agentKey,
    type: row.type,
    applied: row.applied,
    report: row.report ?? null,
    agentVersion: row.agentVersion,
    createdAt: iso(row.createdAt),
  };
}
