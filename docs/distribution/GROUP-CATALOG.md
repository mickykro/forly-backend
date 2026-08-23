# Group Catalog — filling it with real groups (Manus research pipeline)

The dashboard's group picker reads the `group_catalog` Firestore collection.
Facebook removed the group-search API, so the catalog is filled from OUTSIDE
the Graph API — by a research agent (Manus, which is logged into Facebook)
running through n8n, the same pattern as the carousel workflow
(n8n → Manus → HTTP callback).

## The import endpoint

`POST /api/distribution/group-catalog/import`
Header: `x-admin-secret: <FORLY_JWT_SECRET>`
Body:

```json
{
  "groups": [
    { "name": "דירות מפה לאוזן בתל אביב", "url": "https://www.facebook.com/groups/101875683484689", "city": "תל אביב", "members": 120000 }
  ]
}
```

Rules: URLs are sanitized (facebook.com/groups/* only), deduped against the
existing catalog, capped at 200 per call. Entries land `active: true` with
`source: "import"`. Agent suggestions from the dashboard land `active: false`
until curated (flip in the Firebase console).

## The Manus task (paste as the task prompt in the n8n Manus node)

> You are logged into Facebook. Research Israeli real-estate Facebook groups
> for these areas: תל אביב, רמת גן/גבעתיים, ירושלים, חיפה והקריות, ראשון
> לציון, פתח תקווה, נתניה, אשדוד/אשקלון, באר שבע, השרון (הרצליה/רעננה/כפר
> סבא), מודיעין, חדרה והעמקים.
> For each area, find the 3–5 most active groups where apartments for sale
> or rent are posted (buy/sell/rent groups, "דירות מפה לאוזן" style groups,
> and local nadlan groups). Prefer groups with 10,000+ members and posts
> from the last week. For each group record: the exact group URL
> (facebook.com/groups/...), the group's full name, the area it serves, and
> the member count.
> Return ONLY a JSON object of the form
> `{"groups":[{"name":"...","url":"...","city":"...","members":12345}]}` —
> no commentary. Skip private groups that reject join requests from business
> profiles; note nothing else.

n8n wiring after the Manus node: HTTP Request node → POST
`https://<host>/api/distribution/group-catalog/import`, header
`x-admin-secret` from the n8n credential store, body = Manus JSON output.

## Starter seed (verified via web search, 2026-08 — import before the pilot)

```bash
curl -X POST "https://<host>/api/distribution/group-catalog/import" \
  -H "x-admin-secret: $FORLY_JWT_SECRET" -H "content-type: application/json" \
  -d '{"groups":[
    {"name":"דירות מפה לאוזן בתל אביב","url":"https://www.facebook.com/groups/101875683484689","city":"תל אביב"},
    {"name":"תל אביב - דירות למכירה והשכרה - שכונות צפוניות לירקון","url":"https://www.facebook.com/groups/2813893472199401","city":"תל אביב"},
    {"name":"דירות, בתים ונדל\"ן ברמת אביב ג׳","url":"https://www.facebook.com/groups/realestateinramatavivgimel","city":"תל אביב"},
    {"name":"דירות להשכרה ולמכירה בראשון לציון","url":"https://www.facebook.com/groups/369537586455596","city":"ראשון לציון"},
    {"name":"גליל ים החדשה - דירות למכירה והשכרה","url":"https://www.facebook.com/groups/realestateglilyam","city":"הרצליה"},
    {"name":"לוח פרסום עסקים נדל\"ן מכירה קנייה השכרה","url":"https://www.facebook.com/groups/1503431096566343","city":"ארצי"}
  ]}'
```

This is a Tel-Aviv-heavy starter — the Manus run is what makes it national.
Aggregators worth pointing Manus at for leads: fb-nadlan.com ("נדלן
בפייסבוק — כל הקבוצות במקום אחד") and nadlanspot.co.il's investor-group list.

## Refresh cadence

Groups die and new ones grow: re-run the Manus task monthly (n8n cron). The
import dedupes by URL, so re-runs only add what's new; pruning dead groups is
a manual flip of `active: false` in the console for now.
