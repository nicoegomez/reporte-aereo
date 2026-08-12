/* =============================================================
   REPORTE AÉREO — worker.js
   Backend: login, perfil, y CRUD de notas (con imágenes) vía
   GitHub Contents API + D1 como fuente de verdad.
   Sirve el resto del sitio como assets estáticos.
   ============================================================= */

const GITHUB_OWNER = "nicoegomez";
const GITHUB_REPO = "reporte-aereo";
const GITHUB_BRANCH = "main";
const SESSION_COOKIE = "ra_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 horas

/* ---------------- utils ---------------- */

function jsonResponse(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, extraHeaders || {}),
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

async function requireSession(request, env) {
  return verifySession(env, getCookie(request, SESSION_COOKIE));
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

/* body: párrafos separados por línea en blanco. Soporta placeholders
   {{img:URL}} o {{img:URL|ALT}} en su propia línea -> <figure><img></figure> */
function bodyToHtml(body) {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const imgMatch = p.match(/^\{\{img:([^|}]+)(?:\|([^}]*))?\}\}$/);
      if (imgMatch) {
        const url = escapeHtml(imgMatch[1].trim());
        const alt = escapeHtml((imgMatch[2] || "").trim());
        return `<figure class="article-inline-img"><img src="${url}" alt="${alt}" loading="lazy">${
          alt ? `<figcaption>${alt}</figcaption>` : ""
        }</figure>`;
      }
      return `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`;
    })
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
  return { sha: data.sha, content: decodeURIComponent(escape(atob(data.content.replace(/\n/g, "")))) };
}

