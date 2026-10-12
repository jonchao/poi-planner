# POI Planner

Plan trips with a group: pull each trip's places from Wanderlog, have everyone rate them, and see what the
group most wants to do and what needs a reservation.

Live at <https://jonchao.github.io/poi-planner/>.

## Using it

- **Planners** (you and your co-planners) sign in with Google and see **Your trips**. Add a trip by pasting its
  Wanderlog link. Its places appear within about 10–20 minutes. From each trip card you can copy its link,
  refresh it from Wanderlog, rename it, or delete it. The owner adds and removes co-planners at the bottom.
- **Friends** open a trip's link (no account). They pick their name once, rate places 1 (skip it) to 5 (love it),
  and pick their **Top 5**: up to five must-gos each. Anything in someone's Top 5 is a **Must go** everywhere.

Each trip has:

- **All spots**: every place with a photo, short description, Wanderlog's reservation estimate, your rating,
  and everyone's scores.
- **Group picks**: places ranked into tiers. *Must go* = in someone's Top 5; *Definitely go* = average 4+ and nobody
  below 3.
- **Reservations**: what still needs booking, starting with what the group wants. Anyone can mark a place booked.
- **Itinerary**: Wanderlog's day-by-day plan, every day of the trip.
- **Map**: every place as a pin colored by the group's verdict (OpenFreeMap styles via MapLibre, no API key).
- **Summary** (side panel): totals by type (restaurants, cafés & bakeries, bars, sights…), the group's verdict,
  and who has voted.
- **Who's voting?** (tap your name at the top): switch names or join. Planners can also pick a name and remove that
  voter and their votes (after a confirmation).
- **Reset my votes** (in Who's voting, or after your progress line on All spots on wider screens): clears all your
  ratings and must-gos on the trip, after a confirmation. Your name stays.

The header shows when the trip last refreshed from Wanderlog.

## How it works

- Everything lives in the `poi-planner-de173` Firebase project (Firestore + Auth):
  - `team/main`: the owner and co-planners (Google emails)
  - `plans/{tripId}`: a trip's title, dates, places, and itinerary
  - `planSources/{tripId}`: the trip's Wanderlog link (planners only)
  - `rankBoards/{tripId}/voters|spots`: everyone's ratings and booking notes

  Trip ids are long and random; knowing a trip's link is what lets someone open it.
  Rules are in `firestore.rules`; `.github/workflows/rules.yml` publishes them whenever they change on main.
- The browser can't read Wanderlog directly, so a GitHub Actions job (`.github/workflows/sync.yml`, every 10 minutes)
  imports new trips and refreshes the rest hourly. GitHub's timer can lag by hours, so the owner can turn on
  **Instant imports** on the trips page: a fine-grained GitHub token (this repo only, Actions read/write) stored in
  `config/github`, which lets Refresh and New trip start the job right away. It runs `scripts/sync-wanderlog.mjs`, which uses
  `scripts/wanderlog.mjs` to read a trip. Hotels and flights are never copied. Run it on demand from the
  [Actions tab](https://github.com/jonchao/poi-planner/actions/workflows/sync.yml).

## Setup (once)

1. Firebase console → Authentication → Sign-in method: enable **Anonymous** and **Google**. Under Settings →
   Authorized domains, add `jonchao.github.io`.
2. Firebase console → Project settings → Service accounts → Generate new private key, then:
   `gh secret set FIREBASE_SERVICE_ACCOUNT --repo jonchao/poi-planner < key.json` and delete the file.
3. `gh secret set PLANNER_OWNER --repo jonchao/poi-planner` with the owner's Google email. The first sync run
   creates the planner list from it.
4. Push (or run the "Publish Firestore rules" workflow) to publish `firestore.rules`.
