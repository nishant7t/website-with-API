// ─── Cloudflare Worker — Maths Solver ────────────────────────────────────────
// Deploy this at: dash.cloudflare.com → Workers → Create Worker
// Add secret: Settings → Variables → GEMINI_KEY = your API key

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type":                 "application/json",
};

// ── In-memory stats (resets on worker restart, good enough for free tier) ──
let stats = {
  total_requests:  0,
  total_users:     new Set(),
  text_solves:     0,
  image_solves:    0,
  errors:          0,
  last_used:       null,
  questions_log:   [],   // last 50 questions
};

export default {
  async fetch(request, env) {

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Only allow POST
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405, headers: CORS
      });
    }

    // ── Rate limiting per IP ──────────────────────────────────────────────────
    const ip         = request.headers.get("CF-Connecting-IP") || "unknown";
    const country    = request.headers.get("CF-IPCountry")     || "unknown";
    const userAgent  = request.headers.get("User-Agent")       || "unknown";

    // ── Parse request ─────────────────────────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400, headers: CORS
      });
    }

    const { question, image, mime, type } = body;

    // Validate input
    if (!question && !image) {
      return new Response(JSON.stringify({ error: "No question or image provided" }), {
        status: 400, headers: CORS
      });
    }

    // ── Update stats ──────────────────────────────────────────────────────────
    stats.total_requests++;
    stats.total_users.add(ip);
    stats.last_used = new Date().toISOString();
    if (image) stats.image_solves++;
    else        stats.text_solves++;

    // Log question (keep last 50)
    if (question) {
      stats.questions_log.push({
        q:       question.substring(0, 120),  // truncate long questions
        time:    new Date().toISOString(),
        country: country,
        type:    image ? "image" : "text"
      });
      if (stats.questions_log.length > 50) stats.questions_log.shift();
    }

    // ── Build Gemini request ──────────────────────────────────────────────────
    const systemPrompt =
      "You are a helpful maths tutor. Solve the problem step by step. " +
      "Show each step clearly with explanation. " +
      "At the end write 'Final Answer:' on a new line with the answer. " +
      "Be clear and concise.";

    const parts = [];

    if (question) {
      parts.push({ text: systemPrompt + "\n\nProblem: " + question });
    }

    if (image && mime) {
      if (!question) parts.push({ text: systemPrompt + "\n\nSolve the maths problem in this image:" });
      parts.push({ inline_data: { mime_type: mime, data: image } });
    }

    // ── Call Gemini API ───────────────────────────────────────────────────────
    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_KEY}`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ contents: [{ parts }] })
        }
      );

      const data = await geminiRes.json();

      if (data.error) {
        stats.errors++;
        return new Response(JSON.stringify({ error: data.error.message }), {
          status: 500, headers: CORS
        });
      }

      const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response received.";

      return new Response(JSON.stringify({
        answer,
        stats: {
          total_requests: stats.total_requests,
          unique_users:   stats.total_users.size,
        }
      }), { headers: CORS });

    } catch (err) {
      stats.errors++;
      return new Response(JSON.stringify({ error: "Failed to reach AI: " + err.message }), {
        status: 500, headers: CORS
      });
    }
  }
};
