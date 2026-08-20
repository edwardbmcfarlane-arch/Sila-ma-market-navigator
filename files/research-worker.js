// ============================================================
// Sila M&A Market Navigator — Research Worker
// Cloudflare Worker: proxies the Anthropic API with web search
// for two tasks called from the tool's Data & Research tab:
//   1. refresh-state  — re-verify a state's licensing/incentive data
//   2. scout-targets  — find acquisition-candidate companies in a metro
//
// SETUP (same pattern as the GM Success Coach worker):
//   1. Cloudflare dashboard → Workers → Create Worker → paste this file
//   2. Settings → Variables → add secret: ANTHROPIC_API_KEY
//   3. (Optional, for persistent updates) add secrets:
//        GITHUB_TOKEN  — fine-grained PAT with contents:write on the repo
//        GITHUB_REPO   — e.g. "edwardbmcfarlane-arch/sila-ma-market-navigator"
//   4. Deploy, copy the worker URL, paste it into RESEARCH_WORKER_URL
//      in index.html's data block, re-upload index.html.
//   5. Lock it down: in ALLOWED_ORIGINS below, keep only your Pages URL.
// ============================================================

const ALLOWED_ORIGINS = [
  "https://edwardbmcfarlane-arch.github.io"
];

const MODEL = "claude-sonnet-4-6";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, corsHeaders);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400, corsHeaders); }

    try {
      if (body.task === "refresh-state") {
        const report = await refreshState(env, body.state);
        return json({ report }, 200, corsHeaders);
      }
      if (body.task === "scout-targets") {
        const report = await scoutTargets(env, body.metro, body.profile);
        return json({ report }, 200, corsHeaders);
      }
      if (body.task === "legal-screen") {
        const report = await legalScreen(env, body.company, body.state, body.metro);
        return json({ report }, 200, corsHeaders);
      }
      return json({ error: "Unknown task" }, 400, corsHeaders);
    } catch (e) {
      return json({ error: String(e) }, 500, corsHeaders);
    }
  }
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

async function callClaude(env, system, userPrompt, maxSearches) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      system,
      messages: [{ role: "user", content: userPrompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }]
    })
  });
  if (!resp.ok) throw new Error("Anthropic API " + resp.status + ": " + (await resp.text()).slice(0, 300));
  const data = await resp.json();
  return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

async function refreshState(env, stateAbbr) {
  const system = `You are a research assistant for Sila Services' M&A market-analysis tool.
Research the CURRENT contractor licensing requirements for HVAC, plumbing, and electrical
work in the requested US state, using official state licensing board sources wherever possible.
Report concisely in this exact structure:
LICENSING MODEL: (one line — state-only / state+municipal / none, and which boards)
MOAT ASSESSMENT: (1-5 where 5 = hardest greenfield entry, with one-sentence justification;
consider license thresholds, experience requirements, exams, and reciprocity agreements)
RECIPROCITY: (which states, if any)
INCENTIVE EXPOSURE: (Low/Moderate/High — electrification/heat-pump incentive dependency)
KEY FACTS: (3-5 bullets an M&A analyst should know)
SOURCES: (authorities consulted)
Note anything that has CHANGED recently. Be factual; flag uncertainty explicitly.`;
  return callClaude(env, system, `Research current trade licensing for the state: ${stateAbbr}`, 5);
}

