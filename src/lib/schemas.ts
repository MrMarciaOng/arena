import { z } from "zod";
import {
  LIMITS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  RESERVED_SLUGS,
  SLUG_RE,
  THEMES,
  WAITING_ON,
} from "./domain";

export const slugSchema = z
  .string()
  .regex(SLUG_RE, "use 1-64 characters: a-z, 0-9, '.', '_' or '-', starting with a letter or digit");

export const arenaSlugSchema = slugSchema.refine((s) => !RESERVED_SLUGS.includes(s), {
  message: "this slug is reserved",
});

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "use a #rrggbb color");

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** Character limits count Unicode code points, so an emoji is one character, not two. */
const chars = (max: number, base: z.ZodString = z.string()) =>
  base.refine((s) => Array.from(s).length <= max, { message: `at most ${max} characters` });

/** Byte limits count UTF-8 bytes. */
const bytes = (max: number) =>
  z.string().refine((s) => utf8Bytes(s) <= max, { message: `at most ${max} bytes of UTF-8` });

/** Any JSON value (object, array, string, ...), at most LIMITS.metadataBytes once encoded. */
const metadataSchema = z.json().refine((m) => utf8Bytes(JSON.stringify(m)) <= LIMITS.metadataBytes, {
  message: `metadata must be at most ${LIMITS.metadataBytes} bytes of JSON`,
});

const appearanceSchema = z.strictObject({
  seed: z.string().max(64).optional(),
  palette: z
    .strictObject({
      skin: hexColor.optional(),
      hair: hexColor.optional(),
      shirt: hexColor.optional(),
      pants: hexColor.optional(),
    })
    .optional(),
});

const ttlSchema = z.number().int().min(MIN_TTL_SECONDS).max(MAX_TTL_SECONDS);
const displayNameSchema = chars(LIMITS.displayNameChars, z.string().trim().min(1));
const arenaNameSchema = chars(LIMITS.arenaNameChars, z.string().trim().min(1));

export const keyNameSchema = chars(LIMITS.keyNameChars, z.string().trim().min(1));

export const createKeyInput = z.strictObject({ name: keyNameSchema });

export const createArenaInput = z.strictObject({
  slug: arenaSlugSchema,
  name: arenaNameSchema,
  theme: z.enum(THEMES).default("office"),
});
export type CreateArenaInput = z.infer<typeof createArenaInput>;

export const updateArenaInput = z
  .strictObject({
    name: arenaNameSchema.optional(),
    theme: z.enum(THEMES).optional(),
  })
  .refine((v) => v.name !== undefined || v.theme !== undefined, {
    message: "send name and/or theme",
  });
export type UpdateArenaInput = z.infer<typeof updateArenaInput>;

/** PUT replaces the whole profile: a field left out goes back to its default. */
export const registerAgentInput = z.strictObject({
  displayName: displayNameSchema.optional(),
  role: chars(LIMITS.roleChars, z.string().trim()).nullable().optional(),
  appearance: appearanceSchema.nullable().optional(),
  ttlSeconds: ttlSchema.optional(),
  metadata: metadataSchema.nullable().optional(),
});
export type RegisterAgentInput = z.infer<typeof registerAgentInput>;

const common = {
  /** Any string; the request body limit bounds it. */
  session: z.string().optional(),
  seq: z.number().finite().optional(),
  /** Used only when this report auto-registers the agent. */
  displayName: displayNameSchema.optional(),
  ttlSeconds: ttlSchema.optional(),
  activity: chars(LIMITS.activityChars).optional(),
};

export const statusInput = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("idle"), ...common }),
  z.strictObject({
    status: z.literal("working"),
    ...common,
    progress: z.number().min(0).max(1).optional(),
  }),
  z.strictObject({
    status: z.literal("waiting"),
    ...common,
    waitingOn: z.enum(WAITING_ON).optional(),
    waitingFor: chars(LIMITS.waitingForChars).optional(),
  }),
  z.strictObject({
    status: z.literal("done"),
    ...common,
    // No length cap here: the server truncates long answers instead of rejecting them.
    result: z.string().optional(),
  }),
  z.strictObject({
    status: z.literal("error"),
    ...common,
    error: bytes(LIMITS.errorBytes).optional(),
  }),
]);
export type StatusInput = z.infer<typeof statusInput>;

export const heartbeatInput = z.strictObject({
  ttlSeconds: ttlSchema.optional(),
  leaving: z.boolean().optional(),
});
export type HeartbeatInput = z.infer<typeof heartbeatInput>;

export const eventsQuery = z.strictObject({
  agent: slugSchema.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
