/*
 * The suggested day-by-day plan on the Itinerary tab, separate from Wanderlog's own.
 *
 * Every spot the group rates 4.0+ (and every Must go) is spread over the trip's days so each day stays in one
 * walkable part of town, then timed to a day's rhythm (coffee, a sight, a late lunch, an afternoon stop, dinner,
 * drinks) for when each place is actually open. Spots rated 3.0-3.9 are offered as optional stops near a day's
 * route. Places on Wanderlog's itinerary keep their day and time (they're usually reservations).
 *
 * Pure and deterministic (everyone sees the same plan), with no DOM: index.html calls POIPlan.suggest(), and it
 * also runs under Node for testing.
 */
(function (root) {
  "use strict";
  const H = 60;

  // A day's rhythm. Each stop takes one slot: `at` is its ideal start and `latest` the last sensible start.
  // "quick" means a quick bite (tacos, quesadillas, a food hall), which also fits between meals.
  const SLOTS = [
    { key: "breakfast", at: 9 * H, latest: 11 * H, kinds: ["cafe", "market", "restaurant"] },
    { key: "morning", at: 10 * H + 30, latest: 13 * H, kinds: ["sight", "activity", "area", "market", "cafe", "other"] },
    { key: "lunch", at: 14 * H, latest: 15 * H + 30, kinds: ["restaurant"] },
    { key: "afternoon", at: 16 * H, latest: 18 * H, kinds: ["sight", "activity", "area", "market", "cafe", "other"] },
    { key: "snack", at: 17 * H + 30, latest: 19 * H, kinds: ["cafe", "quick", "area", "sight", "bar"] },
    { key: "dinner", at: 20 * H, latest: 21 * H + 30, kinds: ["restaurant"] },
    { key: "drinks", at: 21 * H + 45, latest: 23 * H + 30, kinds: ["bar"] },
    { key: "late", at: 23 * H, latest: 24 * H + 30, kinds: ["bar", "quick"] },
  ];
  // Small nudges so the usual pattern wins when walking is equal: a sit-down meal at lunch or dinner, not breakfast.
  const SLOT_NUDGE = { breakfast: { restaurant: 25 }, snack: { bar: 10, sight: 5 }, late: { quick: 5 } };
  const nudge = (key, f) => { const n = SLOT_NUDGE[key] || {}; return (f.quick && n.quick) || n[f.p.kind] || 0; };

  const QUICK = /taco|taquer|quesadill|torta|tamal|food court|food hall|street food|antojit|mercado/i;
  const WALK_MAX = 30;    // minutes; a longer hop is a ride
  const SKIP = 400;       // cost of leaving a wanted spot out of a day
  const LOCKED = 5000;    // ...or a spot Wanderlog already put on that day

  /* ---------- Places ---------- */

  const textOf = (p) => `${p.category || ""} ${p.name || ""}`;
  const isQuick = (p) => p.kind === "restaurant" && !(p.price >= 3) && QUICK.test(textOf(p));
  // How long a visit usually takes, in minutes.
  function visitMinutes(p) {
    const t = textOf(p);
    switch (p.kind) {
      case "cafe": return /bakery|panader|pasteler|pastry|churr|dessert|ice cream|helad/i.test(t) ? 30 : 45;
      case "restaurant": return p.price >= 4 || /tasting|degustaci/i.test(t) ? 120 : isQuick(p) ? 40 : 75;
      case "bar": return 75;
      case "market": return 60;
      case "sight": return /museum|museo/i.test(t) ? 120 : 75;
      case "area": return 90;
      case "activity": return /racing|race ?track|circuit|aut[oó]dromo|stadium|estadio|arena/i.test(t) ? 300 : 120;
      default: return 60;
    }
  }
  const accepts = (slot, p, quick) => slot.kinds.includes(p.kind || "other") || (quick && slot.kinds.includes("quick"));

  // Opening hours on a weekday (0 = Sunday) as [start, end] minutes; end can run past midnight (> 1440).
  // Without Wanderlog hours, assume typical ones for the kind of place.
  const TYPICAL = { cafe: [[8 * H, 20 * H]], restaurant: [[12 * H, 23 * H]], bar: [[18 * H, 26 * H]], market: [[9 * H, 18 * H]], sight: [[9 * H, 18 * H]], activity: [[9 * H, 20 * H]], area: [[0, 26 * H]], other: [[9 * H, 20 * H]] };
  function hoursOn(p, wd) {
    if (!Array.isArray(p.hours) || p.hours.length !== 7) return { open: TYPICAL[p.kind] || TYPICAL.other, known: false };
    const open = String(p.hours[wd] || "").split(",").filter(Boolean).map((r) => r.split("-").map((t) => Number(t.slice(0, 2)) * H + Number(t.slice(2, 4))));
    return { open, known: true };
  }
  // The earliest start between t and `latest` when the place is open long enough for a visit, or null.
  // Starts are rounded up to five minutes, the way people plan.
  function fitStart(open, t, latest, minutes) {
    const need = Math.min(minutes, 45);
    let best = null;
    for (const [a, b] of open) {
      const s = Math.ceil(Math.max(t, a) / 5) * 5;
      if (s <= latest && s + need <= b && (best === null || s < best)) best = s;
    }
    return best;
  }

  /* ---------- Getting around ---------- */

  const hasSpot = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng);
  function km(a, b) {
    const r = Math.PI / 180;
    const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(x));
  }
  // Walking at 4.8 km/h on streets about 30% longer than the straight line; past WALK_MAX, a ride in city traffic.
  // `cost` is what the planner minimizes: rides count extra so it prefers walking.
  function leg(a, b) {
    if (!hasSpot(a) || !hasSpot(b)) return { km: null, min: 15, mode: "ride", cost: 40 };
    const d = km(a, b);
    const walk = Math.max(1, Math.round((d * 1.3 / 4.8) * 60));
    if (walk <= WALK_MAX) return { km: d, min: walk, mode: "walk", cost: walk };
    const ride = Math.round(8 + (d * 1.4 / 20) * 60);
    return { km: d, min: ride, mode: "ride", cost: ride * 1.5 + 15 };
  }

  // The neighborhood from a Mexico-style address ("Calle 1, Roma Nte., Cuauhtémoc, 06700 Ciudad de México, ...").
  const BOROUGHS = /^(cuauht[eé]moc|miguel hidalgo|benito ju[aá]rez|coyoac[aá]n|tlalpan|iztacalco|iztapalapa|gustavo a\.? madero|[aá]lvaro obreg[oó]n|azcapotzalco|venustiano carranza|xochimilco|magdalena contreras|cuajimalpa|tl[aá]huac|milpa alta)$/i;
  function areaOf(p) {
    if (p.kind === "area") return p.name;
    const parts = String(p.address || "").split(",").map((s) => s.trim());
    const zip = parts.findIndex((s) => /\b\d{5}\b/.test(s));
    if (zip < 1) return null;
    let a = parts[zip - 1];
    if (BOROUGHS.test(a) && zip >= 2) a = parts[zip - 2];
    if (!a || /\d/.test(a)) return null; // a street, not a neighborhood
    return a.replace(/^colonia\s+/i, "").replace(/\s+[IVX]+\s+secc(i[oó]n)?\.?$/i, "").replace(/\bNte\.?$/i, "Norte").replace(/^Centro Hist[oó]rico.*$/i, "Centro").trim() || null;
  }

  /* ---------- The plan ---------- */

  const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * H + (m || 0); };
  const round1 = (x) => Math.round(x * 10) / 10;

  /**
   * dates:   ["2026-10-29", ...] every day of the trip, in order
   * places:  [{ id, name, kind, category, price, lat, lng, address, hours, closed, avg, must }]
   *          avg = the group's average (0 when nobody rated it), must = in someone's Top 5
   * booked:  [{ placeId, date, time: "18:30" | null, endTime }] from Wanderlog's itinerary
   * Returns { days: [{ date, light, stops, optional, walkKm, walkMin, rides, areas }], unplaced: [{ id, why }] }
   */
  function suggest({ dates, places, booked = [] }) {
    const n = dates.length;
    const out = { days: [], unplaced: [] };
    if (!n) return out;
    const weekday = dates.map((d) => new Date(d + "T12:00:00Z").getUTCDay());
    // Arrival and departure days stay light: from mid-afternoon on the first day, until mid-afternoon on the last.
    const light = dates.map((_, i) => (n > 2 && i === 0 ? "arrive" : n > 2 && i === n - 1 ? "leave" : null));
    const daySlots = light.map((l) => SLOTS.filter((s) => (l === "arrive" ? s.at >= 15 * H : l === "leave" ? s.at < 15 * H : true)));
    const dayStart = light.map((l) => (l === "arrive" ? 15 * H : 8 * H));

    const info = new Map(); // id -> { p, minutes, quick, week: opening hours by weekday }
    const facts = (p) => {
      if (!info.has(p.id)) info.set(p.id, { p, minutes: visitMinutes(p), quick: isQuick(p), week: [0, 1, 2, 3, 4, 5, 6].map((wd) => hoursOn(p, wd)) });
      return info.get(p.id);
    };

    // Wanderlog's itinerary: those places stay on their day (and at their time, when it has one).
    const byId = new Map(places.map((p) => [p.id, p]));
    const fixed = dates.map(() => []);     // per day: [{ f, time, end }] booked at a time
    const pinned = dates.map(() => []);    // per day: [f] on that day without a time
    const onWanderlog = new Set();
    for (const b of booked) {
      const i = dates.indexOf(b.date), p = byId.get(b.placeId);
      if (i < 0 || !p || onWanderlog.has(p.id)) continue;
      onWanderlog.add(p.id);
      const f = facts(p);
      if (b.time) {
        const time = toMin(b.time);
        const end = b.endTime && toMin(b.endTime) > time ? toMin(b.endTime) : time + f.minutes;
        fixed[i].push({ f, time, end });
      } else pinned[i].push(f);
    }

    const wanted = [], optional = [];
    for (const p of places) {
      if (onWanderlog.has(p.id) || p.closed) continue;
      const avg = round1(p.avg || 0);
      if (p.must || avg >= 4) wanted.push(facts(p));
      else if (avg >= 3) optional.push(facts(p));
    }

    // A booked time uses up the slot it lands in (a 2:15 PM booking is that day's lunch).
    function slotFor(f, time) {
      const k = f.p.kind;
      if (k === "restaurant") return time < 11 * H ? "breakfast" : time < 17 * H ? "lunch" : "dinner";
      if (k === "bar") return time < 19 * H ? "snack" : "drinks";
      if (k === "cafe") return time < 12 * H ? "breakfast" : "afternoon";
      return time < 13 * H + 30 ? "morning" : "afternoon";
    }
    const freeSlots = daySlots.map((slots, i) => slots.filter((s) => !fixed[i].some(({ f, time }) => slotFor(f, time) === s.key)));
    // A restaurant only makes breakfast if it's a breakfast place (open by 10).
    const latestFor = (s, f) => (s.key === "breakfast" && f.p.kind === "restaurant" ? 10 * H : s.latest);
    // Which of a day's free slots a place could take, given its kind and that day's hours.
    const slotsOk = (f, i) => freeSlots[i].filter((s) => accepts(s, f.p, f.quick) && fitStart(f.week[weekday[i]].open, s.at, latestFor(s, f), f.minutes) !== null);

    // Can these places share day i, one slot each? (Bipartite matching; ignores travel time.)
    function fits(list, i) {
      const options = list.map((f) => slotsOk(f, i).map((s) => s.key));
      const owner = new Map();
      const tryPlace = (k, seen) => {
        for (const key of options[k]) {
          if (seen.has(key)) continue;
          seen.add(key);
          if (!owner.has(key) || tryPlace(owner.get(key), seen)) { owner.set(key, k); return true; }
        }
        return false;
      };
      return list.every((_, k) => tryPlace(k, new Set()));
    }

    for (const f of wanted) {
      if (!hasSpot(f.p)) out.unplaced.push({ id: f.p.id, why: "Wanderlog has no location for it" });
    }
    let pool = wanted.filter((f) => hasSpot(f.p));
    const feasibleDays = new Map(pool.map((f) => [f.p.id, dates.map((_, i) => i).filter((i) => slotsOk(f, i).length)]));
    for (const f of pool) if (!feasibleDays.get(f.p.id).length) out.unplaced.push({ id: f.p.id, why: "Closed whenever it would fit on this trip" });
    pool = pool.filter((f) => feasibleDays.get(f.p.id).length);
    const byPlaceId = (a, b) => (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0);

    /* 1. Group the spots into days by where they are (k-means with room limits): each day has a center, spots go to
       the nearest day with room on a day they're open, and centers move to their spots, for a few rounds. */
    const anchorsOf = (i) => [...fixed[i].map((x) => x.f), ...pinned[i]].filter((f) => hasSpot(f.p));
    const mid = (fs) => ({ lat: fs.reduce((s, f) => s + f.p.lat, 0) / fs.length, lng: fs.reduce((s, f) => s + f.p.lng, 0) / fs.length });
    const center = dates.map((_, i) => (anchorsOf(i).length ? mid(anchorsOf(i)) : null));
    // Days without bookings start at the busiest clusters of spots (most others within a 20-minute walk), each at
    // least 2 km from the other days, so an outlying spot joins a nearby day rather than getting a day to itself.
    // Arrival and departure days take the busiest, so the short days need the least travel.
    const density = new Map(pool.map((f) => [f.p.id, pool.filter((g) => km(f.p, g.p) <= 1.5).length]));
    const seedOrder = dates.map((_, i) => i).sort((a, b) => !!light[b] - !!light[a] || a - b);
    for (const i of seedOrder) {
      if (center[i] || !pool.length) continue;
      const taken = center.filter(Boolean);
      const apart = pool.filter((f) => taken.every((c) => km(c, f.p) >= 2));
      const pick = (apart.length ? apart : pool).reduce((best, f) => (!best || density.get(f.p.id) > density.get(best.p.id) || (density.get(f.p.id) === density.get(best.p.id) && byPlaceId(f, best) < 0) ? f : best), null);
      center[i] = { lat: pick.p.lat, lng: pick.p.lng };
    }
    for (let i = 0; i < n; i++) if (!center[i]) center[i] = center.find(Boolean) || { lat: 0, lng: 0 };

    // Spread the stops evenly for the time each day has; a day takes at most one more than its share.
    const totalStops = pool.length + fixed.flat().length + pinned.flat().length;
    const slotCount = freeSlots.map((s, i) => s.length + fixed[i].length);
    const share = slotCount.reduce((a, b) => a + b, 0);
    const target = slotCount.map((c) => Math.max(1, Math.round((totalStops * c) / share)));
    const cap = slotCount.map((c, i) => Math.min(c, target[i] + 1));
    const familyOf = (f) => (f.p.kind === "restaurant" ? (f.quick ? "bite" : "meal") : f.p.kind === "bar" ? "bar" : f.p.kind === "cafe" ? "cafe" : "see");
    const SOFT = { meal: 2, bite: 1, bar: 1, cafe: 1, see: 2 };   // what a day usually has room for
    const HARD = { meal: 3, bite: 2, bar: 2, cafe: 2, see: 3 };   // and never more than this
    const familyOk = (list) => Object.entries(HARD).every(([fam, max]) => list.filter((g) => familyOf(g) === fam).length <= max);
    // Hardest first: spots open on fewer days, then the ones the group wants most.
    const order = [...pool].sort((a, b) => feasibleDays.get(a.p.id).length - feasibleDays.get(b.p.id).length || b.p.must - a.p.must || b.p.avg - a.p.avg || byPlaceId(a, b));

    let assign = new Map();
    for (let round = 0; round < 25; round++) {
      const members = dates.map((_, i) => [...pinned[i]]);
      const next = new Map();
      for (const f of order) {
        let best = null;
        for (const i of feasibleDays.get(f.p.id)) {
          const list = members[i];
          const load = list.length + fixed[i].length;
          if (load >= cap[i]) continue;
          const fam = familyOf(f);
          const same = list.filter((g) => familyOf(g) === fam).length;
          const cost = km(center[i], f.p) + 1.2 * Math.max(0, load + 1 - target[i]) + 1.5 * Math.max(0, same + 1 - SOFT[fam]);
          if (best && cost >= best.cost) continue;
          if (!familyOk([...list, f]) || !fits([...list, f], i)) continue;
          best = { i, cost };
        }
        if (best) { members[best.i].push(f); next.set(f.p.id, best.i); }
      }
      // Move each day's center to its spots (bookings count double, since they can't move).
      dates.forEach((_, i) => {
        const pts = [...members[i], ...anchorsOf(i), ...anchorsOf(i)].filter((f) => hasSpot(f.p));
        if (pts.length) center[i] = mid(pts);
      });
      const same = next.size === assign.size && [...next].every(([id, i]) => assign.get(id) === i);
      assign = next;
      if (same) break;
    }

    /* 2. Time each day: try every way of putting the day's spots into its slots (they're few), walking between them,
       and keep the one with the least travel where everything is open. Bookings keep their times. */
    function planDay(i, list) {
      const wd = weekday[i];
      const events = [
        ...freeSlots[i].map((s) => ({ at: s.at, slot: s })),
        ...fixed[i].map((x) => ({ at: x.time, booked: x })),
      ].sort((a, b) => a.at - b.at);
      const items = [...list].sort(byPlaceId);
      const locked = items.map((f) => pinned[i].includes(f));
      // Free slots from each event on: spots beyond that many can't all fit, which bounds the search.
      const slotsLeft = events.map((_, e) => events.slice(e).filter((x) => x.slot).length).concat(0);
      let best = null, budget = 200000; // search steps; plenty for a day's handful of stops
      const chosen = [];
      const used = new Array(items.length).fill(false);
      const step = (e, prev, prevEnd, cost, waiting) => {
        if (best && (cost + Math.max(0, waiting - slotsLeft[e]) * SKIP >= best.cost || --budget < 0)) return;
        if (e === events.length) {
          let total = cost;
          items.forEach((f, k) => { if (!used[k]) total += locked[k] ? LOCKED : SKIP; });
          if (!best || total < best.cost) best = { cost: total, stops: chosen.slice(), left: items.filter((_, k) => !used[k]) };
          return;
        }
        const ev = events[e];
        if (ev.booked) {
          const { f, time, end } = ev.booked;
          const l = prev ? hop(prev, f) : null;
          if (prev && prevEnd + l.min > time + 5) return; // never late for a booking
          chosen.push({ f, start: time, end, leg: l, booked: true, slot: slotFor(f, time) });
          step(e + 1, f, end, cost + (l ? l.cost : 0), waiting);
          chosen.pop();
          return;
        }
        const s = ev.slot;
        for (let k = 0; k < items.length; k++) {
          if (used[k]) continue;
          const f = items[k];
          if (!accepts(s, f.p, f.quick)) continue;
          const l = prev ? hop(prev, f) : null;
          const ready = prev ? prevEnd + l.min : dayStart[i];
          const start = fitStart(f.week[wd].open, Math.max(s.at, ready), latestFor(s, f), f.minutes);
          if (start === null) continue;
          used[k] = true;
          chosen.push({ f, start, end: start + f.minutes, leg: l, slot: s.key });
          step(e + 1, f, start + f.minutes, cost + (l ? l.cost : 0) + nudge(s.key, f) + (start - s.at) * 0.02, waiting - 1);
          chosen.pop();
          used[k] = false;
        }
        step(e + 1, prev, prevEnd, cost, waiting); // or leave this slot free
      };
      step(0, null, dayStart[i], 0, items.length);
      return best || { cost: LOCKED, stops: [], left: items };
    }
    const hops = new Map();
    const hop = (a, b) => {
      const key = a.p.id + ">" + b.p.id;
      if (!hops.has(key)) hops.set(key, leg(a.p, b.p));
      return hops.get(key);
    };
    const memo = new Map();
    const dayPlan = (i, list) => {
      const key = i + ":" + list.map((f) => f.p.id).sort().join("|");
      if (!memo.has(key)) memo.set(key, planDay(i, list));
      return memo.get(key);
    };

    const lists = dates.map((_, i) => [...pinned[i], ...pool.filter((f) => assign.get(f.p.id) === i)]);
    const isPinned = (f) => pinned.some((d) => d.includes(f));
    // Spots a day couldn't time, or that never got a day, try the other days, nearest first.
    const spill = pool.filter((f) => !assign.has(f.p.id));
    lists.forEach((list, i) => {
      for (const f of dayPlan(i, list).left) if (!isPinned(f)) { spill.push(f); lists[i] = lists[i].filter((g) => g !== f); }
    });
    const room = (i, list) => list.length + fixed[i].length < slotCount[i];
    for (const f of spill) {
      const tries = feasibleDays.get(f.p.id).slice().sort((a, b) => km(center[a], f.p) - km(center[b], f.p));
      const i = tries.find((d) => room(d, lists[d]) && familyOk([...lists[d], f]) && dayPlan(d, [...lists[d], f]).left.every(isPinned));
      if (i === undefined) out.unplaced.push({ id: f.p.id, why: "No room on a day near it when it's open" });
      else lists[i].push(f);
    }

    /* 3. Polish: move a spot to a nearby day, or swap two, whenever that means less travel in total. */
    const dayOf = (f) => lists.findIndex((l) => l.includes(f));
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const f of order) {
        const a = dayOf(f);
        if (a < 0) continue;
        const without = lists[a].filter((g) => g !== f);
        const baseA = dayPlan(a, lists[a]).cost, aWithout = dayPlan(a, without).cost;
        const near = feasibleDays.get(f.p.id).filter((b) => b !== a).sort((x, y) => km(center[x], f.p) - km(center[y], f.p)).slice(0, 3);
        let best = null;
        for (const b of near) {
          const baseB = dayPlan(b, lists[b]).cost;
          const tryIt = (newA, newB, g) => {
            if (!familyOk(newA) || !familyOk(newB)) return;
            const delta = dayPlan(a, newA).cost + dayPlan(b, newB).cost - baseA - baseB;
            if (delta < -0.5 && (!best || delta < best.delta)) best = { b, g, newA, newB, delta };
          };
          if (lists[b].length + fixed[b].length < cap[b]) tryIt(without, [...lists[b], f], null);
          for (const g of lists[b]) {
            if (isPinned(g) || !feasibleDays.get(g.p.id).includes(a)) continue;
            tryIt([...without, g], [...lists[b].filter((x) => x !== g), f], g);
          }
        }
        if (best) {
          lists[a] = best.newA; lists[best.b] = best.newB; moved = true;
          for (const i of [a, best.b]) { const pts = lists[i].filter((g) => hasSpot(g.p)); if (pts.length) center[i] = mid(pts); }
        }
      }
      if (!moved) break;
    }
    const plans = lists.map((list, i) => dayPlan(i, list));

    out.days = dates.map((date, i) => {
      const stops = plans[i].stops.map((x) => ({
        id: x.f.p.id, start: x.start, end: x.end, slot: x.slot, booked: !!x.booked, onWanderlog: onWanderlog.has(x.f.p.id),
        leg: x.leg ? { min: x.leg.min, km: x.leg.km, mode: x.leg.mode } : null,
        hours: hoursOn(x.f.p, weekday[i]),
      }));
      // On Wanderlog for this day but no time works (rare): still listed, untimed, at the end.
      for (const f of plans[i].left) stops.push({ id: f.p.id, start: null, end: null, slot: null, booked: false, onWanderlog: true, leg: null, hours: hoursOn(f.p, weekday[i]) });
      const legs = stops.map((s) => s.leg).filter(Boolean);
      const walks = legs.filter((l) => l.mode === "walk");
      const areaCount = new Map();
      for (const s of plans[i].stops) { const a = areaOf(s.f.p); if (a) areaCount.set(a, (areaCount.get(a) || 0) + 1); }
      return {
        date, light: light[i], stops, optional: [],
        walkKm: walks.reduce((a, l) => a + (l.km || 0) * 1.3, 0), walkMin: walks.reduce((a, l) => a + l.min, 0), rides: legs.length - walks.length,
        areas: [...areaCount].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 2).map(([a]) => a),
      };
    });

    // Optional spots: each goes with the day whose route passes closest while it's open, next to that stop.
    for (const f of optional) {
      if (!hasSpot(f.p)) continue;
      let best = null;
      out.days.forEach((d, i) => {
        for (const s of d.stops) {
          const near = byId.get(s.id);
          if (!hasSpot(near)) continue;
          const dist = km(near, f.p);
          if (best && dist >= best.dist) continue;
          if (fitStart(hoursOn(f.p, weekday[i]).open, Math.max(dayStart[i], s.start - 90), s.end + 90, f.minutes) === null) continue;
          best = { i, dist, near: s.id };
        }
      });
      if (!best) continue;
      const l = leg(byId.get(best.near), f.p);
      out.days[best.i].optional.push({ id: f.p.id, near: best.near, leg: { min: l.min, km: l.km, mode: l.mode }, hours: hoursOn(f.p, weekday[best.i]) });
    }
    for (const d of out.days) {
      const pos = new Map(d.stops.map((s, k) => [s.id, k]));
      d.optional.sort((a, b) => pos.get(a.near) - pos.get(b.near) || a.leg.min - b.leg.min);
    }
    return out;
  }

  root.POIPlan = { suggest, visitMinutes, areaOf, km, leg };
})(typeof window !== "undefined" ? window : globalThis);