async function scoutTargets(env, metro, profile) {
  const system = `You are an acquisition-sourcing research assistant for Sila Services,
a home-services platform (HVAC, plumbing, electrical) that grows via acquisition.
Using web search, identify independent home-services companies in the requested metro
that appear to match the target profile. TRIANGULATE across these public source types,
in priority order:
1. METRO BUSINESS JOURNAL LISTS — search "[metro] Business Journal largest HVAC contractors"
   and "[metro] Book of Lists mechanical contractors." American City Business Journals
   markets publish annual ranked lists with metro revenue, employee counts, and year founded.
   These are the highest-quality size data publicly available; cite the list year.
2. COMPANY WEBSITES — trades offered, service area, "since 19XX," team/careers pages
   (headcount signals), fleet mentions, multiple locations.
3. STATE LICENSE LOOKUPS — public contractor license databases (e.g., Ohio eLicense,
   Virginia DPOR, Maryland HVACR Board) confirm entity names, license classes, and tenure.
4. PERMIT ACTIVITY — BuildZoom or municipal permit-portal mentions as install-volume proxies.
5. INDUSTRY RANKINGS & NEWS — ACHR News rankings, Inc. 5000, local "fastest growing" lists,
   anniversary/expansion articles in local press.
6. D&B / directory profiles — publicly viewable dnb.com company profiles for revenue and
   employee ESTIMATES only; label them as modeled estimates, never as verified figures.
For each candidate (aim for 5-10), report in this structure:
- Company name | city | trades
- Est. revenue band + employees — WITH the source of each figure (e.g., "Business Journal
  2025 list: $14M metro revenue" vs "D&B modeled estimate: ~$8M")
- Year founded / years in business + source
- GOOGLE REVIEWS: star rating + review COUNT (e.g., "4.8 stars, ~2,400 reviews"). Review
  count is the best free proxy for residential call volume — a 4.7x2,000-review shop runs
  far more volume than a 5.0x40 one. Note rating trend or recent-review complaints if visible.
- Ownership signals (family-owned language, founder-led, generation, succession hints)
- Fit notes vs. the profile
- Website
- CONFIDENCE: High (business-journal or license-verified) / Medium (website + directory) /
  Low (single-source or estimate-only)
IMPORTANT RULES:
- Only use publicly available information. Never present D&B or directory revenue estimates
  as actual figures — always label estimates as estimates.
- Do NOT include companies clearly owned by a private-equity platform or national
  consolidator; flag ambiguous ownership.
- These are LEADS for human review, not vetted targets. Say so at the end.
- If the metro appears heavily consolidated, say that plainly.
- End with: which Business Journal "Book of Lists" edition covers this metro, so the team
  can purchase the full list for complete revenue/employee data.`;
  const prompt = `Metro: ${metro.name}, ${metro.state} (${metro.population}).
Target profile: ${profile}
Market context from our tool: ${metro.archetype}`;
  return callClaude(env, system, prompt, 8);
}

async function legalScreen(env, company, state, metro) {
  const system = `You are performing a PRELIMINARY public-records and reputation screen on a
potential acquisition target for Sila Services. Using web search, check these public sources:
1. LICENSE-BOARD DISCIPLINE — search "[company] [state] license board disciplinary action"
   and check the state's contractor licensing lookup for revocations, suspensions, or fines.
2. LAWSUITS & COURT RECORDS — search "[company] lawsuit", "[company] court", "[company] sued".
   Note federal/state case mentions, judgments, and settlements that appear in public coverage.
3. REGULATORY ACTIONS — state Attorney General consumer-protection actions, FTC actions.
4. OSHA — search "[company] OSHA citation" (OSHA enforcement data is public).
5. BBB — rating, accreditation status, complaint volume and pattern.
6. GOOGLE REVIEWS — star rating, review count, and any PATTERN in negative reviews
   (billing disputes, unfinished work, warranty refusal — patterns matter, single reviews don't).
7. NEWS — local press coverage of disputes, liens, bankruptcy filings, or labor issues.
STRICT REPORTING RULES:
- Report only what public records and published sources actually document. Cite the source
  type for every finding (court record, news article, BBB, license board, OSHA database).
- Distinguish clearly between: ADJUDICATED (judgment, fine, revocation), FILED/ALLEGED
  (pending suit, complaint), and REPUTATION SIGNAL (review patterns, BBB complaints).
- Ordinary litigation exposure is NORMAL for contractors (injury claims, collections,
  employment disputes). Flag PATTERNS and severity, not the mere existence of a case.
- If nothing adverse surfaces, say exactly that — and note that absence of findings in
  public web search is NOT a clean bill: formal diligence (background checks, litigation
  search databases, UCC/lien searches) is still required before any LOI.
- This is a preliminary screen to prioritize human attention, not legal due diligence.
Structure: SUMMARY VERDICT (Clear / Minor signals / Investigate before proceeding) →
findings by category with sources → what formal diligence should check next.`;
  const prompt = `Company: ${company}
State: ${state}${metro ? `\nMetro: ${metro}` : ""}
Run the public-records and reputation screen.`;
  return callClaude(env, system, prompt, 8);
}
