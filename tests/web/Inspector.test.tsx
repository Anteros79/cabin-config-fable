import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Visit, VisitRecord, VisitState } from "../../src/domain/types.ts";
import { CheckView } from "../../src/web/views/CheckView.tsx";
import { fixtureRelease, snapshotFor, visitWith } from "../helpers.ts";
import { type Answer, stubFetch } from "./fetchStub.ts";

// The 3D view is not under test here; stand-in buttons select a location the way a click in the cabin would.
vi.mock("../../src/web/components/Viewer.tsx", () => ({
  Viewer: ({ onSelect }: { onSelect(locationId: string, componentId: string | null): void }) => (
    <>
      <button type="button" onClick={() => onSelect("SEAT:3A", "CUSHION")}>
        Pick seat 3A
      </button>
      <button type="button" onClick={() => onSelect("SEAT:3B", "CUSHION")}>
        Pick seat 3B
      </button>
      <button type="button" onClick={() => onSelect("FLOOR:FWD", "CARPET_PANEL")}>
        Pick forward floor
      </button>
    </>
  ),
}));

const release = fixtureRelease();
const snap = snapshotFor(release, "N100TL", "2026-11-12");
const PANEL = { locationId: "FLOOR:FWD", componentId: "CARPET_PANEL", selection: "PRIMARY", substituteId: null, quantity: 2, note: "" };
const base = visitWith(snap, [PANEL]);
const panel = base.records[0] as VisitRecord;
const stateOf = (visit: Visit, patch: Partial<VisitState>): VisitState => {
  const { snapshot: _snapshot, ...rest } = visit;
  return { ...rest, ...patch };
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function openPanel(handler: (method: string, url: string, body: Record<string, unknown> | null) => Answer = () => ({ body: { visit: base } })) {
  const sent = stubFetch((method, url, body) => (method === "GET" ? { body: { visit: base } } : handler(method, url, body)));
  render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
  fireEvent.click(await screen.findByRole("button", { name: "Pick forward floor" }));
  const card = await screen.findByRole("region", { name: /^Carpet panel/ });
  return { sent, card };
}
const quantityField = (card: HTMLElement) => within(card).getByLabelText(/^Replacements/) as HTMLInputElement;

describe("Inspector quantity field", () => {
  it("clearing the quantity and typing 3 gives 3, and saving sends quantity 3", async () => {
    const { sent, card } = await openPanel((_m, _u, body) => ({
      body: {
        visit: stateOf(base, {
          version: base.version + 1,
          records: [{ ...panel, version: 2, quantity: Number((body?.record as { quantity: number } | undefined)?.quantity) }],
        }),
        replayed: false,
      },
    }));
    const user = userEvent.setup();
    const field = quantityField(card);
    await user.clear(field);
    expect(field.value).toBe("");
    await user.type(field, "3");
    expect(field.value).toBe("3");
    expect(field).toHaveAttribute("inputmode", "numeric");
    expect(field).toHaveAttribute("pattern", "[0-9]*");
    await user.click(within(card).getByRole("button", { name: "Update record" }));
    await waitFor(() => expect(sent.filter((s) => s.method === "PUT")).toHaveLength(1));
    expect(sent.find((s) => s.method === "PUT")?.body).toMatchObject({ record: { quantity: 3 } });
  });

  it.each(["", "0", "1.5", "abc", "999"])("quantity %j is invalid and blocks saving", async (typed) => {
    const { sent, card } = await openPanel();
    const field = quantityField(card);
    fireEvent.change(field, { target: { value: typed } });
    expect(field).toHaveAttribute("aria-invalid", "true");
    const help = card.querySelector(`#${field.getAttribute("aria-describedby")}`);
    expect(help).toHaveTextContent("Enter a whole number from 1 to 4.");
    const save = within(card).getByRole("button", { name: "Update record" });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest("form") as HTMLFormElement);
    expect(sent.filter((s) => s.method === "PUT")).toHaveLength(0);
  });

  it("a valid quantity is not marked invalid", async () => {
    const { card } = await openPanel();
    expect(quantityField(card)).not.toHaveAttribute("aria-invalid");
    expect(quantityField(card)).not.toHaveAttribute("aria-describedby");
  });
});

const stale = { status: 409, body: { error: { code: "STALE_RECORD", message: "The record changed since it was read.", details: null } } };
const changedElsewhere: Visit = { ...base, version: base.version + 1, records: [{ ...panel, version: 2, note: "worn", quantity: 3 }] };

/** Types a note, saves, and gets a conflict whose reload brings a record changed elsewhere. */
async function conflictWithTypedNote() {
  let conflicted = false;
  const sent = stubFetch((method): Answer => {
    if (method === "GET") return { body: { visit: conflicted ? changedElsewhere : base } };
    conflicted = true;
    return stale;
  });
  render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
  fireEvent.click(await screen.findByRole("button", { name: "Pick forward floor" }));
  const card = await screen.findByRole("region", { name: /^Carpet panel/ });
  fireEvent.change(within(card).getByLabelText("Note (optional)"), { target: { value: "frayed edge" } });
  fireEvent.click(within(card).getByRole("button", { name: "Update record" }));
  await within(card).findByText(/changed elsewhere/);
  return { sent, card };
}