async function githubPutFile(env, path, content, message, sha, isBase64) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(
    path
  )}`;
  const body = {
    message,
    content: isBase64 ? content : btoa(unescape(encodeURIComponent(content))),
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

async function githubDeleteFile(env, path, message) {
  const existing = await githubGetFile(env, path);
  if (!existing) return; // ya no existe, nada que hacer
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(
    path
  )}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "reporte-aereo-admin",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, sha: existing.sha, branch: GITHUB_BRANCH }),
  });
  if (!res.ok && res.status !== 404) throw new Error(`GitHub DELETE ${path} failed: ${res.status} ${await res.text()}`);
}

/* ---------------- article template + json index ---------------- */

function renderArticleHtml({ title, dek, category, author, dateLabel, bodyHtml, coverImageUrl }) {
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
      <p class="article-dek">${escapeHtml(dek || "")}</p>
      <p class="article-byline">Por <a class="author-link" href="https://www.linkedin.com/in/nicolasezequielgomez/" target="_blank" rel="noopener">${escapeHtml(
        author
      )}</a> · ${escapeHtml(dateLabel)}</p>
      ${coverImageUrl ? `<figure class="article-cover-img"><img src="${escapeHtml(coverImageUrl)}" alt="${escapeHtml(title)}"></figure>` : ""}
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

function dateLabelFor(iso) {
  return new Date(iso).toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" });
}

async function regenerateArticlesJson(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM articles WHERE status = 'published' ORDER BY featured DESC, sort_order DESC, id DESC"
  ).all();

  const list = results.map((a) => ({
    id: a.id,
    title: a.title,
    dek: a.dek || "",
    category: a.category,
    author: a.author,
    date: a.created_at,
    dateLabel: dateLabelFor(a.created_at),
    url: `notas/${a.slug}.html`,
    image: a.cover_image_url || "",
    featured: !!a.featured,
  }));

  const existing = await githubGetFile(env, "assets/articles.json");
  await githubPutFile(
    env,
    "assets/articles.json",
    JSON.stringify(list, null, 2),
    "Actualizar índice de notas",
    existing ? existing.sha : null
  );
}

async function regenerateArticleFile(env, article) {
  const html = renderArticleHtml({
    title: article.title,
    dek: article.dek,
    category: article.category,
    author: article.author,
    dateLabel: dateLabelFor(article.created_at),
    bodyHtml: bodyToHtml(article.body),
    coverImageUrl: article.cover_image_url,
  });
  const path = `notas/${article.slug}.html`;
  const existing = await githubGetFile(env, path);
  await githubPutFile(env, path, html, `Actualizar nota: ${article.title}`, existing ? existing.sha : null);
}

/* ---------------- auth handlers ---------------- */

async function handleLogin(request, env) {
  const { username, password } = await request.json();
  if (!username || !password) return jsonResponse({ error: "Faltan credenciales" }, 400);

  const row = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
  if (!row) return jsonResponse({ error: "Usuario o contraseña incorrectos" }, 401);

  const hash = await sha256Hex(password);
  if (hash !== row.password_hash) return jsonResponse({ error: "Usuario o contraseña incorrectos" }, 401);

  const token = await createSession(env, row);
  return jsonResponse(
    { ok: true, displayName: row.display_name, role: row.role },
    200,
    { "Set-Cookie": setSessionCookie(token) }
  );
}

async function handleLogout() {
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

async function handleMe(request, env) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);
  return jsonResponse({ username: session.u, displayName: session.n, role: session.r });
}

async function handleChangePassword(request, env) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const { currentPassword, newPassword, confirmPassword } = await request.json();
  if (!currentPassword || !newPassword || !confirmPassword) {
    return jsonResponse({ error: "Completá todos los campos" }, 400);
  }
  if (newPassword.length < 8) return jsonResponse({ error: "La nueva contraseña debe tener al menos 8 caracteres" }, 400);
  if (newPassword !== confirmPassword) return jsonResponse({ error: "Las contraseñas no coinciden" }, 400);

  const row = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(session.u).first();
  if (!row) return jsonResponse({ error: "Usuario no encontrado" }, 404);

  const currentHash = await sha256Hex(currentPassword);
  if (currentHash !== row.password_hash) return jsonResponse({ error: "Contraseña actual incorrecta" }, 401);

  const newHash = await sha256Hex(newPassword);
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE username = ?").bind(newHash, session.u).run();

  return jsonResponse({ ok: true });
}

/* ---------------- image upload ---------------- */

function extFromMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "jpg";
}

async function handleUploadImage(request, env) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const { dataBase64, mime } = await request.json();
  if (!dataBase64) return jsonResponse({ error: "Falta la imagen" }, 400);

  const ext = extFromMime(mime || "image/jpeg");
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const path = `assets/notas-img/${filename}`;

  await githubPutFile(env, path, dataBase64, `Subir imagen: ${filename}`, null, true);

  return jsonResponse({ ok: true, url: `/assets/notas-img/${filename}` });
}

/* ---------------- articles CRUD ---------------- */

async function handleListArticles(request, env) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const { results } = await env.DB.prepare(
    "SELECT id, slug, title, category, author, cover_image_url, featured, sort_order, status, created_at FROM articles ORDER BY featured DESC, sort_order DESC, id DESC"
  ).all();
  return jsonResponse({ articles: results });
}

async function handleGetArticle(request, env, id) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const row = await env.DB.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first();
  if (!row) return jsonResponse({ error: "No encontrada" }, 404);
  return jsonResponse({ article: row });
}

async function handlePublish(request, env) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const { title, category, dek, body, author, coverImageUrl, featured } = await request.json();
  if (!title || !body) return jsonResponse({ error: "Falta título o cuerpo de la nota" }, 400);

  const now = new Date().toISOString();
  const base = slugify(title) || "nota";
  const slug = `${base}-${now.slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;

  const maxOrder = await env.DB.prepare("SELECT MAX(sort_order) as m FROM articles").first();
  const sortOrder = (maxOrder && maxOrder.m ? maxOrder.m : 0) + 1;

  const insert = await env.DB.prepare(
    `INSERT INTO articles (slug, title, dek, category, author, body, cover_image_url, featured, sort_order, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`
  )
    .bind(
      slug,
      title,
      dek || "",
      category || "Actualidad",
      author || session.n,
      body,
      coverImageUrl || null,
      featured ? 1 : 0,
      sortOrder,
      now,
      now
    )
    .run();

  const article = await env.DB.prepare("SELECT * FROM articles WHERE id = ?").bind(insert.meta.last_row_id).first();

  await regenerateArticleFile(env, article);
  await regenerateArticlesJson(env);

  return jsonResponse({ ok: true, id: article.id, url: `/notas/${slug}.html` });
}

