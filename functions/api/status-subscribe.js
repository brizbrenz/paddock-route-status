/* ═══════════════════════════════════════════════════════════════════════
   PADDOCK ROUTE — STATUS ALERTS SUBSCRIBE  ·  Cloudflare Pages Function
   ───────────────────────────────────────────────────────────────────────
   Endpoint:  POST /api/status-subscribe
   Accepts :  { "email": "you@example.com", "source": "status-page" }
   Returns :  200 { ok: true }            on success
              4xx { error: "message" }    on failure

   This mirrors the existing /api/waitlist function. It forwards the email to
   beehiiv, tagged via UTM params so you can build a dedicated "Incident
   alerts" automation / segment around it (no marketing list mixing).

   ─── DEPLOYMENT ────────────────────────────────────────────────────────
   1. Place this file at:   functions/api/status-subscribe.js
      …inside the Cloudflare Pages project that serves paddockroute.online
      (the relative /api/ path only resolves within the same Pages project).

   2. In the Pages project → Settings → Environment variables, add (as
      SECRETS, not plaintext — same as your waitlist function):

         BEEHIIV_API_KEY          your beehiiv API key
         BEEHIIV_PUBLICATION_ID   pub_xxxxxxxx-xxxx-...

      The key is NEVER written into this file or the client. Rotate the old
      key if it was ever shared in plaintext, then set the new one here.

   3. Push → Cloudflare redeploys → the status page subscribe box goes live.

   ─── SEGMENTING IN BEEHIIV ─────────────────────────────────────────────
   These subscribers arrive with:
         utm_source   = status-page
         utm_campaign = incident-alerts
   Build an Automation triggered on "Subscription created where UTM source
   is status-page" → tag / move to an "Incident alerts" audience. That keeps
   status subscribers separate from the marketing waitlist.

   NOTE (the reserved-field gotcha you already hit): if you'd rather use a
   custom field instead of UTM, the field MUST be pre-created in beehiiv
   first, and avoid reserved names. There's a commented custom_fields block
   below if you go that route.
   ═══════════════════════════════════════════════════════════════════════ */

const ALLOWED_ORIGINS = [
  "https://paddockroute.online",
  "https://www.paddockroute.online",
  "https://paddockroute.com.au",
  "https://www.paddockroute.com.au",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* CORS preflight */
export async function onRequestOptions(context) {
  const origin = context.request.headers.get("Origin") || "";
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/* Subscribe handler */
export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get("Origin") || "";

  // 1. Parse body
  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ error: "Invalid request." }, 400, origin);
  }

  const email = String(payload?.email || "").trim().toLowerCase();
  const source = String(payload?.source || "status-page").slice(0, 64);

  // 2. Validate
  if (!email || !EMAIL_RE.test(email)) {
    return json({ error: "Please enter a valid email address." }, 400, origin);
  }

  // 3. Config check
  const API_KEY = env.BEEHIIV_API_KEY;
  const PUB_ID = env.BEEHIIV_PUBLICATION_ID;
  if (!API_KEY || !PUB_ID) {
    // Misconfigured server — don't leak which var is missing to the client.
    return json(
      { error: "Subscription service is not configured yet." },
      503,
      origin
    );
  }

  // 4. Forward to beehiiv
  const body = {
    email,
    reactivate_existing: true,   // re-subscribe if they previously opted out
    send_welcome_email: false,   // status list — no marketing welcome
    utm_source: "status-page",
    utm_medium: "status",
    utm_campaign: "incident-alerts",
    referring_site: source === "status-page" ? "paddockroute.online" : source,

    // ── OPTIONAL: custom field instead of UTM ──────────────────────────
    // The field below must already exist in beehiiv (Audience → Custom
    // fields) and must NOT use a reserved name. Uncomment to use it.
    //
    // custom_fields: [
    //   { name: "Signup Source", value: "Status Page" }
    // ],
  };

  let bhRes, bhData;
  try {
    bhRes = await fetch(
      `https://api.beehiiv.com/v2/publications/${PUB_ID}/subscriptions`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
    try { bhData = await bhRes.json(); } catch (_) { bhData = {}; }
  } catch (_) {
    return json(
      { error: "Couldn't reach the subscription service. Please try again." },
      502,
      origin
    );
  }

  // 5. Interpret beehiiv response
  if (bhRes.ok) {
    // 200/201 — created, or reactivated/already-active (idempotent success)
    return json({ ok: true }, 200, origin);
  }

  // beehiiv treats an already-subscribed address as a 400 in some cases —
  // surface that as success so the user isn't told to "try again".
  const msg = String(bhData?.errors?.[0]?.message || bhData?.message || "");
  if (/already|exist|subscrib/i.test(msg)) {
    return json({ ok: true }, 200, origin);
  }

  if (bhRes.status === 429) {
    return json(
      { error: "Too many requests — please try again in a moment." },
      429,
      origin
    );
  }

  return json(
    { error: "Couldn't subscribe you just now. Please email info@paddockroute.com.au." },
    502,
    origin
  );
}
