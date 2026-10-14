#!/usr/bin/env node
// For every dataset in data/cached/catalogs/*.json, fetches the Socrata views
// metadata (https://<domain>/api/views/<4x4>.json) and caches a trimmed version at
// data/cached/metadata/<domain>/<4x4>.json.
//
// Incremental: a dataset is skipped when its cached file's rowsUpdatedAt matches the
// catalog's data_updated_at. Pass --force to refetch everything, --oldest N to
// refetch only the N cached files with the oldest fetchedAt (across all domains), or
// --discover to fetch only catalog datasets not yet present in data/datasets.json.
//
// Usage: node scripts/fetch-metadata.mjs [--force | --oldest N | --discover] [domain ...]

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CATALOG_DIR = path.join("data", "cached", "catalogs");
const OUT_DIR = path.join("data", "cached", "metadata");
const BUILT = path.join("data", "datasets.json");
const CONCURRENCY = 4;
const RETRIES = 4;
const TYPES = new Set(["dataset"]);

const args = process.argv.slice(2);
const oldestIdx = args.indexOf("--oldest");
const oldestN = oldestIdx >= 0 ? Number(args[oldestIdx + 1]) : 0;
if (oldestIdx >= 0 && !(oldestN > 0)) {
  console.error("--oldest requires a positive number");
  process.exit(1);
}
const discover = args.includes("--discover");
const force = args.includes("--force") || oldestN > 0 || discover;
const onlyDomains = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--oldest");

const headers = {};
if (process.env.SOCRATA_APP_TOKEN) headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stderr.write(`${msg}\n`);

async function fetchJson(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();
    if (res.status === 404 || res.status === 403) return null;
    if (attempt >= RETRIES || (res.status < 500 && res.status !== 429)) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
    await sleep(retryAfter * 1000);
  }
}

// Keep only what the site and later analysis need; the raw response is ~100KB for
// wide datasets, mostly cachedContents.top samples.
function trim(view) {
  const columns = (view.columns ?? []).map((c) => ({
    name: c.name,
    fieldName: c.fieldName,
    dataTypeName: c.dataTypeName,
    description: c.description || null,
    nullCount: c.cachedContents?.null != null ? Number(c.cachedContents.null) : null,
    cardinality: c.cachedContents?.cardinality != null ? Number(c.cachedContents.cardinality) : null,
  }));
  const counted = (view.columns ?? []).find((c) => c.cachedContents?.count != null);
  return {
    id: view.id,
    name: view.name,
    assetType: view.assetType,
    viewType: view.viewType,
    displayType: view.displayType,
    rowCount: counted ? Number(counted.cachedContents.count) : null,
    rowCountSource: counted ? "cached" : null,
    rowLabel: view.metadata?.rowLabel ?? null,
    hasRowIdentifier: view.rowIdentifierColumnId != null,
    createdAt: view.createdAt ?? null,
    publicationDate: view.publicationDate ?? null,
    rowsUpdatedAt: view.rowsUpdatedAt ?? null,
    viewLastModified: view.viewLastModified ?? null,
    viewCount: view.viewCount ?? null,
    downloadCount: view.downloadCount ?? null,
    category: view.category ?? null,
    tags: view.tags ?? [],
    attribution: view.attribution ?? null,
    attributionLink: view.attributionLink ?? null,
    licenseId: view.licenseId ?? null,
    license: view.license?.name ?? null,
    provenance: view.provenance ?? null,
    publicationStage: view.publicationStage ?? null,
    newBackend: view.newBackend ?? null,
    customFields: view.metadata?.custom_fields ?? {},
    columns,
    fetchedAt: new Date().toISOString(),
  };
}