async function handleUpdateArticle(request, env, id) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const existing = await env.DB.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first();
  if (!existing) return jsonResponse({ error: "No encontrada" }, 404);

  const { title, category, dek, body, author, coverImageUrl, featured } = await request.json();
  if (!title || !body) return jsonResponse({ error: "Falta título o cuerpo de la nota" }, 400);

  await env.DB.prepare(
    `UPDATE articles SET title=?, dek=?, category=?, author=?, body=?, cover_image_url=?, featured=?, updated_at=? WHERE id=?`
  )
    .bind(
      title,
      dek || "",
      category || "Actualidad",
      author || existing.author,
      body,
      coverImageUrl || null,
      featured ? 1 : 0,
      new Date().toISOString(),
      id
    )
    .run();

  const article = await env.DB.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first();
  await regenerateArticleFile(env, article);
  await regenerateArticlesJson(env);

  return jsonResponse({ ok: true, url: `/notas/${article.slug}.html` });
}

async function handleDeleteArticle(request, env, id) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const existing = await env.DB.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first();
  if (!existing) return jsonResponse({ error: "No encontrada" }, 404);

  await env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
  await githubDeleteFile(env, `notas/${existing.slug}.html`, `Borrar nota: ${existing.title}`);
  await regenerateArticlesJson(env);

  return jsonResponse({ ok: true });
}

async function handleMoveArticle(request, env, id) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const { direction } = await request.json();
  const current = await env.DB.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first();
  if (!current) return jsonResponse({ error: "No encontrada" }, 404);

  const neighbor = await env.DB.prepare(
    direction === "up"
      ? "SELECT * FROM articles WHERE sort_order > ? ORDER BY sort_order ASC LIMIT 1"
      : "SELECT * FROM articles WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1"
  )
    .bind(current.sort_order)
    .first();

  if (!neighbor) return jsonResponse({ ok: true }); // ya está en el extremo

  await env.DB.batch([
    env.DB.prepare("UPDATE articles SET sort_order = ? WHERE id = ?").bind(neighbor.sort_order, current.id),
    env.DB.prepare("UPDATE articles SET sort_order = ? WHERE id = ?").bind(current.sort_order, neighbor.id),
  ]);

  await regenerateArticlesJson(env);
  return jsonResponse({ ok: true });
}

/* ---------------- router ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/login" && request.method === "POST") return await handleLogin(request, env);
      if (path === "/api/logout" && request.method === "POST") return await handleLogout();
      if (path === "/api/me" && request.method === "GET") return await handleMe(request, env);
      if (path === "/api/change-password" && request.method === "POST") return await handleChangePassword(request, env);

      if (path === "/api/upload-image" && request.method === "POST") return await handleUploadImage(request, env);

      if (path === "/api/articles" && request.method === "GET") return await handleListArticles(request, env);
      if (path === "/api/articles" && request.method === "POST") return await handlePublish(request, env);

      const singleMatch = path.match(/^\/api\/articles\/(\d+)$/);
      if (singleMatch && request.method === "GET") return await handleGetArticle(request, env, singleMatch[1]);
      if (singleMatch && request.method === "PUT") return await handleUpdateArticle(request, env, singleMatch[1]);
      if (singleMatch && request.method === "DELETE") return await handleDeleteArticle(request, env, singleMatch[1]);

      const moveMatch = path.match(/^\/api\/articles\/(\d+)\/move$/);
      if (moveMatch && request.method === "POST") return await handleMoveArticle(request, env, moveMatch[1]);
    } catch (e) {
      return jsonResponse({ error: String((e && e.message) || e) }, 500);
    }

    /* todo lo demás: servir assets estáticos */
    return env.ASSETS.fetch(request);
  },
};
