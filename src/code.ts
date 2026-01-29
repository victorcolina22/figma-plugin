type DsMode = "remote" | "keylist" | "nameprefix";

type TokenRule = { prefix: string; category: string };

type Settings = {
  dsMode: DsMode;
  dsKeys: string[];
  dsPrefix: string; // e.g. DS/
  tokenRules: TokenRule[];
};

type TopItem = { id: string; name: string; count: number };

type FlowCoverage = {
  flowId: string;
  flowName: string;
  flowType: "FRAME" | "SECTION" | "OTHER";
  totalLayers: number;
  instances: number;
  detached: number;
  dsInstances: number;
  localInstances: number;
};

type OverridesAgg = {
  totalInstancesWithOverrides: number;
  byType: Record<string, number>;
};

type VariablesAgg = {
  nodesWithAnyBinding: number;
  totalNodesChecked: number;
  byProperty: Record<string, { boundNodes: number; totalNodes: number }>;
  topVariables: TopItem[];
  byCollection: Record<string, number>;
  correctUsage: {
    ok: number;
    wrong: number;
    unknown: number;
    wrongExamples: Array<{
      variableName: string;
      categoryExpected: string;
      reason: string;
    }>;
  };
};

type ResultPayload = {
  generatedAt: string;
  scope: "selection" | "page";
  summary: {
    totalLayers: number;
    totalInstances: number;
    percentLayersInstances: number;

    dsInstances: number;
    localInstances: number;
    percentInstancesFromDs: number;

    detachedInstances: number;
    percentDetached: number;

    flows: FlowCoverage[];

    topComponentsByKey: TopItem[];
    topComponentsByName: TopItem[];

    overrides: OverridesAgg;
    variables: VariablesAgg;
  };
  raw: {
    componentCountsByKey: Record<string, number>;
    componentCountsByName: Record<string, number>;
    variableCountsById: Record<string, number>;
  };
};

figma.showUI(__html__, { width: 360, height: 560 });