async function readCached(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function processDomain(domain, resources) {
  const dir = path.join(OUT_DIR, domain);
  await mkdir(dir, { recursive: true });
  const stats = { fetched: 0, skipped: 0, missing: 0, failed: 0 };
  const queue = [...resources];

  async function worker() {
    for (;;) {
      const r = queue.shift();
      if (!r) return;
      const file = path.join(dir, `${r.id}.json`);
      if (!force) {
        const cached = await readCached(file);
        const catalogUpdated = r.data_updated_at ? Date.parse(r.data_updated_at) / 1000 : null;
        if (cached && cached.rowCount != null && cached.rowsUpdatedAt === catalogUpdated) {
          stats.skipped++;
          continue;
        }
      }
      try {
        const view = await fetchJson(`https://${domain}/api/views/${r.id}.json`);
        if (!view) {
          stats.missing++;
          log(`  MISSING ${domain}/${r.id} (404/403)`);
          continue;
        }
        const meta = trim(view);
        // Very large datasets (and some empty ones) carry no cachedContents; fall back
        // to a live SoQL count, which is exact but costs a query.
        if (meta.rowCount == null) {
          const counted = await fetchJson(
            `https://${domain}/resource/${r.id}.json?$select=count(*)`);
          if (counted?.[0]?.count != null) {
            meta.rowCount = Number(counted[0].count);
            meta.rowCountSource = "query";
          }
        }
        await writeFile(file, JSON.stringify(meta, null, 2));
        stats.fetched++;
        const done = stats.fetched + stats.skipped + stats.missing + stats.failed;
        const rowsNote = meta.rowCount == null ? "rows unknown" :
          `${meta.rowCount.toLocaleString()} rows${meta.rowCountSource === "query" ? " (via count query)" : ""}`;
        log(`  [${done}/${resources.length}] ${domain}/${r.id}  ${meta.name}  ${rowsNote}`);
      } catch (err) {
        stats.failed++;
        log(`  FAILED ${domain}/${r.id}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return stats;
}

// The N cached ids whose fetchedAt is oldest, grouped by domain. Files without a
// fetchedAt sort first so a malformed or legacy file gets refreshed.
async function oldestCached(n) {
  const entries = [];
  for (const domain of await readdir(OUT_DIR)) {
    const dir = path.join(OUT_DIR, domain);
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const cached = await readCached(path.join(dir, f));
      entries.push({ domain, id: f.replace(/\.json$/, ""), fetchedAt: cached?.fetchedAt ?? "" });
    }
  }
  entries.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const chosen = entries.slice(0, n);
  const picked = new Map();
  for (const e of chosen) {
    if (!picked.has(e.domain)) picked.set(e.domain, new Set());
    picked.get(e.domain).add(e.id);
  }
  log(`--oldest ${n}: ${entries.length} cached files, refreshing ${chosen.length}`);
  if (chosen.length) {
    log(`  fetchedAt range: ${chosen[0].fetchedAt || "(none)"} .. ${chosen.at(-1).fetchedAt || "(none)"}`);
    for (const [domain, ids] of picked) log(`  ${domain}: ${ids.size}`);
  }
  return picked;
}

const mode = oldestN > 0 ? `--oldest ${oldestN}` : discover ? "--discover" : force ? "--force" : "incremental";
log(`fetch-metadata: mode=${mode} concurrency=${CONCURRENCY}` +
  (onlyDomains.length ? ` domains=${onlyDomains.join(",")}` : "") +
  (headers["X-App-Token"] ? " app-token=yes" : " app-token=no"));

const oldest = oldestN > 0 ? await oldestCached(oldestN) : null;
// Ids already in the built site data; a missing datasets.json means everything is new.
const known = discover
  ? new Set(((await readCached(BUILT))?.datasets ?? []).map((d) => d.id))
  : null;
if (known) log(`--discover: ${known.size} ids already in ${BUILT}`);
const catalogFiles = (await readdir(CATALOG_DIR)).filter((f) => f.endsWith(".json"));
for (const f of catalogFiles) {
  const domain = f.replace(/\.json$/, "");
  if (onlyDomains.length && !onlyDomains.includes(domain)) continue;
  const catalog = JSON.parse(await readFile(path.join(CATALOG_DIR, f), "utf8"));
  let resources = catalog.results.map((r) => r.resource).filter((r) => TYPES.has(r.type));
  if (oldest) {
    const ids = oldest.get(domain);
    if (!ids) continue;
    resources = resources.filter((r) => ids.has(r.id));
  }
  if (known) resources = resources.filter((r) => !known.has(r.id));
  log(`${domain}: ${resources.length} dataset(s) to process`);
  if (known && resources.length) {
    for (const r of resources) log(`  new: ${r.id}  ${r.name}`);
  }
  const stats = await processDomain(domain, resources);
  log(`${domain}: done  fetched=${stats.fetched} skipped=${stats.skipped} missing=${stats.missing} failed=${stats.failed}`);
}