describe("Inspector draft and conflicts", () => {
  it("a conflict reload keeps the typed note and offers both values", async () => {
    const { card } = await conflictWithTypedNote();
    expect(within(card).getByLabelText("Note (optional)")).toHaveValue("frayed edge");
    expect(within(card).getByText(/This replacement changed elsewhere\. Saved value: Primary, 3, note .worn.\./)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Use saved value" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Keep mine" })).toBeInTheDocument();
  });

  it("Use saved value replaces the draft with the saved one", async () => {
    const { card } = await conflictWithTypedNote();
    fireEvent.click(within(card).getByRole("button", { name: "Use saved value" }));
    expect(within(card).getByLabelText("Note (optional)")).toHaveValue("worn");
    expect(quantityField(card).value).toBe("3");
    expect(within(card).queryByText(/changed elsewhere\. Saved value/)).toBeNull();
  });

  it("Keep mine then save sends the current server version", async () => {
    const { sent, card } = await conflictWithTypedNote();
    fireEvent.click(within(card).getByRole("button", { name: "Keep mine" }));
    expect(within(card).queryByText(/changed elsewhere\. Saved value/)).toBeNull();
    expect(within(card).getByLabelText("Note (optional)")).toHaveValue("frayed edge");
    fireEvent.click(within(card).getByRole("button", { name: "Update record" }));
    await waitFor(() => expect(sent.filter((s) => s.method === "PUT")).toHaveLength(2));
    const puts = sent.filter((s) => s.method === "PUT");
    expect(puts[0]?.body?.expectedRecordVersion).toBe(1);
    expect(puts[1]?.body?.expectedRecordVersion).toBe(2);
  });

  it("a clean form follows a record changed elsewhere without a notice", async () => {
    let conflicted = false;
    stubFetch((method): Answer => {
      if (method === "GET") return { body: { visit: conflicted ? changedElsewhere : base } };
      conflicted = true;
      return stale;
    });
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pick forward floor" }));
    const card = await screen.findByRole("region", { name: /^Carpet panel/ });
    // Another tab's change reaches this tab through a reload after a conflict on a different target.
    fireEvent.click(screen.getByRole("button", { name: /^Remove Forward floor/ }));
    await waitFor(() => expect(quantityField(card).value).toBe("3"));
    expect(within(card).getByLabelText("Note (optional)")).toHaveValue("worn");
    expect(within(card).queryByText(/changed elsewhere\. Saved value/)).toBeNull();
  });

  it("Saved is not shown while the form is dirty", async () => {
    const { card } = await openPanel();
    expect(within(card).getByText(/^Saved\./)).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText("Note (optional)"), { target: { value: "x" } });
    expect(within(card).queryByText(/^Saved\./)).toBeNull();
    fireEvent.change(within(card).getByLabelText("Note (optional)"), { target: { value: "" } });
    expect(within(card).getByText(/^Saved\./)).toBeInTheDocument();
  });
});

describe("Inspector unrecorded changes", () => {
  it("selecting another seat with an unrecorded change asks first, and Go back keeps the form", async () => {
    const { card } = await openPanel();
    fireEvent.change(within(card).getByLabelText("Note (optional)"), { target: { value: "frayed edge" } });
    const confirm = vi.fn((_message: string) => false);
    vi.stubGlobal("confirm", confirm);
    fireEvent.click(screen.getByRole("button", { name: "Pick seat 3B" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toMatch(/^You have an unrecorded change for .+ \/ Carpet panel\. Discard it\?$/);
    expect(screen.getByRole("region", { name: /^Carpet panel/ })).toBeInTheDocument();
    expect(within(card).getByLabelText("Note (optional)")).toHaveValue("frayed edge");
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Pick seat 3B" }));
    expect(await screen.findByRole("region", { name: /^Seat cushion cover/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Carpet panel/ })).toBeNull();
  });

  it("selecting another seat with no change does not ask", async () => {
    await openPanel();
    const confirm = vi.fn((_message: string) => false);
    vi.stubGlobal("confirm", confirm);
    fireEvent.click(screen.getByRole("button", { name: "Pick seat 3B" }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("Complete with an unrecorded change asks first", async () => {
    const { card } = await openPanel();
    fireEvent.change(within(card).getByLabelText("Note (optional)"), { target: { value: "frayed edge" } });
    const confirm = vi.fn((_message: string) => false);
    vi.stubGlobal("confirm", confirm);
    fireEvent.click(screen.getByRole("button", { name: "Complete visit…" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Confirm completion" })).toBeNull();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Complete visit…" }));
    expect(screen.getByRole("button", { name: "Confirm completion" })).toBeInTheDocument();
  });

  it("registers beforeunload only while a card is dirty", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { card } = await openPanel();
    const registered = () => add.mock.calls.filter(([type]) => type === "beforeunload").length;
    expect(registered()).toBe(0);
    fireEvent.change(within(card).getByLabelText("Note (optional)"), { target: { value: "x" } });
    expect(registered()).toBe(1);
    fireEvent.change(within(card).getByLabelText("Note (optional)"), { target: { value: "" } });
    expect(remove.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });

  it("registers beforeunload while a write has an unknown outcome", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const { card } = await openPanel(() => "reject");
    fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
    await within(card).findByText(/may or may not have been saved/);
    expect(add.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);
    add.mockRestore();
    await act(async () => {});
  });
});
