#!/usr/bin/env node
/*
 * Pulls Wanderlog trips and writes data/<slug>.json for the site.
 *
 * Trips come from the WANDERLOG_TRIPS env var (a GitHub Actions secret) or, locally, from trips.local.
 * One trip per line:   <slug> <board secret> <wanderlog link>
 *   slug          short name used in the board link and file name, e.g. mexico-city
 *   board secret  random string that is also in the board link (#slug:secret); it encrypts the file
 *   link          the trip's Wanderlog link (a view-only link is enough)
 *
 * The output is encrypted with the board secret, so the public repo never shows the trip itself:
 * only people with the board link can read it. Hotels and flights are never copied.
 * A file is rewritten only when its decrypted content changed, so scheduled runs don't churn commits.
 *
 *   node scripts/sync-wanderlog.mjs           sync every trip
 *   node scripts/sync-wanderlog.mjs --links   also print each board's link
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE_URL = "https://jonchao.github.io/trip-ranker/";
const IMAGE_URL = "https://itin-dev.wanderlogstatic.com/freeImageSmall/";
const subtle = webcrypto.subtle;
const enc = new TextEncoder();

async function readTrips() {
  let text = process.env.WANDERLOG_TRIPS;
  const local = path.join(ROOT, "trips.local");
  if (!text && existsSync(local)) text = await readFile(local, "utf8");
  if (!text) throw new Error("No trips: set WANDERLOG_TRIPS or create trips.local (see README).");
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((line) => {
    const [slug, secret, link] = line.split(/\s+/);
    if (!/^[a-z0-9-]{2,40}$/.test(slug || "")) throw new Error(`Bad slug in line: ${slug}`);
    if (!/^[A-Za-z0-9_-]{16,}$/.test(secret || "")) throw new Error(`Bad or short secret for ${slug}`);
    const key = (link || "").match(/wanderlog\.com\/(?:view|plan|tp)\/([A-Za-z0-9]+)/)?.[1] || (/^[A-Za-z0-9]{6,}$/.test(link || "") ? link : null);
    if (!key) throw new Error(`Couldn't find a Wanderlog trip key for ${slug}`);
    return { slug, secret, key };
  });
}

async function fetchTrip(key) {
  const url = `https://wanderlog.com/api/tripPlans/${key}?clientSchemaVersion=2&registerView=false`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (trip-ranker sync)", Accept: "application/json" } });
  if (!res.ok) throw new Error(`Wanderlog answered ${res.status}`);
  const json = await res.json();
  if (!json.success || !json.tripPlan) throw new Error("Wanderlog didn't return a trip (is the link shared?)");
  return json;
}

const plainText = (rich) => (rich?.ops || []).map((op) => (typeof op.insert === "string" ? op.insert : "")).join("").replace(/\s+/g, " ").trim();

// One or two sentences: Wanderlog's own short description if it has one, else the start of the long one.
function shortBlurb(meta) {
  if (meta?.description) return meta.description.trim();
  const long = (meta?.generatedDescription || "").replace(/\s+/g, " ").trim();
  if (!long) return null;
  const sentences = long.match(/[^.!?]+[.!?]+(\s|$)/g) || [long];
  let out = "";
  for (const s of sentences) {
    if (out && (out + s).length > 220) break;
    out += s;
  }
  out = out.trim();
  return out.length > 260 ? out.slice(0, 250).replace(/\s+\S*$/, "") + "…" : out;
}

const prettyType = (t) => (t ? t.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : null);

// What kind of place it is, for the dashboard totals. Checked in order, so "Espresso bar" is a cafe
// and "Taco restaurant" on the Bars list is still a restaurant.
const KIND_RULES = [
  ["cafe", /\b(caf[eé]s?|cafeteria|coffee|espresso|bakery|bakeries|panader[ií]a|pasteler[ií]a|pastry|patisserie|churrer[ií]a|dessert|ice cream|helader[ií]a|tea ?house|chocolate)/i],
  ["bar", /\b(bars?|pub|cantina|speakeasy|cocktail|mezcaler[ií]a|wine|brewery|beer|lounge|night ?club|tavern|pulquer[ií]a)\b/i],
  ["restaurant", /(restaurant|taco|taquer[ií]a|food|marisquer[ií]a|fonda|comedor|quesadilla|eatery|diner|grill|steak|seafood|pizza|sushi|bistro|torter[ií]a|cocina)/i],
  ["market", /(market|mercado|\bshop|store|mall\b|boutique|bazaar)/i],
  ["activity", /(stadium|arena|racing|race ?track|circuit|venue|\btours?\b|class\b|school|\bspa\b|massage|\bshow\b|theat(er|re)|concert|lucha|boxing|amusement|\bzoo\b|aquarium|golf|wrestling)/i],
  ["sight", /(museum|gallery|palace|castle|church|basilica|cathedral|temple|monument|landmark|historic|library|cultural|\bpark\b|garden|government|sights|ruins|archaeolog|pyramid|plaza|square|z[oó]calo)/i],
  ["area", /(neighbou?rhood|district|locality|\barea\b|colonia|street|route)/i],
];
const GENERIC = /^(restaurant|point of interest|establishment|tourist attraction)$/i;
function classify(name, categories, types, listName) {
  const match = (text) => KIND_RULES.find(([, re]) => re.test(text))?.[0];
  const primary = categories[0];
  return (primary && !GENERIC.test(primary) && match(primary))
    || (listName && match(listName))
    || match([...categories, ...(types || []).map(prettyType)].join(" | "))
    || match(name)
    || "other";
}

function toBoard(slug, json) {
  const tp = json.tripPlan;
  const meta = new Map((json.resources?.placeMetadata || []).map((m) => [m.placeId, m]));
  const sections = tp.itinerary?.sections || [];
  const lodging = new Set(sections.filter((s) => s.type === "hotels").flatMap((s) => (s.blocks || []).map((b) => b.place?.place_id)));
  const lists = [];
  const places = new Map();

  for (const s of sections) {
    const isDay = s.mode === "dayPlan";
    if (!isDay && s.type !== "normal") continue; // notes, flights, hotels
    const listName = isDay ? null : (s.heading || "Places").trim();
    for (const b of s.blocks || []) {
      const id = b.type === "place" && b.place?.place_id;
      if (!id || lodging.has(id)) continue;
      if (listName && !lists.some((l) => l.name === listName)) lists.push({ name: listName, color: s.placeMarkerColor || null });
      let p = places.get(id);
      if (!p) {
        const m = meta.get(id) || {};
        const months = m.needsBooking?.neededForMonths;
        p = {
          id,
          name: b.place.name,
          lists: [],
          kind: classify(b.place.name, m.categories || [], b.place.types, listName),
          category: m.categories?.[0] || prettyType(b.place.types?.[0]),
          rating: m.rating ?? b.place.rating ?? null,
          ratings: m.numRatings ?? b.place.user_ratings_total ?? null,
          price: m.priceLevel ?? null,
          blurb: shortBlurb(m),
          notes: [],
          address: m.address || b.place.formatted_address || null,
          website: m.website || null,
          phone: m.internationalPhoneNumber || null,
          // Wanderlog's estimate of how much a booking is needed, 1 (walk in) to 5 (book well ahead),
          // as [weekdays, weekends] for each month Jan..Dec.
          booking: Array.isArray(months) && months.length === 12 ? months.map((x) => [x.weekdays, x.weekends]) : null,
          scheduled: [],
          image: m.imageKeys?.[0] ? IMAGE_URL + m.imageKeys[0] : null,
          closed: !!m.permanentlyClosed || (m.businessStatus && m.businessStatus !== "OPERATIONAL") || false,
        };
        places.set(id, p);
      }
      if (listName && !p.lists.includes(listName)) p.lists.push(listName);
      if (isDay && s.date) p.scheduled.push({ date: s.date, time: b.startTime || null });
      const note = plainText(b.text);
      if (note && !p.notes.includes(note)) p.notes.push(note);
    }
  }

  // Places that are only on the day-by-day itinerary get their own list.
  const itineraryOnly = [...places.values()].filter((p) => !p.lists.length);
  if (itineraryOnly.length) {
    lists.push({ name: "Itinerary", color: null });
    for (const p of itineraryOnly) p.lists.push("Itinerary");
  }

  return {
    slug,
    title: tp.title || slug,
    startDate: tp.startDate || null,
    endDate: tp.endDate || null,
    editedAt: tp.editedAt || tp.updatedAt || null,
    lists,
    places: [...places.values()],
  };
}

// AES-GCM with a key derived from the board secret. The site does the same in the browser.
async function keyFor(secret, slug) {
  const base = await subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(`trip-ranker:${slug}`), iterations: 150000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encrypt(text, key) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text)));
  return { v: 1, iv: Buffer.from(iv).toString("base64"), data: Buffer.from(data).toString("base64") };
}

async function decrypt(file, key) {
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(file.iv, "base64") }, key, Buffer.from(file.data, "base64"));
  return new TextDecoder().decode(plain);
}

async function syncOne({ slug, secret, key }) {
  const board = toBoard(slug, await fetchTrip(key));
  const text = JSON.stringify(board);
  const cryptoKey = await keyFor(secret, slug);
  const out = path.join(ROOT, "data", `${slug}.json`);
  if (existsSync(out)) {
    try {
      if ((await decrypt(JSON.parse(await readFile(out, "utf8")), cryptoKey)) === text) return `${slug}: no changes (${board.places.length} places)`;
    } catch { /* unreadable or a different secret: rewrite it */ }
  }
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(await encrypt(text, cryptoKey)) + "\n");
  return `${slug}: updated (${board.places.length} places in ${board.lists.length} lists)`;
}

const trips = await readTrips();
let failed = 0;
for (const trip of trips) {
  try {
    console.log(await syncOne(trip));
    if (process.argv.includes("--links")) console.log(`  board link: ${SITE_URL}#${trip.slug}:${trip.secret}`);
  } catch (err) {
    failed++;
    console.error(`${trip.slug}: ${err.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
