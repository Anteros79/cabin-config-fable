import PDFDocument from "pdfkit";
import { conditionLabel, deferLabel, melLabel } from "../domain/labels.ts";
import { isOverdue } from "../domain/observations.ts";
import { rulesNotUsedLine, timelineChange } from "../domain/report.ts";
import { aggregateStatus, type LocationStatus } from "../domain/status.ts";
import type { CabinLocation, CarriedObservation, Observation, Report, VisitEvent } from "../domain/types.ts";
import { formatDate, formatDateTime } from "../web/format.ts";

interface Column {
  header: string;
  width: number;
  align?: "left" | "right";
}

const MARGIN = 40;
const FOOTER_SPACE = 34;
const HEADER_SPACE = 30;
/**
 * A work item's notes, pending changes and rules not used, or an event note, longer than this is
 * printed once, in full, in a Notes section, so no table row can outgrow a page.
 */
const LONG_NOTE = 160;
/** A gap reason longer than this is printed in full in a Notes section after the gaps table. */
const LONG_GAP_REASON = 600;
/** pdfkit supports `scope` on a header cell; the bundled types do not list it yet. */
const COLUMN_SCOPE = { scope: "Column" } as NonNullable<Parameters<PDFKit.PDFDocument["struct"]>[1]>;

/** Standard PDF fonts are WinAnsi only; anything else is replaced so the document never fails. */
function safe(text: unknown): string {
  return (
    String(text ?? "")
      .replace(/[\u2192\u21d2]/g, "->")
      .replace(/[\u2011\u2010]/g, "-")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the allow-list deliberately names tab, LF and CR
      .replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026]/g, "?")
  );
}

/**
 * The cabin picture's fixed light colours and legend words, one per status a piece can show. The PDF stays light whatever
 * the screen theme, so these are not the screen's tokens. They differ in lightness as well as hue, and the legend and
 * the lists after the picture say the same in words.
 */
const PDF_STATUS: Readonly<Record<Exclude<LocationStatus, "alternate">, { fill: string; label: string }>> = {
  mustFix: { fill: "#c4005f", label: "Must be fixed before flight" },
  unresolved: { fill: "#1f2937", label: "Part not resolved" },
  deferred: { fill: "#e07000", label: "Deferred" },
  carried: { fill: "#7e22ce", label: "Carried over from an earlier visit" },
  noted: { fill: "#1d6fb8", label: "Noted only" },
  recorded: { fill: "#2e9e5b", label: "Replaced" },
  none: { fill: "#e8ebf2", label: "No change" },
};
const LEGEND_ORDER = ["mustFix", "unresolved", "deferred", "carried", "noted", "recorded", "none"] as const;
/** The picture's alt text counts pieces by these words, highest status first. */
const ALT_PHRASE: Partial<Record<LocationStatus, (n: number) => string>> = {
  mustFix: (n) => `${n} must be fixed`,
  unresolved: (n) => `${n} ${n === 1 ? "piece" : "pieces"} not resolved`,
  deferred: (n) => `${n} ${n === 1 ? "piece" : "pieces"} deferred`,
  carried: (n) => `${n} ${n === 1 ? "piece" : "pieces"} carried over`,
  noted: (n) => `${n} ${n === 1 ? "piece" : "pieces"} noted`,
  recorded: (n) => `${n} ${n === 1 ? "piece" : "pieces"} replaced`,
};
const FIGURE_ORDER: LocationStatus[] = ["mustFix", "unresolved", "deferred", "carried", "noted", "recorded"];

/** The pieces with a status, from the report's outcomes plus its unresolved components (as the screen does), highest status per piece. */
function pictureOutcomes(report: Report): { locationId: string; componentId: string; status: LocationStatus }[] {
  const byPiece = new Map<string, { locationId: string; componentId: string; status: LocationStatus }>();
  const add = (locationId: string, componentId: string, status: LocationStatus) => {
    const key = `${locationId}\u0000${componentId}`;
    const prior = byPiece.get(key);
    byPiece.set(key, { locationId, componentId, status: prior ? aggregateStatus([prior.status, status]) : status });
  };
  for (const g of report.gaps) for (const id of g.locationIds) add(id, g.componentId, "unresolved");
  for (const o of report.pieceOutcomes ?? []) add(o.locationId, o.componentId, o.status);
  return [...byPiece.values()];
}