figma.ui.onmessage = async (msg: any) => {
  try {
    if (msg.type === "RUN") {
      const settings: Settings = msg.settings;
      const payload = await runAudit(settings);
      figma.ui.postMessage({ type: "RESULT", payload });
      return;
    }

    if (msg.type === "EXPORT_JSON") {
      const json = JSON.stringify(msg.payload, null, 2);
      figma.ui.postMessage({ type: "INFO", message: "Preparing JSON…" });
      figma
        .exportAsync(
          figma.createNodeFromSvg(
            `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
          ),
          { format: "SVG" },
        )
        .catch(() => {});
      // Use "download" via UI? In plugins we can’t directly download; we can use showUI + copy to clipboard.
      await figma.clipboard.writeTextAsync(json);
      figma.notify("JSON copied to clipboard ✅");
      return;
    }

    if (msg.type === "EXPORT_CSV") {
      const csv = makeCsv(msg.payload as ResultPayload);
      await figma.clipboard.writeTextAsync(csv);
      figma.notify("CSV copied to clipboard ✅");
      return;
    }
  } catch (e: any) {
    figma.ui.postMessage({ type: "ERROR", message: e?.message ?? String(e) });
  }
};

function isLayerLike(node: SceneNode): boolean {
  // “layers” for KPI = any SceneNode except Page/Document
  return true;
}

function isFlowRoot(node: SceneNode): node is FrameNode | SectionNode {
  return node.type === "FRAME" || node.type === "SECTION";
}

function getScopeRoots(): {
  scope: "selection" | "page";
  roots: readonly SceneNode[];
} {
  const sel = figma.currentPage.selection;
  if (sel && sel.length > 0) return { scope: "selection", roots: sel };
  return { scope: "page", roots: figma.currentPage.children };
}

function safeName(node: BaseNode): string {
  return (node as any).name || node.type;
}

function instanceMainComponent(instance: InstanceNode): ComponentNode | null {
  try {
    // mainComponent exists for instances
    return instance.mainComponent ?? null;
  } catch {
    return null;
  }
}

function componentKeyFromInstance(instance: InstanceNode): string | null {
  const mc = instanceMainComponent(instance);
  return mc?.key ?? null;
}

function isDetachedInstance(node: SceneNode): boolean {
  // Detached instances become normal groups/frames/etc., so:
  // - If user expects “detached instances”, we detect "instances whose mainComponent is null" is not possible
  //   because a true detached is no longer an InstanceNode.
  // BUT: in adoption audits, “detached instance” often means: InstanceNode with broken link.
  // Figma does not expose a reliable “broken link” flag for all cases; we approximate:
  // - treat nodes that were “instance-like” cannot be found. Not possible.
  // So: we'll compute detached as:
  // - InstanceNode where mainComponent is null (rare) OR
  // - node.type !== INSTANCE but has pluginData marker (optional). Not set here.
  // Practical compromise: count only instances with mainComponent == null.
  return (
    node.type === "INSTANCE" &&
    instanceMainComponent(node as InstanceNode) === null
  );
}

function isDsInstance(instance: InstanceNode, settings: Settings): boolean {
  const mc = instanceMainComponent(instance);
  const key = mc?.key;
  const name = mc?.name ?? "";

  if (settings.dsMode === "remote") {
    // Heuristic: library components are usually remote=true
    // (Local components in the same file usually remote=false)
    return (mc as any)?.remote === true;
  }

  if (settings.dsMode === "keylist") {
    if (!key) return false;
    return settings.dsKeys.includes(key);
  }

  // nameprefix
  return name.startsWith(settings.dsPrefix);
}

function traverse(root: SceneNode, fn: (node: SceneNode) => void) {
  fn(root);
  if ("children" in root) {
    for (const c of root.children) traverse(c, fn);
  }
}

async function runAudit(settings: Settings): Promise<ResultPayload> {
  const { scope, roots } = getScopeRoots();

  let totalLayers = 0;
  let totalInstances = 0;
  let dsInstances = 0;
  let localInstances = 0;

  let detachedInstances = 0;

  const componentCountsByKey: Record<string, number> = {};
  const componentCountsByName: Record<string, number> = {};

  const overridesAgg: OverridesAgg = {
    totalInstancesWithOverrides: 0,
    byType: {},
  };

  // Variables
  const variableCountsById: Record<string, number> = {};
  const variablesAgg: VariablesAgg = {
    nodesWithAnyBinding: 0,
    totalNodesChecked: 0,
    byProperty: {},
    topVariables: [],
    byCollection: {},
    correctUsage: { ok: 0, wrong: 0, unknown: 0, wrongExamples: [] },
  };

  // Coverage per flow
  const flowMap = new Map<string, FlowCoverage>();

  // Identify flow roots (frames/sections) inside the scanned scope
  const flowRoots: SceneNode[] = [];
  for (const r of roots) {
    traverse(r, (n) => {
      if (isFlowRoot(n)) flowRoots.push(n);
    });
  }
  // If no frames/sections found, treat each selected root as a "flow" bucket
  const coverageRoots = flowRoots.length > 0 ? flowRoots : [...roots];

  for (const fr of coverageRoots) {
    flowMap.set(fr.id, {
      flowId: fr.id,
      flowName: safeName(fr),
      flowType: isFlowRoot(fr) ? fr.type : "OTHER",
      totalLayers: 0,
      instances: 0,
      detached: 0,
      dsInstances: 0,
      localInstances: 0,
    });
  }

  // Scan
  for (const r of roots) {
    traverse(r, (node) => {
      if (!isLayerLike(node)) return;

      totalLayers += 1;

      // Variables bindings
      collectVariableBindings(node, settings, variableCountsById, variablesAgg);

      if (node.type === "INSTANCE") {
        totalInstances += 1;

        const inst = node as InstanceNode;

        const key = componentKeyFromInstance(inst);
        const mc = instanceMainComponent(inst);
        const compName = mc?.name ?? "(unknown main component)";

        if (key)
          componentCountsByKey[key] = (componentCountsByKey[key] ?? 0) + 1;
        componentCountsByName[compName] =
          (componentCountsByName[compName] ?? 0) + 1;

        const isDs = isDsInstance(inst, settings);
        if (isDs) dsInstances += 1;
        else localInstances += 1;

        // Detached heuristic
        if (isDetachedInstance(node)) detachedInstances += 1;

        // Overrides heuristic
        collectOverrides(inst, overridesAgg);

        // Coverage bucket: assign to nearest flow root ancestor among coverageRoots
        const flow = nearestCoverageRoot(node, coverageRoots);
        if (flow) {
          const rec = flowMap.get(flow.id);
          if (rec) {
            rec.instances += 1;
            if (isDs) rec.dsInstances += 1;
            else rec.localInstances += 1;
            if (isDetachedInstance(node)) rec.detached += 1;
          }
        }
      }

      // Total layers per flow bucket
      const flow = nearestCoverageRoot(node, coverageRoots);
      if (flow) {
        const rec = flowMap.get(flow.id);
        if (rec) rec.totalLayers += 1;
      }
    });
  }

  const flows = [...flowMap.values()].sort((a, b) => b.instances - a.instances);

  const topComponentsByKey = toTopList(componentCountsByKey, (id) => id, 15);
  const topComponentsByName = toTopList(componentCountsByName, (id) => id, 15);

  // Resolve variable names/collections for top variables
  await finalizeVariablesAgg(variableCountsById, variablesAgg, 15);

  const percentLayersInstances =
    totalLayers > 0 ? (totalInstances / totalLayers) * 100 : 0;
  const percentInstancesFromDs =
    totalInstances > 0 ? (dsInstances / totalInstances) * 100 : 0;
  const percentDetached =
    totalInstances > 0 ? (detachedInstances / totalInstances) * 100 : 0;

  return {
    generatedAt: new Date().toISOString(),
    scope,
    summary: {
      totalLayers,
      totalInstances,
      percentLayersInstances,

      dsInstances,
      localInstances,
      percentInstancesFromDs,

      detachedInstances,
      percentDetached,

      flows,
      topComponentsByKey,
      topComponentsByName,
      overrides: overridesAgg,
      variables: variablesAgg,
    },
    raw: {
      componentCountsByKey,
      componentCountsByName,
      variableCountsById,
    },
  };
}

function nearestCoverageRoot(
  node: SceneNode,
  coverageRoots: SceneNode[],
): SceneNode | null {
  // Find first ancestor (including itself) that is in coverageRoots
  const set = new Set(coverageRoots.map((n) => n.id));
  let cur: BaseNode | null = node;
  while (cur) {
    if ("id" in cur && set.has((cur as any).id)) return cur as any;
    cur = cur.parent;
  }
  return null;
}

function toTopList(
  map: Record<string, number>,
  nameFn: (id: string) => string,
  limit: number,
): TopItem[] {
  return Object.entries(map)
    .map(([id, count]) => ({ id, name: nameFn(id), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function inc(obj: Record<string, number>, key: string, by = 1) {
  obj[key] = (obj[key] ?? 0) + by;
}

function collectOverrides(inst: InstanceNode, agg: OverridesAgg) {
  // Figma exposes "overrides" on instances in many cases.
  // We classify types: TEXT, FILL, STROKE, EFFECT, LAYOUT, VISIBILITY, OTHER
  const anyInst: any = inst as any;
  const overrides = anyInst.overrides as any[] | undefined;

  if (!overrides || overrides.length === 0) return;

  agg.totalInstancesWithOverrides += 1;

  for (const o of overrides) {
    // o may have: id, overriddenFields, etc.
    const fields: string[] = (o?.overriddenFields ??
      o?.fields ??
      []) as string[];
    if (!fields || fields.length === 0) {
      inc(agg.byType, "OTHER", 1);
      continue;
    }
    for (const f of fields) {
      const t = classifyOverrideField(String(f));
      inc(agg.byType, t, 1);
    }
  }
}

function classifyOverrideField(field: string): string {
  const f = field.toLowerCase();
  if (f.includes("characters") || f.includes("text")) return "TEXT";
  if (f.includes("fills")) return "FILL";
  if (f.includes("strokes")) return "STROKE";
  if (f.includes("effects")) return "EFFECT";
  if (
    f.includes("layout") ||
    f.includes("constraints") ||
    f.includes("padding") ||
    f.includes("itemspacing")
  )
    return "LAYOUT";
  if (f.includes("visible") || f.includes("opacity")) return "VISIBILITY";
  if (f.includes("corner") || f.includes("radius")) return "RADIUS";
  if (f.includes("font") || f.includes("typography") || f.includes("textstyle"))
    return "TYPOGRAPHY";
  return "OTHER";
}

function collectVariableBindings(
  node: SceneNode,
  settings: Settings,
  variableCountsById: Record<string, number>,
  variablesAgg: VariablesAgg,
) {
  // Many nodes support boundVariables: Record<string, VariableAlias | VariableAlias[]>
  const anyNode: any = node as any;
  const bound = anyNode.boundVariables as Record<string, any> | undefined;

  variablesAgg.totalNodesChecked += 1;

  if (!bound) return;

  let any = false;

  for (const prop of Object.keys(bound)) {
    const aliases = bound[prop];
    const ids: string[] = [];

    if (Array.isArray(aliases)) {
      for (const a of aliases) if (a?.id) ids.push(String(a.id));
    } else if (aliases?.id) {
      ids.push(String(aliases.id));
    }

    // Track per-property coverage
    if (!variablesAgg.byProperty[prop])
      variablesAgg.byProperty[prop] = { boundNodes: 0, totalNodes: 0 };
    variablesAgg.byProperty[prop].totalNodes += 1;

    if (ids.length > 0) {
      variablesAgg.byProperty[prop].boundNodes += 1;
      any = true;

      for (const id of ids) inc(variableCountsById, id, 1);
    }
  }

  if (any) variablesAgg.nodesWithAnyBinding += 1;

  // Correct usage rules (by prefix)
  // We validate by looking at variable name prefixes later in finalizeVariablesAgg.
  // Here we only collect counts by id.
}

async function finalizeVariablesAgg(
  variableCountsById: Record<string, number>,
  variablesAgg: VariablesAgg,
  limit: number,
) {
  const pairs = Object.entries(variableCountsById).sort((a, b) => b[1] - a[1]);
  const top = pairs.slice(0, limit);

  const topVariables: TopItem[] = [];
  const byCollection: Record<string, number> = {};

  const rules = (figma.ui as any)?._tokenRules as TokenRule[] | undefined;

  // We can’t read UI directly; so we infer rules during runAudit by storing them on figma root (below).
  // This helper uses figma.root pluginData instead.
  const tokenRules = getTokenRulesFromPluginData();

  for (const [varId, count] of top) {
    const v = await figma.variables.getVariableByIdAsync(varId);
    const name = v?.name ?? varId;
    topVariables.push({ id: varId, name, count });

    if (v?.variableCollectionId) {
      const c = await figma.variables.getVariableCollectionByIdAsync(
        v.variableCollectionId,
      );
      const cn = c?.name ?? "Unknown collection";
      byCollection[cn] = (byCollection[cn] ?? 0) + count;

      // Correct usage check: category inferred from rule match (prefix → category)
      // We mark OK if variable name matches any prefix; otherwise Unknown (or Wrong if it matches but category mismatch—if you add expected category by usage later).
      // Minimal: validate that the variable at least belongs to one of expected prefixes.
      const rule = tokenRules.find((r) => name.startsWith(r.prefix));
      if (rule) {
        variablesAgg.correctUsage.ok += 1;
      } else {
        variablesAgg.correctUsage.unknown += 1;
      }
    } else {
      variablesAgg.correctUsage.unknown += 1;
    }
  }

  // Additionally: scan all variables for wrong usage examples is expensive;
  // Keep it top-focused. You can extend to validate per property (fills -> must be Color/) by mapping boundVariables prop → expected category.
  variablesAgg.topVariables = topVariables;
  variablesAgg.byCollection = byCollection;

  // If you want "Uso correcto por categoría (por propiedad)", aquí tienes un hook fácil:
  // - En collectVariableBindings, si prop == 'fills' => expected category 'Color'
  // - Guardas (varId, expectedCategory) en una lista
  // - Aquí resuelves varId->name y validas prefix.
}

function getTokenRulesFromPluginData(): TokenRule[] {
  const raw = figma.root.getPluginData("tokenRules");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
      return parsed.filter((x) => x?.prefix && x?.category);
    return [];
  } catch {
    return [];
  }
}

// We store tokenRules on RUN for later resolution usage.
async function setTokenRulesToPluginData(rules: TokenRule[]) {
  figma.root.setPluginData("tokenRules", JSON.stringify(rules));
}

function makeCsv(payload: ResultPayload): string {
  const lines: string[] = [];
  lines.push(["metric", "value"].join(","));
  const s = payload.summary;

  lines.push(["totalLayers", s.totalLayers].join(","));
  lines.push(["totalInstances", s.totalInstances].join(","));
  lines.push(
    ["percentLayersInstances", s.percentLayersInstances.toFixed(2)].join(","),
  );
  lines.push(["dsInstances", s.dsInstances].join(","));
  lines.push(["localInstances", s.localInstances].join(","));
  lines.push(
    ["percentInstancesFromDs", s.percentInstancesFromDs.toFixed(2)].join(","),
  );
  lines.push(["detachedInstances", s.detachedInstances].join(","));
  lines.push(["percentDetached", s.percentDetached.toFixed(2)].join(","));

  lines.push("");
  lines.push(["topComponentsByKey:id", "count"].join(","));
  for (const it of s.topComponentsByKey)
    lines.push([it.id, it.count].join(","));

  lines.push("");
  lines.push(["topComponentsByName:name", "count"].join(","));
  for (const it of s.topComponentsByName)
    lines.push([escapeCsv(it.name), it.count].join(","));

  lines.push("");
  lines.push(["topVariables:name", "count"].join(","));
  for (const it of s.variables.topVariables)
    lines.push([escapeCsv(it.name), it.count].join(","));

  return lines.join("\n");
}

function escapeCsv(v: string): string {
  const needs = /[",\n]/.test(v);
  if (!needs) return v;
  return `"${v.replace(/"/g, '""')}"`;
}

// Patch: store token rules when RUN arrives
figma.ui.onmessage = async (msg: any) => {
  try {
    if (msg.type === "RUN") {
      const settings: Settings = msg.settings;
      await setTokenRulesToPluginData(settings.tokenRules);

      const payload = await runAudit(settings);
      figma.ui.postMessage({ type: "RESULT", payload });
      return;
    }

    if (msg.type === "EXPORT_JSON") {
      const json = JSON.stringify(msg.payload, null, 2);
      await figma.clipboard.writeTextAsync(json);
      figma.notify("JSON copied to clipboard ✅");
      return;
    }

    if (msg.type === "EXPORT_CSV") {
      const csv = makeCsv(msg.payload as ResultPayload);
      await figma.clipboard.writeTextAsync(csv);
      figma.notify("CSV copied to clipboard ✅");
      return;
    }
  } catch (e: any) {
    figma.ui.postMessage({ type: "ERROR", message: e?.message ?? String(e) });
  }
};
