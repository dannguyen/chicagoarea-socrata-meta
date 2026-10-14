#!/usr/bin/env node
// Fetches the catalog of datasets (only=dataset, so no maps, charts, files, etc.)
// for each Socrata domain via the Discovery API and caches it at
// data/cached/catalogs/<domain>.json.
//
// Usage: node scripts/fetch-catalogs.mjs [domain ...]

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_DOMAINS = [
  "data.cityofchicago.org",
  "datacatalog.cookcountyil.gov",
  "data.illinois.gov",
];

const API = "https://api.us.socrata.com/api/catalog/v1";
const PAGE_SIZE = 1000;
const OUT_DIR = path.join("data", "cached", "catalogs");

async function fetchCatalog(domain) {
  const byId = new Map();
  let offset = 0;
  let total = null;

  for (;;) {
    const url = new URL(API);
    url.searchParams.set("domains", domain);
    url.searchParams.set("search_context", domain);
    url.searchParams.set("only", "dataset");
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`${domain}: HTTP ${res.status} fetching ${url}`);
    }
    const page = await res.json();
    total ??= page.resultSetSize;

    if (!page.results?.length) break;
    for (const r of page.results) byId.set(r.resource.id, r);
    offset += page.results.length;
    process.stderr.write(`  ${domain}: page at offset ${offset - page.results.length} returned ${page.results.length}; ${byId.size}/${total} unique\n`);
    if (page.results.length < PAGE_SIZE || offset >= total) break;
  }

  return {
    domain,
    fetched_at: new Date().toISOString(),
    resultSetSize: total,
    results: [...byId.values()],
  };
}

const domains = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_DOMAINS;
await mkdir(OUT_DIR, { recursive: true });
process.stderr.write(`fetch-catalogs: ${domains.length} domain(s), page size ${PAGE_SIZE}\n`);

for (const domain of domains) {
  process.stderr.write(`${domain}: fetching catalog\n`);
  const catalog = await fetchCatalog(domain);
  const outPath = path.join(OUT_DIR, `${domain}.json`);
  await writeFile(outPath, JSON.stringify(catalog, null, 2));
  const byType = {};
  for (const r of catalog.results) byType[r.resource.type] = (byType[r.resource.type] ?? 0) + 1;
  process.stderr.write(`${domain}: wrote ${outPath} (${catalog.results.length} entries: ` +
    Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(" ") + ")\n");
}
