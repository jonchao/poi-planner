# Trip Ranker

A page for deciding, as a group, which places from a Wanderlog trip are worth going to.

- **All spots**: every place from the Wanderlog trip with a photo, a short description, and Wanderlog's
  estimate of whether you need a reservation. Everyone rates each place 1 (skip it) to 5 (must go), and
  each person's score shows on the place.
- **Group picks**: places ranked into tiers. *Definitely go* means an average of 4 or more with nobody below 3.
- **Reservations**: places that need booking, starting with the ones the group wants. Anyone can mark a place
  booked and add details.
- **Dashboard** (side panel): totals by type (restaurants, cafés & bakeries, bars, sights…), the group's
  verdict, and who has voted. Tap a type to filter.

Live at <https://jonchao.github.io/trip-ranker/>, but each trip opens through its own private board link
(`…/trip-ranker/#<slug>:<secret>`). Bookmark it or share it with the group.

## How it works

- `scripts/sync-wanderlog.mjs` pulls each trip from Wanderlog's trip API, keeps only the places (never
  hotels or flights), and writes `data/<slug>.json` **encrypted** with the board secret. The repo is public,
  but the trip can only be read with the board link.
- `.github/workflows/sync.yml` runs the sync every hour and commits changes. Run it on demand from the
  [Actions tab](https://github.com/jonchao/trip-ranker/actions/workflows/sync.yml) ("Run workflow").
- Votes and booking notes live in Trip Ranker's own Firebase project, in Firestore under `rankBoards/{boardId}`.
  The board id is derived from the link's secret. Browsers sign in anonymously. Rules are in `firestore.rules`;
  after changing them, paste them into Firebase console → Firestore → Rules → Publish.
- People pick their name the first time they open a board. Scores are saved under that name, so the same
  person can switch devices. It runs on trust: anyone with the link can vote as anyone.

## Trips

Trips are listed in the `WANDERLOG_TRIPS` repository secret, one per line:

```
<slug> <board secret> <wanderlog link>
```

The Wanderlog link can be the view-only share link. To add a trip, make a secret with
`node -e "console.log(require('crypto').randomBytes(16).toString('base64url'))"`, add a line to the secret
(and to `trips.local`, which is git-ignored, for local runs), then run the workflow.

Run locally:

```
node scripts/sync-wanderlog.mjs --links
python3 -m http.server 8000
```