/** The mark of a blocked seat on the picture and in its legend: a heavy outline and one diagonal. */
function blockedMark(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number): void {
  doc.lineWidth(1.1).strokeColor("#111827");
  doc.rect(x, y, w, h).stroke();
  doc
    .moveTo(x, y + h)
    .lineTo(x + w, y)
    .stroke();
}

/** "Cabin picture: 3 pieces deferred, 1 must be fixed, 1 seat blocked", in the order of FIGURE_ORDER, blocked seats last. */
function pictureAlt(outcomes: { status: LocationStatus }[], blockedSeats: number): string {
  const parts = FIGURE_ORDER.flatMap((status) => {
    const n = outcomes.filter((o) => o.status === status).length;
    const phrase = ALT_PHRASE[status];
    return n > 0 && phrase ? [phrase(n)] : [];
  });
  if (blockedSeats > 0) parts.push(`${blockedSeats} ${blockedSeats === 1 ? "seat" : "seats"} blocked`);
  return parts.length > 0 ? `Cabin picture: ${parts.join(", ")}` : "Cabin picture: no piece has an outcome in this check";
}

function sourceLabel(report: Report, id: string): string {
  const s = report.sources.find((x) => x.id === id);
  return s ? `${s.id} rev ${s.revision}` : id;
}

/**
 * Render a report to PDF. The PDF is produced only from the report JSON (the frozen basis),
 * so the printable and structured forms cannot drift apart.
 */
