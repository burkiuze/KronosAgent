---
name: competitive-analysis
description: Map competitors for a product or company — features, pricing, positioning, strengths/weaknesses, gaps — into a comparison matrix and recommendations. Use for market landscapes, "who else does X", product strategy and pitch prep.
version: 1.0.0
category: research
tags: [market, competitors, strategy, pricing, product]
requires:
  toolsets: [web, artifacts]
---

# Competitive analysis

1. **Define the arena**: the customer, the job-to-be-done, the region and segment. Write the
   comparison dimensions up front (e.g. core features, integrations, pricing model, target
   customer, deployment, traction signals, differentiation).
2. **Find players**: direct competitors, adjacent substitutes, and the "do nothing / build it
   yourself" option. Sources: search ("alternatives to X", "X vs Y"), G2/Capterra categories,
   Product Hunt, GitHub topics, funding news, job posts.
3. **Collect evidence** per player from primary sources: pricing pages, docs, changelogs,
   status pages, public metrics. Date every data point.
4. **Matrix**: a table players × dimensions. Use ✓ / partial / ✗ plus short notes; don't
   pretend precision you don't have.
5. **Positioning**: 2×2 map on the two dimensions customers care about most.
6. **Insights**: where is the market crowded, where are the gaps, which weaknesses are
   structural vs fixable, pricing anchors, likely next moves.
7. **Recommendations** tied to the user's goal.

Deliver as an artifact (`artifact_create`), with sources and dates. Flag stale or uncertain
data.
