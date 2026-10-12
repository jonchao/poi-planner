#!/usr/bin/env node
/*
 * Publishes firestore.rules to the Firebase project, so rule changes go live with a push instead of a paste
 * into the console. Runs in GitHub Actions (.github/workflows/rules.yml) with the FIREBASE_SERVICE_ACCOUNT secret.
 */
import { readFile } from "node:fs/promises";
import { initializeApp, cert } from "firebase-admin/app";
import { getSecurityRules } from "firebase-admin/security-rules";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "null");
if (!serviceAccount) throw new Error("FIREBASE_SERVICE_ACCOUNT isn't set (see README).");
initializeApp({ credential: cert(serviceAccount) });

const source = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
const ruleset = await getSecurityRules().releaseFirestoreRulesetFromSource(source);
console.log(`Published Firestore rules (ruleset created ${ruleset.createTime}).`);
