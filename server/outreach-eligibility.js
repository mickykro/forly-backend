// Defense in depth if a private demo is accidentally imported into normal pages.
function isPrivateOutreach(page) {
  return (
    !!page &&
    (page.origin === "cold_outreach" ||
      page.visibility === "unlisted" ||
      page.source === "cold_outreach" ||
      page.outreach_demo === true)
  );
}
module.exports = { isPrivateOutreach };
