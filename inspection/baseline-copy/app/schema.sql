PRAGMA foreign_keys=ON;
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE aircraft (tail TEXT PRIMARY KEY, subfleet TEXT NOT NULL, etops INTEGER NOT NULL);
CREATE TABLE variant (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, subfleet TEXT NOT NULL, seat_mfr TEXT,
 elr TEXT, layout TEXT, power INTEGER, cabin_height TEXT, status TEXT NOT NULL,
 released INTEGER NOT NULL, seats TEXT NOT NULL
);
CREATE TABLE source_doc (
 id TEXT PRIMARY KEY, type TEXT NOT NULL, rev TEXT NOT NULL, title TEXT NOT NULL,
 owner TEXT NOT NULL, eff_from TEXT NOT NULL, expires TEXT,
 CHECK(expires IS NULL OR expires>=eff_from)
);
CREATE TABLE tail_config (
 id INTEGER PRIMARY KEY, tail TEXT NOT NULL REFERENCES aircraft,
 variant_id TEXT NOT NULL REFERENCES variant, carpet TEXT, seam TEXT, cabin_height TEXT,
 eff_from TEXT NOT NULL, eff_to TEXT, doc_id TEXT NOT NULL REFERENCES source_doc,
 CHECK(eff_to IS NULL OR eff_to>=eff_from)
);
CREATE INDEX config_lookup ON tail_config(tail,eff_from,eff_to);
CREATE TABLE position (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, category TEXT NOT NULL, zone TEXT NOT NULL,
 component TEXT NOT NULL, row_from INTEGER, row_to INTEGER, side TEXT, seat_pos TEXT,
 exit_row INTEGER NOT NULL DEFAULT 0, seat_group TEXT, panel_loc TEXT
);
CREATE TABLE variant_position (
 variant_id TEXT NOT NULL REFERENCES variant, position_id TEXT NOT NULL REFERENCES position,
 PRIMARY KEY(variant_id,position_id)
);
CREATE TABLE part_rule (
 id TEXT PRIMARY KEY, position_id TEXT NOT NULL REFERENCES position, selectors TEXT NOT NULL,
 part_no TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty>0), unit TEXT NOT NULL,
 eff_from TEXT NOT NULL, eff_to TEXT, pending_change INTEGER NOT NULL DEFAULT 0,
 change_note TEXT, doc_id TEXT NOT NULL REFERENCES source_doc,
 CHECK(eff_to IS NULL OR eff_to>=eff_from)
);
CREATE TABLE substitute (
 id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES part_rule, alt_part_no TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>0), unit TEXT NOT NULL, eff_from TEXT NOT NULL, eff_to TEXT,
 doc_id TEXT NOT NULL REFERENCES source_doc, CHECK(eff_to IS NULL OR eff_to>=eff_from)
);
CREATE TABLE substitute_panel (
 substitute_id TEXT NOT NULL REFERENCES substitute, part_no TEXT NOT NULL,
 qty INTEGER NOT NULL CHECK(qty>0), PRIMARY KEY(substitute_id,part_no)
);
