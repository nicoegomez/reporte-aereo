/* =============================================================
   REPORTE AÉREO — worker.js
   Backend mínimo: login + publicación de notas vía GitHub API.
   Sirve el resto del sitio como assets estáticos.
   ============================================================= */

const GITHUB_OWNER = "nicoegomez";
const GITHUB_REPO = "reporte-aereo";
const GITHUB_BRANCH = "main";
const SESSION_COOKIE = "ra_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 horas

/* ---------------- utils ---------------- */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}

async function createSession(env, user) {
  const payload = JSON.stringify({
    u: user.username,
    n: user.display_name,
    r: user.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
  const encoded = base64url(payload);
  const sig = await hmacHex(env.SESSION_SECRET, encoded);
  return `${encoded}.${sig}`;
}

async function verifySession(env, token) {
  if (!token) return null;
  const [encoded, sig] = token.split(".");
  if (!encoded || !sig) return null;
  const expected = await hmacHex(env.SESSION_SECRET, encoded);
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(base64urlDecode(encoded));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function setSessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function slugify(text) {
  return text
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* paragraphs separated by blank lines -> <p> tags (basic, safe-ish) */
function bodyToHtml(body) {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/* ---------------- GitHub Contents API ---------------- */

async function githubGetFile(env, path) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(
    path
  )}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "reporte-aereo-admin",
      Accept: "application/vnd.github+json",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    sha: data.sha,
    content: decodeURIComponent(escape(atob(data.content.replace(/\n/g, "")))),
  };
}

async function githubPutFile(env, path, content, message, sha) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(
    path
  )}`;
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "reporte-aereo-admin",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/* ---------------- article template ---------------- */

function renderArticleHtml({ title, dek, category, author, dateLabel, bodyHtml, slug }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — Reporte Aéreo</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Source+Serif+4:wght@400;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../styles.css?v=20260812">
</head>
<body>
  <header class="top-bar">
    <div class="top-bar-inner">
      <span class="js-date"></span>
      <div class="top-bar-right">
        <a href="mailto:publicidad@reporteaereo.com?subject=Publicidad%20en%20Reporte%20A%C3%A9reo">Publicidad</a>
        <span class="top-bar-sep">·</span>
        <a href="mailto:redaccion@reporteaereo.com">redaccion@reporteaereo.com</a>
        <span class="top-bar-sep">·</span>
        <a href="../index.html#newsletter">Newsletter</a>
      </div>
    </div>
  </header>

  <nav class="main-nav">
    <a href="../index.html" aria-label="Reporte Aéreo — inicio" class="ra-logo ra-logo--compact">
      <span class="ra-logo-bars" aria-hidden="true"><span></span><span></span><span></span></span>
      <span class="ra-logo-word">REPORTE AÉREO</span>
    </a>
  </nav>

  <main class="article-page">
    <article class="article-body-wrap">
      <p class="article-cat-label">${escapeHtml(category)}</p>
      <h1 class="article-title">${escapeHtml(title)}</h1>
      <p class="article-dek">${escapeHtml(dek)}</p>
      <p class="article-byline">Por <a class="author-link" href="https://www.linkedin.com/in/nicolasezequielgomez/" target="_blank" rel="noopener">${escapeHtml(
        author
      )}</a> · ${escapeHtml(dateLabel)}</p>
      <div class="article-body">
${bodyHtml}
      </div>
    </article>
  </main>

  <footer class="site-footer">
    <div class="footer-inner">
      <a href="../index.html" class="ra-logo ra-logo--compact ra-logo--mono" aria-label="Reporte Aéreo — inicio">
        <span class="ra-logo-bars" aria-hidden="true"><span></span><span></span><span></span></span>
        <span class="ra-logo-word">REPORTE AÉREO</span>
      </a>
      <p class="footer-tagline" style="margin-top:.75rem;">Aviación · Turismo · Negocios</p>
    </div>
  </footer>

  <script defer src="../lib/manifest.js"></script>
  <script defer src="../main.js"></script>
</body>
</html>
`;
}

/* ---------------- API handlers ---------------- */

