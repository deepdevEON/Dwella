/**
 * StrategySerializer — save / load / import / export of visual strategies.
 *
 * Strategies are stored as versioned JSON. `deserialize` runs migrations so an
 * older file format is upgraded to the current schema before use. Files round-trip
 * through a file download / file input for sharing.
 */

import type { StrategyGraph, StrategyBlock } from "./types";
import { createEmptyGraph } from "./editor";

export const CURRENT_VERSION = 1;

export const STRATEGY_FILE_EXT = "dwstrat";

interface SerializedFile {
  format: "dwella-strategy";
  version: number;
  exportedAt: string;
  graph: StrategyGraph;
}

/** Stable JSON string for saving / sending. */
export function serializeStrategy(graph: StrategyGraph): string {
  const file: SerializedFile = {
    format: "dwella-strategy",
    version: CURRENT_VERSION,
    exportedAt: new Date().toISOString(),
    graph: { ...graph, version: CURRENT_VERSION },
  };
  return JSON.stringify(file, null, 2);
}

/** Parse + migrate a serialized strategy. Throws on structurally invalid input. */
export function deserializeStrategy(text: string): StrategyGraph {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("File is not valid JSON.");
  }
  return migrate(raw);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function migrate(raw: unknown): StrategyGraph {
  // Accept either a wrapped file or a bare graph.
  const root = isObject(raw) && (raw as Record<string, unknown>).format === "dwella-strategy"
    ? (raw as Record<string, unknown>).graph
    : raw;

  if (!isObject(root)) throw new Error("Unrecognized strategy file.");

  const version = typeof root.version === "number" ? root.version : 1;
  let graph: StrategyGraph = {
    ...createEmptyGraph(),
    ...(root as unknown as StrategyGraph),
  };

  if (version < CURRENT_VERSION) {
    graph = runMigrations(graph, version);
  }

  // Normalize required fields.
  graph.version = CURRENT_VERSION;
  graph.name = typeof graph.name === "string" && graph.name ? graph.name : "Imported Strategy";
  graph.blocks = Array.isArray(graph.blocks) ? graph.blocks.map(normalizeBlock) : [];
  graph.connections = Array.isArray(graph.connections)
    ? (graph.connections as unknown as StrategyGraph["connections"]).filter(
        (c) => c && typeof c.from === "string" && typeof c.to === "string",
      )
    : [];

  // Drop connections that reference missing blocks.
  const ids = new Set(graph.blocks.map((b) => b.id));
  graph.connections = graph.connections.filter((c) => ids.has(c.from) && ids.has(c.to));

  return graph;
}

function runMigrations(graph: StrategyGraph, from: number): StrategyGraph {
  let g = graph;
  // Future migrations go here, e.g. if (from < 2) g = migrateV1toV2(g);
  if (from < 1) {
    // Baseline: nothing to do yet.
  }
  return g;
}

function normalizeBlock(b: StrategyBlock): StrategyBlock {
  return {
    ...b,
    id: typeof b.id === "string" ? b.id : `b${Math.random().toString(36).slice(2)}`,
    type: b.type,
    x: typeof b.x === "number" ? b.x : 0,
    y: typeof b.y === "number" ? b.y : 0,
    indicatorParams: b.indicatorParams ?? {},
  };
}

/* ── Browser file I/O ──────────────────────────────────────────────────── */

export function downloadStrategy(graph: StrategyGraph): void {
  if (typeof document === "undefined") return;
  const text = serializeStrategy(graph);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safe = graph.name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "strategy";
  a.href = url;
  a.download = `${safe}.${STRATEGY_FILE_EXT}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function readStrategyFile(file: File): Promise<StrategyGraph> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(deserializeStrategy(String(reader.result)));
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Failed to read strategy."));
      }
    };
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsText(file);
  });
}

export function pickStrategyFile(): Promise<StrategyGraph | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(null);
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `.${STRATEGY_FILE_EXT}.json,application/json,.json`;
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return resolve(null);
      readStrategyFile(f).then(resolve).catch(() => resolve(null));
    };
    input.click();
  });
}
