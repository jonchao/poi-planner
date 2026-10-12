/*
 * Reading a Wanderlog trip: fetch it by key and turn it into the place list the site shows.
 * Hotels and flights are never copied. Used by sync-wanderlog.mjs.
 */
const IMAGE_URL = "https://itin-dev.wanderlogstatic.com/freeImageSmall/";
const HERO_URL = "https://itin-dev.wanderlogstatic.com/freeImage/";

// The trip key from any Wanderlog trip link (view, edit or suggest), or a bare key.
export function wanderlogKey(link) {
  const s = String(link || "").trim();
  return s.match(/wanderlog\.com\/(?:view|plan|tp)\/([A-Za-z0-9]+)/)?.[1] || (/^[A-Za-z0-9]{6,}$/.test(s) ? s : null);
}

export async function fetchTrip(key) {
  if (!key) throw new Error("That doesn't look like a Wanderlog trip link");
  const url = `https://wanderlog.com/api/tripPlans/${key}?clientSchemaVersion=2&registerView=false`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (trip-ranker sync)", Accept: "application/json" } });
  if (res.status === 404) throw new Error("Wanderlog couldn't find that trip. Check the link is shared.");
  if (!res.ok) throw new Error(`Wanderlog answered ${res.status}`);
  const json = await res.json();
  if (!json.success || !json.tripPlan) throw new Error("Wanderlog didn't return a trip. Check the link is shared.");
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

export function toBoard(json) {
  const tp = json.tripPlan;
  const meta = new Map((json.resources?.placeMetadata || []).map((m) => [m.placeId, m]));
  const sections = tp.itinerary?.sections || [];
  const lodging = new Set(sections.filter((s) => s.type === "hotels").flatMap((s) => (s.blocks || []).map((b) => b.place?.place_id)));
  const lists = [];
  const places = new Map();
  // The day-by-day plan, in Wanderlog's order: each day's places (by id, with times) and notes.
  const itinerary = [];

  for (const s of sections) {
    const isDay = s.mode === "dayPlan";
    if (!isDay && s.type !== "normal") continue; // notes, flights, hotels
    const listName = isDay ? null : (s.heading || "Places").trim();
    const dayPlan = isDay && s.date ? { date: s.date, title: (s.heading || "").trim() || null, note: plainText(s.text) || null, items: [] } : null;
    if (dayPlan) itinerary.push(dayPlan);
    for (const b of s.blocks || []) {
      if (dayPlan && b.type === "note") {
        const text = plainText(b.text);
        if (text) dayPlan.items.push({ note: text });
        continue;
      }
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
          lat: b.place.geometry?.location?.lat ?? null,
          lng: b.place.geometry?.location?.lng ?? null,
          website: m.website || null,
          phone: m.internationalPhoneNumber || null,
          // Wanderlog's estimate of how much a booking is needed, 1 (walk in) to 5 (book well ahead),
          // for each month Jan..Dec, on weekdays and on weekends.
          booking: Array.isArray(months) && months.length === 12
            ? { weekdays: months.map((x) => x.weekdays || 0), weekends: months.map((x) => x.weekends || 0) }
            : null,
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
      if (dayPlan) dayPlan.items.push({ placeId: id, time: b.startTime || null, endTime: b.endTime || null, note: note || null });
    }
  }
  itinerary.sort((a, b) => a.date.localeCompare(b.date));

  // Places that are only on the day-by-day itinerary get their own list.
  const itineraryOnly = [...places.values()].filter((p) => !p.lists.length);
  if (itineraryOnly.length) {
    lists.push({ name: "Itinerary", color: null });
    for (const p of itineraryOnly) p.lists.push("Itinerary");
  }

  // Hero image: the trip's Wanderlog cover photo (a picture of the destination), else the first place photo.
  const geo = json.resources?.geo;
  const firstPhoto = [...places.values()].find((p) => p.image)?.image || null;
  return {
    title: tp.title || "Wanderlog trip",
    destination: geo?.name ? [geo.name, geo.countryName].filter((x, i, a) => x && a.indexOf(x) === i).join(", ") : null,
    hero: tp.headerImageKey ? HERO_URL + tp.headerImageKey : firstPhoto ? firstPhoto.replace("/freeImageSmall/", "/freeImage/") : null,
    startDate: tp.startDate || null,
    endDate: tp.endDate || null,
    editedAt: tp.editedAt || tp.updatedAt || null,
    lists,
    places: [...places.values()],
    itinerary,
  };
}
