import { getDocoById, getEntity, upsertEntity } from "@doco/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateEntity } from "../capture.server";

vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    idea: { table: "ideas", body: false, typeNamedColumn: "idea" },
    state: { table: "states", body: false, typeNamedColumn: "state" },
  },
  getDocoById: vi.fn(),
  getEntity: vi.fn(),
  upsertEntity: vi.fn(),
  withClient: vi.fn(),
  withTransaction: vi.fn(async (fn) => fn({})),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("../audit-log.server", () => ({
  appendAuditEvent: vi.fn(),
}));

vi.mock("../authoring-runner.server", () => ({
  runAuthoringPrimitives: vi.fn(async () => ({
    blocking: null,
    violations: [],
    warnings: [],
  })),
}));

vi.mock("../redeem.server", () => ({
  reindex: vi.fn(async () => undefined),
  reindexEmbeddingsOnly: vi.fn(async () => undefined),
}));

const DOCO_ID = "doco_01TEST00000000000000000001";
const STATE_ID = "state_01TEST0000000000000000001";
const IDEA_ID = "idea_01TEST00000000000000000001";

describe("updateEntity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDocoById).mockResolvedValue({
      id: DOCO_ID,
      handle: "test-doco",
    } as Awaited<ReturnType<typeof getDocoById>>);
  });

  it("does not change the neuron name when the route does not allow renaming", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: STATE_ID,
      entity_type: "state",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "active",
      body_md: "",
      data: {
        id: STATE_ID,
        doco_id: DOCO_ID,
        neuron_type: "state",
        state: "Original state name",
        kind: "intermediate",
        lifecycle: "active",
      },
    } as Awaited<ReturnType<typeof getEntity>>);

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "state",
      pluralDir: "states",
      id: STATE_ID,
      patch: {
        state: "Renamed state name",
        kind: "terminal",
      },
      allowedFields: ["kind", "invariants", "follows"],
      docoHost: "https://doco.test",
      actorId: null,
    });

    expect(result).toMatchObject({
      ok: true,
      changed: ["kind"],
    });
    expect(upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: null,
        type_named_value: "Original state name",
        data: expect.objectContaining({
          state: "Original state name",
          kind: "terminal",
        }),
      }),
      expect.anything(),
    );
  });

  it("updates the neuron name when the route explicitly allows renaming", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      id: IDEA_ID,
      entity_type: "idea",
      doco_id: DOCO_ID,
      summary: null,
      lifecycle: "active",
      body_md: "",
      data: {
        id: IDEA_ID,
        doco_id: DOCO_ID,
        neuron_type: "idea",
        idea: "Original idea name",
        lifecycle: "active",
      },
    } as Awaited<ReturnType<typeof getEntity>>);

    const result = await updateEntity({
      docoDir: "/tmp/doco",
      docoId: DOCO_ID,
      ownerSlug: "test",
      docoSlug: "doco",
      entityType: "idea",
      pluralDir: "ideas",
      id: IDEA_ID,
      patch: {
        idea: "Renamed idea name",
      },
      allowedFields: ["idea"],
      docoHost: "https://doco.test",
      actorId: null,
    });

    expect(result).toMatchObject({
      ok: true,
      changed: ["idea"],
    });
    expect(upsertEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: null,
        type_named_value: "Renamed idea name",
        data: expect.objectContaining({
          idea: "Renamed idea name",
        }),
      }),
      expect.anything(),
    );
  });
});
