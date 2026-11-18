import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CabinLocation, MelClass, Observation, Visit, VisitRecord, VisitState } from "../../src/domain/types.ts";
import { Inspector } from "../../src/web/components/Inspector.tsx";
import { recordTarget, type SaveStatus, UNKNOWN_OUTCOME } from "../../src/web/hooks/useMutations.ts";
import type { Workspace } from "../../src/web/model.ts";
import { CheckView } from "../../src/web/views/CheckView.tsx";
import { CUSHION_3A, fixtureRelease, KIT_PRIMARY, snapshotFor, visitWith } from "../helpers.ts";
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

  it.each(["", "0", "1.5", "abc", "999", "-1", "9".repeat(30), " 3 ", "1e2"])("quantity %j is invalid and blocks saving", async (typed) => {
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
    // Removing the record from the worklist is refused (409) and the reload brings it back changed. The form had nothing typed, so it follows.
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
    const pick = screen.getByRole("button", { name: "Pick seat 3B" });
    pick.focus();
    fireEvent.click(pick);
    const dialog = screen.getByRole("dialog", { name: "Discard the unrecorded change?" });
    expect(dialog).toHaveTextContent(/This change has not been recorded:.+ \/ Carpet panel/);
    // Go back is the default: it has focus, and Discard is the destructive choice.
    expect(within(dialog).getByRole("button", { name: "Go back" })).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Discard" })).toHaveClass("danger");
    fireEvent.click(within(dialog).getByRole("button", { name: "Go back" }));
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(pick).toHaveFocus();
    expect(screen.getByRole("region", { name: /^Carpet panel/ })).toBeInTheDocument();
    expect(within(card).getByLabelText("Note (optional)")).toHaveValue("frayed edge");
    fireEvent.click(pick);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(await screen.findByRole("region", { name: /^Seat cushion cover/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Carpet panel/ })).toBeNull();
  });

  it("Escape in the discard dialog is Go back", async () => {
    const { card } = await openPanel();
    fireEvent.change(within(card).getByLabelText("Note (optional)"), { target: { value: "frayed edge" } });
    fireEvent.click(screen.getByRole("button", { name: "Pick seat 3B" }));
    fireEvent(screen.getByRole("dialog", { name: "Discard the unrecorded change?" }), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(within(card).getByLabelText("Note (optional)")).toHaveValue("frayed edge");
  });

  it("selecting another seat with no change does not ask", async () => {
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Pick seat 3B" }));
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(await screen.findByRole("region", { name: /^Seat cushion cover/ })).toBeInTheDocument();
  });

  it("Complete with an unrecorded change asks first", async () => {
    const { card } = await openPanel();
    fireEvent.change(within(card).getByLabelText("Note (optional)"), { target: { value: "frayed edge" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete visit…" }));
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.queryByRole("button", { name: "Confirm completion" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Complete visit…" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
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
    // the guard is added by a passive effect, which may run after the message is on screen when the run is loaded
    await waitFor(() => expect(add.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1));
    add.mockRestore();
    await act(async () => {});
  });
});

const note = (card: HTMLElement) => within(card).getByLabelText("Note (optional)");

describe("Inspector removed records", () => {
  it("a record removed elsewhere is not shown as a saved value", async () => {
    let removed = false;
    stubFetch((method): Answer => {
      if (method === "GET") return { body: { visit: removed ? { ...base, version: 3, records: [] } : base } };
      removed = true;
      return stale;
    });
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pick forward floor" }));
    const card = await screen.findByRole("region", { name: /^Carpet panel/ });
    fireEvent.change(note(card), { target: { value: "frayed edge" } });
    fireEvent.click(screen.getByRole("button", { name: /^Remove Forward floor/ }));
    await within(card).findByText("This replacement was removed. Nothing is saved for it.");
    expect(within(card).queryByText(/Saved value/)).toBeNull();
    expect(note(card)).toHaveValue("frayed edge");
  });

  it("the person's own Remove resets the card and leaves nothing to discard", async () => {
    const { card } = await openPanel(() => ({ body: { visit: stateOf(base, { version: 3, records: [] }), replayed: false } }));
    fireEvent.change(note(card), { target: { value: "frayed edge" } });
    fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(card).queryByRole("button", { name: "Remove" })).toBeNull());
    expect(note(card)).toHaveValue("");
    expect(within(card).queryByText(/changed elsewhere|was removed/)).toBeNull();
    // The card reports "clean" from an effect; let it run before selecting.
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Pick seat 3B" }));
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });
});

describe("Inspector notices and discards", () => {
  it("the changed-elsewhere notice is announced politely", async () => {
    const { card } = await conflictWithTypedNote();
    const notice = within(card)
      .getByText(/changed elsewhere/)
      .closest("[role=status]");
    expect(notice).not.toBeNull();
    expect(notice).toHaveAttribute("aria-live", "polite");
  });

  it("agreeing to discard on Complete resets the dirty form", async () => {
    const { card } = await openPanel();
    fireEvent.change(note(card), { target: { value: "frayed edge" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete visit…" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const again = screen.getByRole("region", { name: /^Carpet panel/ });
    expect(note(again)).toHaveValue("");
    expect(within(again).getByText(/^Saved\./)).toBeInTheDocument();
  });

  it("the discard prompt names every dirty card", async () => {
    stubFetch((): Answer => ({ body: { visit: base } }));
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pick seat 3A" }));
    const cushion = await screen.findByRole("region", { name: /^Seat cushion cover/ });
    const backrest = await screen.findByRole("region", { name: /^Seat backrest cover/ });
    fireEvent.change(note(cushion), { target: { value: "a" } });
    fireEvent.change(note(backrest), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Pick seat 3B" }));
    const dialog = screen.getByRole("dialog", { name: "Discard unrecorded changes?" });
    expect(within(dialog).getByText(/Seat cushion cover/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Seat backrest cover/)).toBeInTheDocument();
  });

  it("typed input survives a save of a different card", async () => {
    const after = visitWith(snap, [PANEL, CUSHION_3A, KIT_PRIMARY]);
    stubFetch((method): Answer => {
      if (method === "GET") return { body: { visit: base } };
      return { body: { visit: stateOf(after, { version: base.version + 1 }), replayed: false } };
    });
    render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pick seat 3A" }));
    const cushion = await screen.findByRole("region", { name: /^Seat cushion cover/ });
    const backrest = await screen.findByRole("region", { name: /^Seat backrest cover/ });
    fireEvent.change(note(backrest), { target: { value: "typed" } });
    fireEvent.click(within(cushion).getByRole("button", { name: "Record replacement" }));
    await within(cushion).findByText(/^Saved\./);
    expect(note(backrest)).toHaveValue("typed");
    expect(within(backrest).queryByText(/changed elsewhere|was removed/)).toBeNull();
  });

  it("a later change equal to the person's earlier save still shows the notice", async () => {
    const saved: Visit = { ...base, version: 3, records: [{ ...panel, version: 2, note: "A" }] };
    const later: Visit = { ...base, version: 5, records: [{ ...panel, version: 4, note: "A" }] };
    let phase: "start" | "saved" | "later" = "start";
    stubFetch((method, url): Answer => {
      if (method === "GET") return { body: { visit: phase === "start" ? base : phase === "saved" ? saved : later } };
      if (url.endsWith("/records/remove")) {
        phase = "later";
        return stale;
      }
      phase = "saved";
      return { body: { visit: stateOf(saved, {}), replayed: false } };
    });
    const { card } = await (async () => {
      render(<CheckView visitId={base.id} navigate={vi.fn()} visualProfiles={[]} />);
      fireEvent.click(await screen.findByRole("button", { name: "Pick forward floor" }));
      return { card: await screen.findByRole("region", { name: /^Carpet panel/ }) };
    })();
    fireEvent.change(note(card), { target: { value: "A" } });
    fireEvent.click(within(card).getByRole("button", { name: "Update record" }));
    await within(card).findByText(/^Saved\./);
    fireEvent.change(note(card), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: /^Remove Forward floor/ }));
    await within(card).findByText(/changed elsewhere/);
  });

  it("pasting a quantity is checked like typing", async () => {
    const { card } = await openPanel();
    const user = userEvent.setup();
    const field = quantityField(card);
    await user.clear(field);
    await user.click(field);
    await user.paste("1e2");
    expect(field).toHaveAttribute("aria-invalid", "true");
    await user.clear(field);
    await user.paste("4");
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(within(card).getByRole("button", { name: "Update record" })).toBeEnabled();
  });
});

// The piece panel on its own: a hand-built workspace over the fixture snapshot, the callbacks as spies.
const seat3A = snap.context.layoutRevision.locations.find((l) => l.id === "SEAT:3A") as CabinLocation;
const MEL_BELT: MelClass = {
  class: "MEL",
  item: "FX-25-21-01",
  category: "C",
  intervalDays: 10,
  conditions: "Seat blocked and placarded INOP",
  blocksSeat: true,
};
const problem = (componentId: string, over: Partial<Observation> = {}): Observation => ({
  id: `OBS-${componentId}`,
  tail: "N100TL",
  status: "OPEN",
  version: 1,
  melClass: { class: "COSMETIC" },
  dueDate: null,
  blocksSeat: false,
  openedInVisitId: base.id,
  closedInVisitId: null,
  closedAs: null,
  locationLabel: "Seat 3A",
  componentName: componentId,
  createdAt: "2026-11-12T12:02:00.000Z",
  updatedAt: "2026-11-12T12:02:00.000Z",
  locationId: "SEAT:3A",
  componentId,
  condition: "STAINED",
  note: "",
  outcome: "NOTED",
  ...over,
});
const beltDeferral = problem("SEATBELT", {
  condition: "BROKEN",
  outcome: "DEFERRED",
  deferUntil: "NEXT_CHECK",
  reason: "NO_STOCK",
  melClass: MEL_BELT,
  dueDate: "2026-11-22",
  blocksSeat: true,
});
const pieceWorkspace = (over: Partial<Workspace> = {}): Workspace => ({
  mode: "visit",
  layout: snap.context.layoutRevision,
  resolution: snap.resolution,
  componentDefs: snap.resolution.componentDefs,
  records: [],
  editable: true,
  unresolvedReason: null,
  observations: [],
  carried: [],
  checkDate: "2026-11-12",
  mel: snap.mel ?? [],
  variantId: snap.context.variant.id,
  ...over,
});
function renderPiece(over: Partial<Workspace> = {}, props: Partial<ComponentProps<typeof Inspector>> = {}) {
  const calls = { onObserve: vi.fn(), onUpdateObservation: vi.fn(), onCloseObservation: vi.fn() };
  const view = render(
    <Inspector
      workspace={pieceWorkspace(over)}
      location={seat3A}
      focusComponent={null}
      statusOf={() => ({ phase: "idle" })}
      onRecord={vi.fn()}
      onRemove={vi.fn()}
      onRetry={vi.fn()}
      onSelect={vi.fn()}
      onDirtyChange={vi.fn()}
      {...calls}
      {...props}
    />,
  );
  return { ...calls, ...view };
}
const pieceCard = (name: RegExp) => screen.getByRole("region", { name });
const outcomeNames = (card: HTMLElement) =>
  within(within(card).getByRole("radiogroup", { name: "Outcome" }))
    .getAllByRole("radio")
    .map((r) => r.closest("label")?.textContent?.trim());

describe("Inspector piece panel", () => {
  it("heads each piece with its location and name, and offers Replace now, Note a problem and Defer", () => {
    renderPiece();
    const card = pieceCard(/^Headrest cover/);
    expect(within(card).getByRole("heading", { level: 4 })).toHaveTextContent(/^Seat 3A · Headrest cover/);
    expect(
      within(card)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(expect.arrayContaining(["Replace now", "Note a problem", "Defer"]));
  });

  it("a life vest marked Missing offers only Must be fixed", async () => {
    const user = userEvent.setup();
    renderPiece();
    const card = pieceCard(/^Life vest/);
    await user.click(within(card).getByRole("button", { name: "Note a problem" }));
    await user.click(within(card).getByRole("radio", { name: "Missing" }));
    expect(outcomeNames(card)).toEqual(["Must be fixed before flight"]);
    expect(within(card).getByText(/^No-go: must be fixed before flight\. A life vest is required at every occupied seat/)).toBeInTheDocument();
  });

  it("after a seat belt deferral on the same seat it offers Defer with a fix-by date", async () => {
    const user = userEvent.setup();
    renderPiece({ observations: [beltDeferral] });
    const card = pieceCard(/^Life vest/);
    await user.click(within(card).getByRole("button", { name: "Note a problem" }));
    await user.click(within(card).getByRole("radio", { name: "Missing" }));
    expect(outcomeNames(card)).toEqual(["Defer", "Must be fixed before flight"]);
    expect(within(card).getByText("MEL item FX-25-61-01 (category C, fix within 10 days): Seat blocked")).toBeInTheDocument();
    expect(within(card).getByText("Fix by 22 Nov 2026")).toBeInTheDocument();
  });

  it("Defer hides Note only for an MEL item", async () => {
    const user = userEvent.setup();
    renderPiece();
    const card = pieceCard(/^Seat belt/);
    await user.click(within(card).getByRole("button", { name: "Defer" }));
    await user.click(within(card).getByRole("radio", { name: "Broken" }));
    expect(outcomeNames(card)).toEqual(["Defer", "Must be fixed before flight"]);
    expect(within(card).getByRole("radio", { name: "Defer" })).toBeChecked();
    expect(within(card).queryByRole("radio", { name: "Note only" })).toBeNull();
    expect(within(card).getByRole("radiogroup", { name: "Until" })).toBeInTheDocument();
    expect(within(card).getByRole("radiogroup", { name: "Reason" })).toBeInTheDocument();
  });

  it("offers only the conditions the MEL lists for the piece", async () => {
    const user = userEvent.setup();
    renderPiece();
    const card = pieceCard(/^Seat belt/);
    await user.click(within(card).getByRole("button", { name: "Note a problem" }));
    const names = within(within(card).getByRole("radiogroup", { name: "Condition" }))
      .getAllByRole("radio")
      .map((r) => r.closest("label")?.textContent?.trim());
    expect(names).toEqual(["Worn", "Broken", "Missing", "Other"]);
  });

  it("Make this stricter offers only higher levels", async () => {
    const user = userEvent.setup();
    renderPiece({ observations: [beltDeferral] });
    const belt = pieceCard(/^Seat belt/);
    await user.click(within(belt).getByRole("button", { name: "Edit" }));
    const stricter = within(belt).getByRole("combobox", { name: "Make this stricter" });
    expect(
      within(stricter)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["No change", "No-go"]);

    const headrest = pieceCard(/^Headrest cover/);
    await user.click(within(headrest).getByRole("button", { name: "Note a problem" }));
    await user.click(within(headrest).getByRole("radio", { name: "Stained" }));
    const cosmetic = within(headrest).getByRole("combobox", { name: "Make this stricter" });
    expect(
      within(cosmetic)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["No change", "MEL item", "No-go"]);
  });

  it("an edit never offers a raise below the one already made", async () => {
    const user = userEvent.setup();
    const raised = problem("HEADREST", { outcome: "MUST_FIX", raisedTo: "NO_GO", melClass: { class: "NO_GO", reason: "Raised by the technician" } });
    renderPiece({ observations: [raised] });
    const card = pieceCard(/^Headrest cover/);
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    expect(within(card).queryByRole("combobox", { name: "Make this stricter" })).toBeNull();
    expect(outcomeNames(card)).toEqual(["Must be fixed before flight"]);
  });

  it("Mark replaced is disabled without a record", () => {
    renderPiece({ observations: [problem("HEADREST")] });
    const card = pieceCard(/^Headrest cover/);
    expect(within(card).getByRole("button", { name: "Mark replaced" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Mark fixed" })).toBeEnabled();
  });

  it("Mark replaced is enabled with a record and closes the problem as replaced", async () => {
    const user = userEvent.setup();
    const withRecord = visitWith(snap, [{ ...CUSHION_3A, componentId: "HEADREST" }]);
    const o = problem("HEADREST");
    const { onCloseObservation } = renderPiece({ observations: [o], records: withRecord.records });
    const card = pieceCard(/^Headrest cover/);
    await user.click(within(card).getByRole("button", { name: "Mark replaced" }));
    expect(onCloseObservation).toHaveBeenCalledWith(o, "REPLACED");
  });

  it("a carried problem says where it came from and when it ran out", () => {
    const earlier = { ...beltDeferral, id: "OBS-OLD", openedInVisitId: "visit-0", createdAt: "2026-10-20T09:00:00.000Z", dueDate: "2026-10-30" };
    renderPiece({ carried: [{ observation: earlier, placement: "SAME", locationId: "SEAT:3A", overdue: true }] });
    const card = pieceCard(/^Seat belt/);
    expect(within(card).getByText("Carried over from the check on 20 Oct 2026")).toBeInTheDocument();
    expect(within(card).getByText("Overdue since 30 Oct 2026")).toHaveClass("must-fix");
  });

  it("the copy shows no raw codes", async () => {
    const user = userEvent.setup();
    const bin = problem("HEADREST", { condition: "OTHER", outcome: "DEFERRED", deferUntil: "NEXT_CHECK", reason: "NO_TIME" });
    const { container } = renderPiece({ observations: [beltDeferral, bin] });
    const card = pieceCard(/^Life vest/);
    await user.click(within(card).getByRole("button", { name: "Defer" }));
    await user.click(within(card).getByRole("radio", { name: "Missing" }));
    expect(container.textContent).not.toMatch(/NO_GO|WONT_LATCH|NEXT_CHECK|NEXT_STOP|NO_STOCK|NO_TIME|MUST_FIX|DEFERRED/);
    expect(container.textContent).toMatch(/Until the next check/);
  });

  it("submit calls onObserve with the exact ObservationInput", async () => {
    const user = userEvent.setup();
    const { onObserve } = renderPiece();
    const card = pieceCard(/^Seat cushion cover/);
    await user.click(within(card).getByRole("button", { name: "Defer" }));
    await user.click(within(card).getByRole("radio", { name: "Stained" }));
    await user.click(within(card).getByRole("radio", { name: "Until the next stop" }));
    await user.click(within(card).getByRole("radio", { name: "No stock on hand" }));
    await user.type(within(card).getByLabelText(/^Note about the problem/), "coffee");
    await user.click(within(card).getByRole("button", { name: "Save problem" }));
    expect(onObserve).toHaveBeenCalledTimes(1);
    expect(onObserve.mock.calls[0]?.[0]).toStrictEqual({
      locationId: "SEAT:3A",
      componentId: "CUSHION",
      condition: "STAINED",
      note: "coffee",
      outcome: "DEFERRED",
      deferUntil: "NEXT_STOP",
      reason: "NO_STOCK",
    });
  });

  it("an edit calls onUpdateObservation with the problem and the new input", async () => {
    const user = userEvent.setup();
    const o = problem("HEADREST");
    const { onUpdateObservation } = renderPiece({ observations: [o] });
    const card = pieceCard(/^Headrest cover/);
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    await user.selectOptions(within(card).getByRole("combobox", { name: "Make this stricter" }), "MEL item");
    await user.click(within(card).getByRole("radio", { name: "Must be fixed before flight" }));
    await user.click(within(card).getByRole("button", { name: "Save problem" }));
    expect(onUpdateObservation).toHaveBeenCalledWith(o, {
      locationId: "SEAT:3A",
      componentId: "HEADREST",
      condition: "STAINED",
      note: "",
      outcome: "MUST_FIX",
      raisedTo: "MEL",
    });
  });

  /** The cushion card's last dirty report (every card reports its own target). */
  const dirtyNow = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.filter(([t]) => t === recordTarget("SEAT:3A", "CUSHION")).at(-1)?.[1];

  it("a disabled Mark replaced says why", () => {
    renderPiece({ observations: [problem("HEADREST")] });
    const card = pieceCard(/^Headrest cover/);
    expect(within(card).getByRole("button", { name: "Mark replaced" })).toHaveAccessibleDescription(/Record the replacement first\./);
  });

  it("the record save status and Retry safely stay visible while the problem form is open", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const unknown: SaveStatus = { phase: "unknown", message: UNKNOWN_OUTCOME };
    const target = recordTarget("SEAT:3A", "CUSHION");
    renderPiece({}, { statusOf: (t) => (t === target ? unknown : { phase: "idle" }), onRetry });
    const card = pieceCard(/^Seat cushion cover/);
    await user.click(within(card).getByRole("button", { name: "Note a problem" }));
    expect(within(card).getByRole("group", { name: "Note a problem" })).toBeInTheDocument();
    expect(within(card).getByText(UNKNOWN_OUTCOME)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Retry safely" }));
    expect(onRetry).toHaveBeenCalledWith(target);
  });

  it("a failed problem save keeps the form and its input, and counts as unsaved input", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    const failed: SaveStatus = { phase: "failed", message: "The store refused it.", retryable: false };
    const onObserve = vi.fn(async () => false);
    renderPiece({}, { onObserve, onDirtyChange, statusOf: (t) => (t === "observation:SEAT:3A:CUSHION" ? failed : { phase: "idle" }) });
    const card = pieceCard(/^Seat cushion cover/);
    await user.click(within(card).getByRole("button", { name: "Note a problem" }));
    await user.click(within(card).getByRole("radio", { name: "Stained" }));
    await user.click(within(card).getByRole("radio", { name: "Note only" }));
    await user.type(within(card).getByLabelText(/^Note about the problem/), "coffee");
    expect(dirtyNow(onDirtyChange)).toBe(true);
    await user.click(within(card).getByRole("button", { name: "Save problem" }));
    expect(onObserve).toHaveBeenCalledTimes(1);
    expect(within(card).getByLabelText(/^Note about the problem/)).toHaveValue("coffee");
    expect(within(card).getByRole("radio", { name: "Stained" })).toBeChecked();
    expect(within(card).getByText("Not saved: The store refused it.")).toBeInTheDocument();
    expect(dirtyNow(onDirtyChange)).toBe(true);
  });

  it("the problem form closes once its save succeeds", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    renderPiece({}, { onObserve: vi.fn(async () => true), onDirtyChange });
    const card = pieceCard(/^Seat cushion cover/);
    await user.click(within(card).getByRole("button", { name: "Note a problem" }));
    await user.click(within(card).getByRole("radio", { name: "Stained" }));
    await user.click(within(card).getByRole("radio", { name: "Note only" }));
    await user.click(within(card).getByRole("button", { name: "Save problem" }));
    await waitFor(() => expect(within(card).queryByRole("group", { name: "Note a problem" })).toBeNull());
    // the closed form's unsaved state is withdrawn in the render after it unmounts
    await waitFor(() => expect(dirtyNow(onDirtyChange)).toBe(false));
  });
});
