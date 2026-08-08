import { beforeEach, describe, expect, it } from "vitest";
import { useNotificationsStore } from "@/stores/notifications";

const baseNotif = {
  terminalId: "term_1",
  terminalName: "Agent 1",
  agentType: "claude-code" as const,
  kind: "awaiting" as const,
};

describe("useNotificationsStore", () => {
  beforeEach(() => {
    useNotificationsStore.setState({ items: [] });
  });

  it("push adds item newest-first with generated id and read=false", () => {
    useNotificationsStore.getState().push(baseNotif);
    const items = useNotificationsStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBeTruthy();
    expect(items[0]?.read).toBe(false);
    expect(items[0]?.kind).toBe("awaiting");
  });

  it("push prepends so newest is first", () => {
    useNotificationsStore.getState().push({ ...baseNotif, kind: "awaiting" });
    useNotificationsStore.getState().push({ ...baseNotif, kind: "complete" });
    const items = useNotificationsStore.getState().items;
    expect(items[0]?.kind).toBe("complete");
    expect(items[1]?.kind).toBe("awaiting");
  });

  it("markRead marks a single item", () => {
    useNotificationsStore.getState().push(baseNotif);
    useNotificationsStore.getState().push({ ...baseNotif, kind: "error" });
    const id = useNotificationsStore.getState().items[0]!.id;
    useNotificationsStore.getState().markRead(id);
    expect(useNotificationsStore.getState().items[0]?.read).toBe(true);
    expect(useNotificationsStore.getState().items[1]?.read).toBe(false);
  });

  it("markAllRead marks every item", () => {
    useNotificationsStore.getState().push(baseNotif);
    useNotificationsStore.getState().push({ ...baseNotif, kind: "complete" });
    useNotificationsStore.getState().markAllRead();
    for (const item of useNotificationsStore.getState().items) {
      expect(item.read).toBe(true);
    }
  });

  it("dismiss removes by id", () => {
    useNotificationsStore.getState().push(baseNotif);
    useNotificationsStore.getState().push({ ...baseNotif, kind: "error" });
    // items = [error (0), awaiting (1)] — newest first
    const id = useNotificationsStore.getState().items[0]!.id; // dismiss "error"
    useNotificationsStore.getState().dismiss(id);
    expect(useNotificationsStore.getState().items).toHaveLength(1);
    expect(useNotificationsStore.getState().items[0]?.kind).toBe("awaiting");
  });

  it("clearAll empties the list", () => {
    useNotificationsStore.getState().push(baseNotif);
    useNotificationsStore.getState().push(baseNotif);
    useNotificationsStore.getState().clearAll();
    expect(useNotificationsStore.getState().items).toHaveLength(0);
  });

  it("caps list at 50 items, dropping oldest", () => {
    for (let i = 0; i < 55; i++) {
      useNotificationsStore
        .getState()
        .push({ ...baseNotif, terminalName: `Agent ${i}` });
    }
    const items = useNotificationsStore.getState().items;
    expect(items).toHaveLength(50);
    // Newest (Agent 54) is at index 0, oldest retained (Agent 5) is at index 49.
    expect(items[0]?.terminalName).toBe("Agent 54");
    expect(items[49]?.terminalName).toBe("Agent 5");
  });
});
