#!/usr/bin/env node
/*
 * Imports trips from Wanderlog into Firestore. Runs in GitHub Actions every 10 minutes (.github/workflows/sync.yml).
 *
 * Planners add a trip on the site, which writes planSources/{planId} (the Wanderlog link) and plans/{planId}
 * with status "pending". This job imports pending trips right away and refreshes the rest once an hour,
 * writing the places into plans/{planId}. Nothing here is logged by id or link: Actions logs are public.
 *
 * Env:
 *   FIREBASE_SERVICE_ACCOUNT  service-account key JSON for the Firebase project (Actions secret)
 *   PLANNER_OWNER             owner's Google email; creates team/main on the first run (Actions secret)
 *   WANDERLOG_TRIPS           optional, older "<slug> <secret> <link>" lines; adopted as trips once,
 *                             keeping their existing board links and votes
 */
import { createHash } from "node:crypto";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { wanderlogKey, fetchTrip, toBoard } from "./wanderlog.mjs";

const REFRESH_MS = 60 * 60 * 1000;
const NEW_TRIP = "New trip"; // placeholder title until the first import names the trip
const MAX_DOC_CHARS = 900_000; // Firestore documents top out at 1 MiB

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "null");
if (!serviceAccount) {
  // Not set up yet: skip quietly rather than failing (and emailing) every 10 minutes.
  console.log("::warning::FIREBASE_SERVICE_ACCOUNT isn't set yet, so nothing was imported (see README).");
  process.exit(0);
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function ensureTeam(ownerEmail) {
  const owner = (ownerEmail || "").trim().toLowerCase();
  const ref = db.doc("team/main");
  if (!owner || (await ref.get()).exists) return;
  await ref.set({ owner, planners: [owner], updatedAt: FieldValue.serverTimestamp() });
  console.log("Created the planner list.");
}

// Trips from before the site had a trip list. Their id is the board id the old link already pointed at.
async function adoptOldTrips(text, ownerEmail) {
  for (const line of (text || "").split("\n")) {
    const [slug, secret, link] = line.trim().split(/\s+/);
    if (!slug || slug.startsWith("#") || !secret || !link) continue;
    const id = `${slug}-${createHash("sha256").update(`board:${slug}:${secret}`).digest("hex").slice(0, 32)}`;
    const source = db.doc(`planSources/${id}`);
    if ((await source.get()).exists) continue;
    const createdBy = (ownerEmail || "").trim().toLowerCase();
    await source.set({ link, createdBy, createdAt: FieldValue.serverTimestamp() });
    await db.doc(`plans/${id}`).set({ title: NEW_TRIP, status: "pending", createdBy, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    console.log("Adopted an older trip.");
  }
}

function isDue(plan, source) {
  const synced = plan?.syncedAt?.toMillis?.() || 0;
  const requested = source.requestedAt?.toMillis?.() || 0;
  return !plan || plan.status === "pending" || !plan.places || requested > synced || Date.now() - synced > REFRESH_MS;
}

async function importTrip(sourceSnap, plan) {
  const source = sourceSnap.data();
  const json = await fetchTrip(wanderlogKey(source.link));
  const board = toBoard(json);
  const update = {
    ...board,
    title: !plan?.title || plan.title === NEW_TRIP ? board.title : plan.title,
    wanderlogTitle: board.title,
    placeCount: board.places.length,
    status: "ready",
    error: FieldValue.delete(),
    syncedAt: FieldValue.serverTimestamp(),
  };
  if (JSON.stringify(board).length > MAX_DOC_CHARS) throw new Error("This trip has too many places to import.");
  await db.doc(`plans/${sourceSnap.id}`).set(update, { merge: true });
  // Keep only the view-only link, in case someone pasted Wanderlog's edit link.
  const viewKey = json.tripPlan.viewKey;
  if (viewKey && wanderlogKey(source.link) !== viewKey) await sourceSnap.ref.update({ link: `https://wanderlog.com/view/${viewKey}` });
  return board.places.length;
}

await ensureTeam(process.env.PLANNER_OWNER);
await adoptOldTrips(process.env.WANDERLOG_TRIPS, process.env.PLANNER_OWNER);

const sources = await db.collection("planSources").get();
let n = 0, failed = 0;
for (const sourceSnap of sources.docs) {
  n++;
  const planRef = db.doc(`plans/${sourceSnap.id}`);
  const plan = (await planRef.get()).data();
  if (!isDue(plan, sourceSnap.data())) { console.log(`Trip ${n}: up to date.`); continue; }
  try {
    console.log(`Trip ${n}: imported ${await importTrip(sourceSnap, plan)} places.`);
  } catch (err) {
    failed++;
    console.error(`Trip ${n}: ${err.message}`);
    await planRef.set({ status: "error", error: String(err.message).slice(0, 200), syncedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
}
console.log(`${sources.size} trips checked${failed ? `, ${failed} failed` : ""}.`);
