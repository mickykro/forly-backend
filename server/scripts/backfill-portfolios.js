#!/usr/bin/env node
/**
 * backfill-portfolios.js — idempotent migration for portfolio routes and property slugs.
 *
 * Usage:
 *   node server/scripts/backfill-portfolios.js --dry-run  # preview changes
 *   node server/scripts/backfill-portfolios.js --apply    # write to Firestore
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS to be set for Firestore access.
 */

const { portfolioSlug, propertySlug, nextPortfolioStatus } = require("../portfolio");

// Initialize Firebase Admin
let db, FieldValue;
function initFirebase() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error("Error: GOOGLE_APPLICATION_CREDENTIALS must be set");
    process.exit(1);
  }
  const admin = require("firebase-admin");
  admin.initializeApp();
  db = admin.firestore();
  FieldValue = admin.firestore.FieldValue;
}

// ponytail: base-30 short codes matching db.js
const SHORT_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function shortCode(n) {
  const bytes = require("crypto").randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += SHORT_ALPHABET[bytes[i] % SHORT_ALPHABET.length];
  return out;
}

async function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const apply = args.includes("--apply");

  if (!dryRun && !apply) {
    console.log("Usage: node backfill-portfolios.js [--dry-run | --apply]");
    console.log("  --dry-run  Preview changes without writing");
    console.log("  --apply    Write changes to Firestore");
    process.exit(1);
  }

  initFirebase();

  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}\n`);

  // Load all data
  console.log("Loading businesses...");
  const businessSnap = await db.collection("businesses").limit(5000).get();
  const businessByPhone = new Map();
  businessSnap.docs.forEach((d) => businessByPhone.set(d.id, { ref: d.ref, ...d.data() }));
  console.log(`  Found ${businessByPhone.size} businesses`);

  console.log("Loading property pages...");
  const pagesSnap = await db.collection("property_pages").limit(10000).get();
  const pagesByBusiness = new Map();
  pagesSnap.docs.forEach((d) => {
    const data = d.data();
    const phone = data.business_phone;
    if (!pagesByBusiness.has(phone)) pagesByBusiness.set(phone, []);
    pagesByBusiness.get(phone).push({ ref: d.ref, ...data });
  });
  console.log(`  Found ${pagesSnap.size} pages across ${pagesByBusiness.size} businesses\n`);

  console.log("Loading existing slug reservations...");
  const slugSnap = await db.collection("portfolio_slugs").limit(5000).get();
  const existingSlugs = new Map();
  slugSnap.docs.forEach((d) => existingSlugs.set(d.id, d.data()));
  console.log(`  Found ${existingSlugs.size} existing reservations\n`);

  // Track changes
  const stats = {
    businessesScanned: 0,
    portfoliosChanged: 0,
    pagesScanned: 0,
    pagesChanged: 0,
    collisions: [],
  };

  // Process each business with pages
  for (const [phone, pages] of pagesByBusiness) {
    stats.businessesScanned++;
    const business = businessByPhone.get(phone) || {};
    const existingPortfolio = business.portfolio || {};

    // Generate or use existing slug
    const candidateSlug = existingPortfolio.slug ||
      portfolioSlug(business.business_name || business.full_name || "");

    // Check for collisions
    const existing = existingSlugs.get(candidateSlug);
    if (existing && existing.business_phone !== phone) {
      stats.collisions.push({ slug: candidateSlug, claimedBy: existing.business_phone, wantedBy: phone });
      continue;
    }

    // Count active pages
    const activeCount = pages.filter((p) =>
      p.status === "active" || p.status === "expiring"
    ).length;

    // Determine status
    const currentStatus = existingPortfolio.status || "draft";
    const newStatus = nextPortfolioStatus(currentStatus, activeCount);

    // Check if portfolio needs update
    const needsPortfolioUpdate = !existingPortfolio.slug ||
      existingPortfolio.status !== newStatus;

    if (needsPortfolioUpdate) {
      stats.portfoliosChanged++;
      console.log(`  ${dryRun ? "[DRY]" : ""} Portfolio ${phone}: slug=${candidateSlug}, status=${currentStatus}->${newStatus}, active=${activeCount}`);

      if (!dryRun) {
        const batch = db.batch();
        // Update business with portfolio config
        batch.set(business.ref || db.collection("businesses").doc(phone), {
          portfolio: {
            slug: candidateSlug,
            status: newStatus,
            hero: existingPortfolio.hero || { headline: "", intro: "", portrait_url: null },
            about: existingPortfolio.about || { body: "" },
            area: existingPortfolio.area || { headline: "", body: "", locations: [] },
            testimonials: existingPortfolio.testimonials || [],
            theme: existingPortfolio.theme || { primary: null, accent: null, font_url: null },
            created_at: existingPortfolio.created_at || new Date(),
            updated_at: new Date(),
          },
        }, { merge: true });
        // Reserve slug
        batch.set(db.collection("portfolio_slugs").doc(candidateSlug), {
          business_phone: phone,
          current_slug: candidateSlug,
          created_at: new Date(),
        }, { merge: true });
        await batch.commit();
      }
    }

    // Mark slug as used (for collision detection in this run)
    existingSlugs.set(candidateSlug, { business_phone: phone, current_slug: candidateSlug });

    // Process pages
    for (const page of pages) {
      stats.pagesScanned++;
      const needsPageUpdate = !page.public_slug;

      if (needsPageUpdate) {
        stats.pagesChanged++;
        const newPublicSlug = propertySlug(
          page.property?.address || "",
          shortCode(3)
        );
        console.log(`  ${dryRun ? "[DRY]" : ""} Page ${page.page_id}: public_slug=${newPublicSlug}`);

        if (!dryRun) {
          await page.ref.update({
            public_slug: newPublicSlug,
            portfolio_visible: true,
            portfolio_rank: null,
          });
        }
      }
    }
  }

  // Report
  console.log("\n=== Summary ===");
  console.log(`Businesses scanned: ${stats.businessesScanned}`);
  console.log(`Portfolios changed: ${stats.portfoliosChanged}`);
  console.log(`Pages scanned: ${stats.pagesScanned}`);
  console.log(`Pages changed: ${stats.pagesChanged}`);
  console.log(`Collisions: ${stats.collisions.length}`);

  if (stats.collisions.length > 0) {
    console.log("\n=== Collisions (must be resolved manually) ===");
    for (const c of stats.collisions) {
      console.log(`  Slug "${c.slug}" claimed by ${c.claimedBy}, wanted by ${c.wantedBy}`);
    }
    if (!dryRun) {
      console.error("\nERROR: Collisions exist, aborting write.");
      process.exit(1);
    }
  }

  console.log(`\n${dryRun ? "Dry run complete. No writes performed." : "Migration complete."}`);
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