export function renderReportPdf(
  report: Report,
  linkedEvents: VisitEvent[] = [],
  basisSha256: string | null = null,
  /** The frozen snapshot's layout locations, which a report does not carry. Without them a v3 report prints no picture, only a notice. */
  layoutLocations: readonly CabinLocation[] | null = null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: MARGIN + HEADER_SPACE, bottom: MARGIN + FOOTER_SPACE, left: MARGIN, right: MARGIN },
      bufferPages: true,
      pdfVersion: "1.7",
      lang: "en-GB",
      displayTitle: true,
      tagged: true,
      info: {
        Title: `Cabin Kit report - visit ${report.visit.number} - ${report.visit.tail}`,
        Subject: "Fictional demonstration appearance-check report",
        Creator: "Cabin Kit replacement",
        CreationDate: new Date(report.generatedAt),
        ModDate: new Date(report.generatedAt),
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const width = doc.page.width - MARGIN * 2;
    const bottom = () => doc.page.height - MARGIN - FOOTER_SPACE;
    const ensure = (h: number) => {
      if (doc.y + h > bottom()) doc.addPage();
    };
    // Logical structure: everything meaningful sits under one Document element; rules, fills and the
    // page header and footer are artifacts so a screen reader skips them.
    const root = doc.struct("Document");
    doc.addStructure(root);
    const tagged = (type: string, draw: () => void) => {
      root.add(doc.struct(type, {}, draw));
    };
    const artifact = (type: "Layout" | "Pagination", draw: () => void) => {
      doc.markContent("Artifact", { type });
      draw();
      doc.endMarkedContent();
    };
    const heading = (text: string, level: "H1" | "H2" = "H2") => {
      ensure(40);
      doc.moveDown(0.6);
      tagged(level, () => {
        doc.font("Helvetica-Bold").fontSize(12).fillColor("#12264d").text(safe(text), MARGIN, doc.y, { width });
      });
      artifact("Layout", () => {
        doc
          .moveTo(MARGIN, doc.y + 2)
          .lineTo(MARGIN + width, doc.y + 2)
          .lineWidth(0.7)
          .strokeColor("#12264d")
          .stroke();
      });
      doc.moveDown(0.5).fillColor("#000000");
    };
    const para = (text: string, size = 9, font = "Helvetica") => {
      doc.font(font).fontSize(size);
      // A paragraph may be longer than a page, so only a first line has to fit before it starts.
      ensure(Math.min(doc.heightOfString(safe(text), { width }), doc.currentLineHeight() * 2) + 4);
      tagged("P", () => {
        doc.font(font).fontSize(size).text(safe(text), MARGIN, doc.y, { width });
      });
      doc.moveDown(0.3);
    };
    const pairs = (items: [string, string][]) => {
      const colW = width / 2;
      const labelW = 118;
      for (let i = 0; i < items.length; i += 2) {
        const row = items.slice(i, i + 2);
        doc.fontSize(9);
        const h = Math.max(...row.map(([, v]) => doc.font("Helvetica").heightOfString(safe(v), { width: colW - labelW - 8 }))) + 4;
        ensure(h);
        const y = doc.y;
        tagged("P", () => {
          row.forEach(([k, v], c) => {
            const x = MARGIN + c * colW;
            doc.font("Helvetica-Bold").fillColor("#444444").text(safe(k), x, y, { width: labelW });
            doc
              .font("Helvetica")
              .fillColor("#000000")
              .text(safe(v), x + labelW, y, { width: colW - labelW - 8 });
          });
        });
        doc.y = y + h;
      }
    };
    const table = (name: string, columns: Column[], rows: string[][], fontSize = 8) => {
      const pad = 3;
      const usable = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
      doc.font("Helvetica-Bold").fontSize(fontSize);
      const headerHeight = Math.max(...columns.map((c) => doc.heightOfString(safe(c.header), { width: c.width - pad * 2 }))) + pad * 2;
      ensure(40);
      const tbl = doc.struct("Table");
      root.add(tbl);
      const drawHeader = (repeat: boolean) => {
        const h = headerHeight;
        const y = doc.y;
        artifact("Layout", () => {
          doc.rect(MARGIN, y, width, h).fill("#e3e9f5");
        });
        const cell = (c: Column, x: number) => {
          doc
            .font("Helvetica-Bold")
            .fontSize(fontSize)
            .fillColor("#12264d")
            .text(safe(c.header), x + pad, y + pad, { width: c.width - pad * 2, align: c.align ?? "left" });
        };
        if (repeat) {
          // A header repeated after a page break is decoration; the real header row is read once.
          artifact("Pagination", () => {
            let x = MARGIN;
            for (const c of columns) {
              cell(c, x);
              x += c.width;
            }
          });
        } else {
          const tr = doc.struct("TR");
          tbl.add(tr);
          let x = MARGIN;
          for (const c of columns) {
            const cx = x;
            tr.add(doc.struct("TH", COLUMN_SCOPE, () => cell(c, cx)));
            x += c.width;
          }
          tr.end();
        }
        doc.fillColor("#000000");
        doc.y = y + h;
      };
      drawHeader(false);
      rows.forEach((row, index) => {
        doc.font("Helvetica").fontSize(fontSize);
        const cells = row.map((cell, i) => {
          const column = columns[i];
          if (!column) throw new Error(`invariant: table row has ${row.length} cells for ${columns.length} columns`);
          return { column, text: safe(cell) };
        });
        const h = Math.max(...cells.map(({ column, text }) => doc.heightOfString(text, { width: column.width - pad * 2 }))) + pad * 2;
        // After a page break the header is repeated above the row, so the row gets what is left below it.
        if (h > usable - headerHeight) throw new Error(`pdf: row taller than a page in ${name}`);
        if (doc.y + h > bottom()) {
          doc.addPage();
          drawHeader(true);
          doc.font("Helvetica").fontSize(fontSize);
        }
        const y = doc.y;
        if (index % 2 === 1) {
          artifact("Layout", () => {
            doc.rect(MARGIN, y, width, h).fill("#f6f8fc");
          });
        }
        const tr = doc.struct("TR");
        tbl.add(tr);
        let x = MARGIN;
        for (const { column, text } of cells) {
          const cx = x;
          tr.add(
            doc.struct("TD", {}, () => {
              doc
                .font("Helvetica")
                .fontSize(fontSize)
                .fillColor("#000000")
                .text(text, cx + pad, y + pad, { width: column.width - pad * 2, align: column.align ?? "left" });
            }),
          );
          x += column.width;
        }
        tr.end();
        artifact("Layout", () => {
          doc
            .moveTo(MARGIN, y + h)
            .lineTo(MARGIN + width, y + h)
            .lineWidth(0.3)
            .strokeColor("#c5cbd8")
            .stroke();
        });
        doc.y = y + h;
      });
      tbl.end();
      doc.moveDown(0.5);
    };

    /** Long notes are printed once in a Notes section; the table cell points at them. */
    const notes: { label: string; text: string }[] = [];
    const noteCell = (prefix: string, location: string, text: string, limit = LONG_NOTE): string => {
      if (text.length <= limit) return text;
      const label = `${prefix}${notes.length + 1}`;
      notes.push({ label, text: `${label}. ${location}: ${text}` });
      return `See note ${label}`;
    };
    const printNotes = (title: string) => {
      if (notes.length === 0) return;
      heading(title);
      for (const n of notes) para(n.text);
      notes.length = 0;
    };

    // Title block
    const final = report.reportKind === "FINAL";
    tagged("H1", () => {
      doc.font("Helvetica-Bold").fontSize(17).fillColor("#12264d").text("Cabin Kit after-action report", MARGIN, doc.y, { width });
    });
    tagged("P", () => {
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .fillColor(final ? "#1b6b3a" : "#a14a00")
        .text(final ? "FINAL - visit completed and locked" : "DRAFT PREVIEW - visit not completed; content may still change", MARGIN, doc.y, { width });
    });
    doc.moveDown(0.4);
    const notice = safe(report.authorityNotice);
    doc.font("Helvetica-Bold").fontSize(8);
    const noticeHeight = doc.heightOfString(notice, { width: width - 12 }) + 12;
    const noticeY = doc.y;
    artifact("Layout", () => {
      doc.rect(MARGIN, noticeY, width, noticeHeight).fill("#fff4d6");
    });
    tagged("P", () => {
      doc
        .fillColor("#5c4300")
        .font("Helvetica-Bold")
        .fontSize(8)
        .text(notice, MARGIN + 6, noticeY + 6, { width: width - 12 });
    });
    doc.fillColor("#000000");
    doc.y = noticeY + noticeHeight + 8;

    heading("Visit");
    pairs([
      ["Visit number", `#${report.visit.number}`],
      ["Status", report.visit.status],
      ["Tail", report.visit.tail],
      ["Appearance-check date", formatDate(report.visit.checkDate)],
      ["Technician", report.visit.technician || "(not entered)"],
      ["Report schema", report.schema],
      ["Created", formatDateTime(report.visit.createdAt)],
      ["Completed", report.visit.completedAt ? formatDateTime(report.visit.completedAt) : "not completed"],
      ["Report generated", formatDateTime(report.generatedAt)],
    ]);
    para(`Visit id: ${report.visit.id}`, 8);

    // After-action sections (report schema 3). A /1 or /2 report has none of these fields and prints as before.
    if (report.summary) {
      const sm = report.summary;
      heading("Summary");
      if (!sm.releasable) {
        tagged("P", () => {
          doc
            .font("Helvetica-Bold")
            .fontSize(10)
            .fillColor("#a11a4a")
            .text(sm.aircraftHeld ? "Not releasable: aircraft held" : "Not releasable: items must be fixed before flight", MARGIN, doc.y, { width });
        });
        doc.fillColor("#000000").moveDown(0.3);
      }
      pairs([
        ["Replaced", String(sm.replaced)],
        ["Noted", String(sm.noted)],
        ["Deferred, cosmetic", String(sm.deferredCosmetic)],
        ["Deferred under the MEL", String(sm.deferredMel)],
        ["Must be fixed", String(sm.mustFix)],
        ["Carried over in", String(sm.carriedIn)],
        ["Still open", String(sm.stillOpen)],
        ["Releasable", sm.releasable ? "Yes" : "No"],
        ["Aircraft held", sm.aircraftHeld ? "Yes" : "No"],
      ]);
    }

    if (report.pieceOutcomes) {
      const outcomes = pictureOutcomes(report);
      const places = layoutLocations ?? [];
      const seats = places.filter((l) => l.kind === "SEAT");
      const LABEL_W = 62;
      const SIDE_BIN_H = 9;
      const FLOOR_H = 7;
      const GAP = 4;
      const floors = places.filter((l) => l.kind === "FLOOR");
      if (seats.length === 0) {
        heading("Cabin picture");
        para("The cabin picture could not be drawn because the cabin layout was not available. The lists below are complete.");
      } else {
        const extent = places.filter((l) => l.kind !== "BIN");
        const minX = Math.min(...places.map((l) => l.placement.x - l.placement.lx / 2));
        const maxX = Math.max(...places.map((l) => l.placement.x + l.placement.lx / 2));
        const halfZ = Math.max(...extent.map((l) => Math.abs(l.placement.z) + l.placement.lz / 2));
        const scale = (width - LABEL_W) / (maxX - minX);
        const bodyH = halfZ * 2 * scale;
        const figureH = SIDE_BIN_H + GAP + bodyH + GAP + SIDE_BIN_H + GAP + floors.length * (FLOOR_H + 1);
        const legendRows = Math.ceil(LEGEND_ORDER.length / 2);
        // Heading, picture and legend stay together on one page.
        ensure(40 + figureH + 14 + legendRows * 13 + 24 + ((report.blockedSeats ?? []).length > 0 ? 19 : 0));
        heading("Cabin picture");
        para("Each location shows the highest status of its pieces at the end of this check. Left and right are as seen facing forward.", 8);
        const x0 = MARGIN + LABEL_W;
        const top = doc.y + 2;
        const rightBinsY = top;
        const bodyY = top + SIDE_BIN_H + GAP;
        const leftBinsY = bodyY + bodyH + GAP;
        const floorsY = leftBinsY + SIDE_BIN_H + GAP;
        const statusByLocation = new Map<string, LocationStatus[]>();
        for (const o of outcomes) statusByLocation.set(o.locationId, [...(statusByLocation.get(o.locationId) ?? []), o.status]);
        const fillOf = (id: string): string => {
          const status = aggregateStatus(statusByLocation.get(id) ?? []);
          return (PDF_STATUS[status as keyof typeof PDF_STATUS] ?? PDF_STATUS.none).fill;
        };
        const px = (l: CabinLocation) => x0 + (l.placement.x - l.placement.lx / 2 - minX) * scale;
        const pw = (l: CabinLocation) => l.placement.lx * scale;
        const blocked = new Set(report.blockedSeats ?? []);
        const alt = safe(pictureAlt(outcomes, seats.filter((l) => blocked.has(l.id)).length));
        root.add(
          doc.struct("Figure", { alt }, () => {
            doc.lineWidth(0.3).strokeColor("#9aa3b5");
            const draw = (xx: number, yy: number, w: number, h: number, fill: string) => {
              doc.rect(xx, yy, w, h).fillAndStroke(fill, "#9aa3b5");
            };
            // floor areas, one strip each below the cabin
            floors.forEach((l, i) => {
              draw(px(l), floorsY + i * (FLOOR_H + 1), pw(l), FLOOR_H, fillOf(l.id));
            });
            // bins: a strip each side of the cabin; the left side of the aircraft is at the bottom, facing forward
            for (const l of places.filter((p) => p.kind === "BIN")) {
              const left = l.bin?.side ? l.bin.side === "L" : l.placement.z > 0;
              draw(px(l), left ? leftBinsY : rightBinsY, pw(l), SIDE_BIN_H, fillOf(l.id));
            }
            for (const l of seats) {
              const w = Math.max(l.placement.lz * scale, 2);
              draw(px(l), bodyY + (halfZ + l.placement.z - l.placement.lz / 2) * scale, pw(l), w, fillOf(l.id));
            }
            // a blocked seat: a heavy outline and a diagonal across it, so it reads without colour
            for (const l of seats.filter((p) => blocked.has(p.id))) {
              const w = Math.max(l.placement.lz * scale, 2);
              blockedMark(doc, px(l), bodyY + (halfZ + l.placement.z - l.placement.lz / 2) * scale, pw(l), w);
            }
            doc.lineWidth(0.3).strokeColor("#9aa3b5");
            for (const l of places.filter((p) => p.kind === "ARMREST")) {
              const h = Math.max(l.placement.lz * scale, 1.6);
              draw(px(l), bodyY + (halfZ + l.placement.z) * scale - h / 2, pw(l), h, fillOf(l.id));
            }
          }),
        );
        // side labels are decoration: the alt text and the lists carry the meaning
        artifact("Layout", () => {
          doc.font("Helvetica").fontSize(6.5).fillColor("#444444");
          doc.text("Right bins", MARGIN, rightBinsY + 1, { width: LABEL_W - 6, lineBreak: false });
          doc.text("Forward", MARGIN, bodyY + bodyH / 2 - 8, { width: LABEL_W - 6, lineBreak: false });
          doc.text("end is at left", MARGIN, bodyY + bodyH / 2, { width: LABEL_W - 6, lineBreak: false });
          doc.text("Left bins", MARGIN, leftBinsY + 1, { width: LABEL_W - 6, lineBreak: false });
          if (floors.length > 0) doc.text("Floor areas", MARGIN, floorsY, { width: LABEL_W - 6, lineBreak: false });
          doc.fillColor("#000000");
        });
        doc.y = floorsY + floors.length * (FLOOR_H + 1) + 6;
        // legend: a swatch and its words, two columns
        const colW = width / 2;
        const legendTop = doc.y;
        LEGEND_ORDER.forEach((status, i) => {
          const lx = MARGIN + (i % 2) * colW;
          const ly = legendTop + Math.floor(i / 2) * 13;
          artifact("Layout", () => {
            doc.rect(lx, ly + 1, 9, 9).fillAndStroke(PDF_STATUS[status].fill, "#6b7488");
          });
          tagged("P", () => {
            doc
              .font("Helvetica")
              .fontSize(8.5)
              .fillColor("#000000")
              .text(safe(PDF_STATUS[status].label), lx + 14, ly + 1, { width: colW - 20, lineBreak: false });
          });
        });
        doc.y = legendTop + legendRows * 13 + 6;
        if (blocked.size > 0) {
          const ly = doc.y;
          artifact("Layout", () => {
            doc.rect(MARGIN, ly + 1, 9, 9).fillAndStroke(PDF_STATUS.none.fill, "#6b7488");
            blockedMark(doc, MARGIN, ly + 1, 9, 9);
          });
          tagged("P", () => {
            doc
              .font("Helvetica")
              .fontSize(8.5)
              .fillColor("#000000")
              .text("Blocked seat (outlined and crossed)", MARGIN + 14, ly + 1, { width: width - 20, lineBreak: false });
          });
          doc.y = ly + 13 + 6;
        }
      }
    }

    if (report.timeline) {
      heading("What happened, in order");
      if (report.timeline.length === 0) para("Nothing was recorded in this visit.");
      else {
        table(
          "what happened, in order",
          [
            { header: "When", width: 120 },
            { header: "What happened", width: width - 120 },
          ],
          // an update says what changed, before and after, in words
          report.timeline.map((t) => {
            const change = timelineChange(t);
            return [formatDateTime(t.at), noteCell("T", formatDateTime(t.at), change ? `${t.label}. ${change}` : t.label)];
          }),
        );
        printNotes("Notes on what happened");
      }
    }

    if (report.observations) {
      const checkDate = report.visit.checkDate;
      const problemRows = (items: { o: Observation; extra?: string }[], prefix: string): string[][] =>
        items.map(({ o, extra }) => {
          // a closed problem's class and dates no longer apply: only what it was and how it was closed
          const open = o.status === "OPEN";
          const due = open && o.dueDate ? `${isOverdue(o.dueDate, checkDate) ? "Overdue since" : "Fix by"} ${formatDate(o.dueDate)}` : "";
          const facts = [
            // the class on the check date; a report stored before it was recorded falls back to the stored class
            open && o.outcome !== "NOTED" ? melLabel(report.observations?.classes?.[o.id] ?? o.melClass) : "",
            open && o.outcome === "DEFERRED" && o.deferUntil ? deferLabel(o.deferUntil) : "",
            due,
            extra ?? "",
            o.note ? `Note: ${o.note}` : "",
          ].filter((f) => f !== "");
          const where = `${o.locationLabel} / ${o.componentName}`;
          return [o.locationLabel, o.componentName, conditionLabel(o.condition), noteCell(prefix, where, facts.join(". "))];
        });
      const list = (title: string, prefix: string, items: { o: Observation; extra?: string }[]) => {
        heading(`${title} (${items.length})`);
        if (items.length === 0) {
          para("None.");
          return;
        }
        table(
          title.toLowerCase(),
          [
            { header: "Location", width: 90 },
            { header: "Piece", width: 100 },
            { header: "Condition", width: 62 },
            { header: "Details", width: width - 252 },
          ],
          problemRows(items, prefix),
        );
        printNotes(`Notes on ${title.toLowerCase()}`);
      };
      const ob = report.observations;
      const CARRIED_MUST_FIX = "Carried over from an earlier check";
      const carriedExtra = (c: CarriedObservation) =>
        `Opened in an earlier visit${c.placement === "ORPHANED" ? "; its position is not in this layout" : c.placement === "MAPPED" ? "; mapped to this layout" : ""}`;
      list(
        "Deferred",
        "D",
        ob.deferred.map((o) => ({ o })),
      );
      list(
        "Must be fixed",
        "F",
        // a carried problem that is must-fix now is listed here, not under "Carried over in" (R43)
        ob.mustFix.map((o) => ({ o, ...(o.openedInVisitId !== report.visit.id ? { extra: CARRIED_MUST_FIX } : {}) })),
      );
      list(
        "Noted",
        "N",
        ob.noted.map((o) => ({ o })),
      );
      list(
        "Closed this check",
        "C",
        ob.closed.map((o) => ({ o, extra: o.closedAs === "REPLACED" ? "Closed as replaced" : "Closed as fixed" })),
      );
      list(
        "Carried over in",
        "O",
        ob.carriedIn.map((c) => ({ o: c.observation, extra: carriedExtra(c) })),
      );
      list(
        "Still open",
        "S",
        ob.stillOpen.map((o) => ({ o })),
      );
    }

    heading("Frozen configuration at visit creation");
    const c = report.configuration;
    pairs([
      ["Data namespace", `${c.namespace} (fictional fixture)`],
      ["Lookup state", c.lookupState],
      ["Subtype", c.subtype],
      ["Maintenance variant", `${c.variantId} - ${c.variantName}`],
      ["Seat hardware", c.hardware ?? "not stated"],
      ["Layout revision", c.layoutRevisionId],
      ["Layout", `${c.layoutName} (${c.seatCount} seats)`],
      ["Carpet / seam", `${c.carpet ?? "not stated"} / ${c.seam ?? "not stated"}`],
      ["Upholstery profile", c.upholstery ?? "not stated"],
      [
        "Assignment effective",
        `${formatDate(c.assignmentEffectiveFrom)} to ${c.assignmentEffectiveTo ? formatDate(c.assignmentEffectiveTo) : "open"} (inclusive)`,
      ],
      ["Configuration source", sourceLabel(report, c.configurationSourceId)],
      ["Reference release", c.referenceReleaseId],
      ["Geometry reference", c.geometryVersion],
      ["Snapshot captured", formatDateTime(c.capturedAt)],
    ]);
    para(`Snapshot SHA-256: ${c.snapshotSha256}`, 7);
    if (basisSha256) para(`Report basis SHA-256: ${basisSha256}`, 7);

    heading(`Aggregate part totals (${report.totals.length} part/unit lines)`);
    if (report.totals.length === 0) para("No replacements recorded.");
    else {
      table(
        "aggregate part totals",
        [
          { header: "Part number", width: 110 },
          { header: "Description", width: 150 },
          { header: "Total", width: 40, align: "right" },
          { header: "Unit", width: 42 },
          { header: "Role", width: 70 },
          { header: "Locations (qty)", width: width - 412 },
        ],
        report.totals.map((t) => [
          t.partNo,
          t.description,
          String(t.quantity),
          t.unit,
          t.roles.map((r) => (r === "MANDATORY_CHILD" ? "Required supplement" : r === "ALTERNATE" ? "Alternate" : "Primary")).join(", "),
          t.locations.map((l) => `${l.locationLabel} / ${l.componentId} (${l.quantity})`).join("; "),
        ]),
      );
      para(`Totals are grouped by part number and unit. ${report.replacementCountSemantics}`, 7);
    }

    heading(`Work recorded by location (${report.work.length} records, ${report.counts.replacements} replacements)`);
    if (report.work.length === 0) para("No replacements recorded.");
    else {
      table(
        "work recorded by location",
        [
          { header: "Location", width: 88 },
          { header: "Component", width: 72 },
          { header: "Selection", width: 112 },
          { header: "Repl.", width: 28, align: "right" },
          { header: "Parts used (qty unit)", width: 128 },
          { header: "Sources, notes and advisories", width: width - 428 },
        ],
        report.work.map((w) => [
          w.locationLabel,
          w.componentName,
          w.selection === "ALTERNATE" ? `ALTERNATE\n${w.selectedPartNo}\n(replaces primary\n${w.primaryPartNo})` : `PRIMARY\n${w.selectedPartNo}`,
          String(w.replacements),
          w.lines.map((l) => `${l.partNo} ${l.qty} ${l.unit}${l.role === "MANDATORY_CHILD" ? " (required)" : ""}`).join("\n"),
          [
            ...new Set([sourceLabel(report, w.ruleSourceId), sourceLabel(report, w.selectionSourceId)]),
            // the note, pending changes and rules not used stay in the cell while short, else move to Notes together
            noteCell(
              "",
              `${w.locationLabel} / ${w.componentId}`,
              [w.note ? `Note: ${w.note}` : "", ...w.pendingChanges.map((p) => `Pending change: ${p.note}`), rulesNotUsedLine(w.excludedRules) ?? ""]
                .filter(Boolean)
                .join("\n"),
            ),
          ]
            .filter(Boolean)
            .join("\n"),
        ]),
      );
    }

    printNotes("Notes");

    heading(`Unresolved applicability gaps (${report.counts.unresolvedComponents} components)`);
    if (report.gaps.length === 0) para("None. Every component in the frozen configuration had one applicable primary part.");
    else {
      table(
        "unresolved applicability gaps",
        [
          { header: "Component", width: 80 },
          { header: "Status", width: 62 },
          { header: "Locations", width: 170 },
          { header: "Reason", width: width - 312 },
        ],
        report.gaps.map((g) => [
          g.componentId,
          g.status === "NO_MATCH" ? "No match" : "Ambiguous",
          g.locationSummary,
          noteCell("G", `${g.componentId} at ${g.locationSummary}`, g.message, LONG_GAP_REASON),
        ]),
      );
      para("Unresolved components could not be recorded on this visit.", 7);
      printNotes("Notes on unresolved gaps");
    }

    heading("Sources, revisions and validity");
    table(
      "sources, revisions and validity",
      [
        { header: "Source", width: 92 },
        { header: "Rev", width: 44 },
        { header: "Type", width: 70 },
        { header: "Title", width: 150 },
        { header: "Released", width: 46 },
        { header: "Effective / expires (inclusive)", width: width - 402 },
      ],
      report.sources.map((s) => [
        s.id,
        s.revision,
        s.kind,
        s.title,
        s.released ? "yes" : "NO",
        `${s.effectiveFrom ? formatDate(s.effectiveFrom) : "not stated"} / ${s.expiresOn ? formatDate(s.expiresOn) : "no expiry"}`,
      ]),
    );
    para(report.dateRule, 7);

    if (linkedEvents.length > 0) {
      heading("Linked advisories and corrections (added after the fact)");
      table(
        "linked advisories and corrections",
        [
          { header: "When", width: 120 },
          { header: "Type", width: 90 },
          { header: "By", width: 80 },
          { header: "Note", width: width - 290 },
        ],
        linkedEvents.map((e) => [
          formatDateTime(e.at),
          e.type,
          String(e.payload.author ?? ""),
          noteCell("E", `${formatDateTime(e.at)} / ${e.type}`, String(e.payload.note ?? "")),
        ]),
      );
      printNotes("Notes on linked advisories and corrections");
      para("Linked events do not alter the locked report content above.", 7);
    }

    // header and footer on every page
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const savedBottom = doc.page.margins.bottom;
      const savedTop = doc.page.margins.top;
      doc.page.margins.bottom = 0;
      doc.page.margins.top = 0;
      artifact("Pagination", () => {
        doc.font("Helvetica").fontSize(7.5).fillColor("#555555");
        doc.text(
          safe(
            `Cabin Kit report | Visit #${report.visit.number} | ${report.visit.tail} | ${formatDate(report.visit.checkDate)} | ${final ? "FINAL" : "DRAFT PREVIEW"}`,
          ),
          MARGIN,
          MARGIN - 6,
          { width, lineBreak: false },
        );
        doc
          .moveTo(MARGIN, MARGIN + 6)
          .lineTo(MARGIN + width, MARGIN + 6)
          .lineWidth(0.4)
          .strokeColor("#999999")
          .stroke();
        const fy = doc.page.height - MARGIN - 14;
        doc
          .moveTo(MARGIN, fy - 4)
          .lineTo(MARGIN + width, fy - 4)
          .lineWidth(0.4)
          .strokeColor("#999999")
          .stroke();
        doc.text("FICTIONAL DEMONSTRATION - not an approved maintenance record", MARGIN, fy, { width: width - 90, lineBreak: false });
        doc.text(`Page ${i + 1} of ${range.count}`, MARGIN + width - 90, fy, { width: 90, align: "right", lineBreak: false });
      });
      doc.page.margins.bottom = savedBottom;
      doc.page.margins.top = savedTop;
    }
    doc.end();
  });
}
