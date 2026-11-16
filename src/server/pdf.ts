import PDFDocument from "pdfkit";
import type { Report, VisitEvent } from "../domain/types.ts";

interface Column {
  header: string;
  width: number;
  align?: "left" | "right";
}

const MARGIN = 40;
const FOOTER_SPACE = 34;
const HEADER_SPACE = 30;
/** A work-item or event note longer than this is printed once, in full, in a Notes section. */
const LONG_NOTE = 160;
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

function sourceLabel(report: Report, id: string): string {
  const s = report.sources.find((x) => x.id === id);
  return s ? `${s.id} rev ${s.revision}` : id;
}

/**
 * Render a report to PDF. The PDF is produced only from the report JSON (the frozen basis),
 * so the printable and structured forms cannot drift apart.
 */
export function renderReportPdf(report: Report, linkedEvents: VisitEvent[] = [], basisSha256: string | null = null): Promise<Buffer> {
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
      ensure(40);
      const tbl = doc.struct("Table");
      root.add(tbl);
      const drawHeader = (repeat: boolean) => {
        doc.font("Helvetica-Bold").fontSize(fontSize);
        const h = Math.max(...columns.map((c) => doc.heightOfString(safe(c.header), { width: c.width - pad * 2 }))) + pad * 2;
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
        if (h > usable) throw new Error(`pdf: row taller than a page in ${name}`);
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
    const noteCell = (prefix: string, location: string, text: string): string => {
      if (text.length <= LONG_NOTE) return text;
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
      ["Appearance-check date", report.visit.checkDate],
      ["Technician", report.visit.technician || "(not entered)"],
      ["Report schema", report.schema],
      ["Created (UTC)", report.visit.createdAt],
      ["Completed (UTC)", report.visit.completedAt ?? "not completed"],
      ["Report generated (UTC)", report.generatedAt],
    ]);
    para(`Visit id: ${report.visit.id}`, 8);

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
      ["Assignment effective", `${c.assignmentEffectiveFrom} to ${c.assignmentEffectiveTo ?? "open"} (inclusive)`],
      ["Configuration source", sourceLabel(report, c.configurationSourceId)],
      ["Reference release", c.referenceReleaseId],
      ["Geometry reference", c.geometryVersion],
      ["Snapshot captured (UTC)", c.capturedAt],
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
            w.note ? (w.note.length > LONG_NOTE ? noteCell("", `${w.locationLabel} / ${w.componentId}`, w.note) : `Note: ${w.note}`) : "",
            ...w.pendingChanges.map((p) => `Pending change: ${p.note}`),
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
        report.gaps.map((g) => [g.componentId, g.status === "NO_MATCH" ? "No match" : "Ambiguous", g.locationSummary, g.message]),
      );
      para("Unresolved components could not be recorded on this visit.", 7);
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
        `${s.effectiveFrom ?? "not stated"} / ${s.expiresOn ?? "no expiry"}`,
      ]),
    );
    para(report.dateRule, 7);

    if (linkedEvents.length > 0) {
      heading("Linked advisories and corrections (added after the fact)");
      table(
        "linked advisories and corrections",
        [
          { header: "When (UTC)", width: 120 },
          { header: "Type", width: 90 },
          { header: "By", width: 80 },
          { header: "Note", width: width - 290 },
        ],
        linkedEvents.map((e) => [e.at, e.type, String(e.payload.author ?? ""), noteCell("E", `${e.at} / ${e.type}`, String(e.payload.note ?? ""))]),
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
          safe(`Cabin Kit report | Visit #${report.visit.number} | ${report.visit.tail} | ${report.visit.checkDate} | ${final ? "FINAL" : "DRAFT PREVIEW"}`),
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