async function handleLogin(request, env) {
  const { username, password } = await request.json();
  if (!username || !password) return jsonResponse({ error: "Faltan credenciales" }, 400);

  const row = await env.DB.prepare("SELECT * FROM users WHERE username = ?")
    .bind(username)
    .first();
  if (!row) return jsonResponse({ error: "Usuario o contraseña incorrectos" }, 401);

  const hash = await sha256Hex(password);
  if (hash !== row.password_hash) return jsonResponse({ error: "Usuario o contraseña incorrectos" }, 401);

  const token = await createSession(env, row);
  return new Response(JSON.stringify({ ok: true, displayName: row.display_name, role: row.role }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Set-Cookie": setSessionCookie(token),
    },
  });
}

async function handleLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Set-Cookie": clearSessionCookie(),
    },
  });
}

async function handleMe(request, env) {
  const session = await verifySession(env, getCookie(request, SESSION_COOKIE));
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);
  return jsonResponse({ username: session.u, displayName: session.n, role: session.r });
}

async function handleChangePassword(request, env) {
  const session = await verifySession(env, getCookie(request, SESSION_COOKIE));
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const { currentPassword, newPassword } = await request.json();
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return jsonResponse({ error: "Contraseña inválida (mínimo 8 caracteres)" }, 400);
  }

  const row = await env.DB.prepare("SELECT * FROM users WHERE username = ?")
    .bind(session.u)
    .first();
  if (!row) return jsonResponse({ error: "Usuario no encontrado" }, 404);

  const currentHash = await sha256Hex(currentPassword);
  if (currentHash !== row.password_hash) return jsonResponse({ error: "Contraseña actual incorrecta" }, 401);

  const newHash = await sha256Hex(newPassword);
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE username = ?")
    .bind(newHash, session.u)
    .run();

  return jsonResponse({ ok: true });
}

async function handlePublish(request, env) {
  const session = await verifySession(env, getCookie(request, SESSION_COOKIE));
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const { title, category, dek, body, author } = await request.json();
  if (!title || !body) return jsonResponse({ error: "Falta título o cuerpo de la nota" }, 400);

  const now = new Date();
  const dateLabel = now.toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" });
  const slugBase = slugify(title) || "nota";
  const slug = `${slugBase}-${now.toISOString().slice(0, 10)}`;
  const path = `notas/${slug}.html`;

  const html = renderArticleHtml({
    title,
    dek: dek || "",
    category: category || "Actualidad",
    author: author || session.n,
    dateLabel,
    bodyHtml: bodyToHtml(body),
    slug,
  });

  await githubPutFile(env, path, html, `Nueva nota: ${title}`, null);

  /* actualizar articles.json (índice para la sección "Últimas notas") */
  const existing = await githubGetFile(env, "assets/articles.json");
  let list = [];
  let sha = null;
  if (existing) {
    sha = existing.sha;
    try {
      list = JSON.parse(existing.content);
    } catch (_) {
      list = [];
    }
  }
  list.unshift({
    title,
    dek: dek || "",
    category: category || "Actualidad",
    author: author || session.n,
    date: now.toISOString(),
    dateLabel,
    url: `notas/${slug}.html`,
  });
  list = list.slice(0, 30); // conservar las últimas 30

  await githubPutFile(
    env,
    "assets/articles.json",
    JSON.stringify(list, null, 2),
    `Actualizar índice de notas: ${title}`,
    sha
  );

  return jsonResponse({ ok: true, url: `/notas/${slug}.html` });
}

/* ---------------- router ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        return await handleLogin(request, env);
      } catch (e) {
        return jsonResponse({ error: String(e.message || e) }, 500);
      }
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return handleLogout();
    }
    if (url.pathname === "/api/me" && request.method === "GET") {
      return handleMe(request, env);
    }
    if (url.pathname === "/api/change-password" && request.method === "POST") {
      try {
        return await handleChangePassword(request, env);
      } catch (e) {
        return jsonResponse({ error: String(e.message || e) }, 500);
      }
    }
    if (url.pathname === "/api/publish" && request.method === "POST") {
      try {
        return await handlePublish(request, env);
      } catch (e) {
        return jsonResponse({ error: String(e.message || e) }, 500);
      }
    }

    /* todo lo demás: servir assets estáticos */
    return env.ASSETS.fetch(request);
  },
};
