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

/* Origen canónico del sitio: define las URLs absolutas del sitemap,
   del canonical y de los datos estructurados que lee Google. */
const SITE_ORIGIN = "https://www.reporteaereo.com";
const SITE_NAME = "Reporte Aéreo";
const SITE_LOGO = `${SITE_ORIGIN}/favicon.svg`;

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

/* Marcas de énfasis sobre texto YA escapado: **negrita** y *cursiva*.
   La negrita se resuelve primero para que los ** no se lean como * sueltos. */
function inlineMarks(escaped) {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

/* body: párrafos separados por línea en blanco. Soporta:
     {{img:URL}} o {{img:URL|EPÍGRAFE}}  -> <figure><img></figure>
     ## Subtítulo                        -> <h2>
     > Cita destacada / — Autor          -> <blockquote class="pull-quote">
     **negrita** y *cursiva*             -> <strong> / <em>
   Un cuerpo sin ninguna de estas marcas se renderiza igual que antes. */
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

      if (/^#{2,3}\s+/.test(p) && !p.includes("\n")) {
        return `<h2>${inlineMarks(escapeHtml(p.replace(/^#{2,3}\s+/, "")))}</h2>`;
      }

      if (/^>\s?/.test(p)) {
        const lines = p
          .split("\n")
          .map((l) => l.replace(/^>\s?/, "").trim())
          .filter(Boolean);
        let cite = "";
        if (lines.length > 1 && /^[—–-]\s*/.test(lines[lines.length - 1])) {
          cite = lines.pop().replace(/^[—–-]\s*/, "");
        }
        const text = inlineMarks(escapeHtml(lines.join(" ")));
        return `<blockquote class="pull-quote"><p>${text}</p>${
          cite ? `<cite>${escapeHtml(cite)}</cite>` : ""
        }</blockquote>`;
      }

      return `<p>${inlineMarks(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`;
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

/* Convierte una ruta del sitio o una URL externa en URL absoluta. */
function absoluteUrl(pathOrUrl) {
  if (!pathOrUrl) return "";
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return SITE_ORIGIN + (pathOrUrl.startsWith("/") ? pathOrUrl : "/" + pathOrUrl);
}

/* Resumen para el meta description: la bajada, o el arranque del cuerpo. */
function metaDescription(dek, body) {
  const text = (dek && dek.trim()) || String(body || "").replace(/\{\{img:[^}]*\}\}/g, " ").replace(/[#>*]/g, "");
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function renderArticleHtml({
  title, dek, category, author, dateLabel, bodyHtml, coverImageUrl,
  slug, isoDate, isoUpdated, description,
}) {
  const canonical = `${SITE_ORIGIN}/notas/${slug}.html`;
  const image = absoluteUrl(coverImageUrl) || SITE_LOGO;
  const desc = escapeHtml(description || "");

  /* Datos estructurados: es lo que permite que la nota entre en
     Google News y en Discover como artículo periodístico. */
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    headline: String(title).slice(0, 110),
    description: description || "",
    articleSection: category,
    inLanguage: "es-AR",
    datePublished: isoDate,
    dateModified: isoUpdated || isoDate,
    author: { "@type": "Person", name: author },
    publisher: {
      "@type": "NewsMediaOrganization",
      name: SITE_NAME,
      logo: { "@type": "ImageObject", url: SITE_LOGO },
    },
  };
  if (coverImageUrl) jsonLd.image = [image];

  return `<!DOCTYPE html>
<html lang="es-AR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — Reporte Aéreo</title>
<meta name="description" content="${desc}">
<meta name="author" content="${escapeHtml(author)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="es_AR">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="article:published_time" content="${isoDate}">
<meta property="article:modified_time" content="${isoUpdated || isoDate}">
<meta property="article:section" content="${escapeHtml(category)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${escapeHtml(image)}">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../styles.css?v=20260814">
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
      <span class="ra-mark" aria-hidden="true"><span>RA</span><i></i></span>
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
      )}</a> · <time datetime="${isoDate}">${escapeHtml(dateLabel)}</time></p>
      ${coverImageUrl ? `<figure class="article-cover-img"><img src="${escapeHtml(coverImageUrl)}" alt="${escapeHtml(title)}"></figure>` : ""}
      <div class="article-body">
${bodyHtml}
      </div>
    </article>
  </main>

  <footer class="site-footer">
    <div class="footer-inner">
      <a href="../index.html" class="ra-logo ra-logo--compact ra-logo--mono" aria-label="Reporte Aéreo — inicio">
        <span class="ra-mark" aria-hidden="true"><span>RA</span><i></i></span>
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
    slug: article.slug,
    isoDate: article.created_at,
    isoUpdated: article.updated_at,
    description: metaDescription(article.dek, article.body),
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

  let finalCover = coverImageUrl || null;
  if (!finalCover) finalCover = await autoPhotoForArticle(env, category, title);

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
      finalCover,
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

  let finalCover = coverImageUrl || existing.cover_image_url || null;
  if (!finalCover) finalCover = await autoPhotoForArticle(env, category, title);

  await env.DB.prepare(
    `UPDATE articles SET title=?, dek=?, category=?, author=?, body=?, cover_image_url=?, featured=?, updated_at=? WHERE id=?`
  )
    .bind(
      title,
      dek || "",
      category || "Actualidad",
      author || existing.author,
      body,
      finalCover,
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

/* ---------------- selección automática de fotos (Pexels) ---------------- */

async function findAutoPhoto(env, query) {
  if (!env.PEXELS_API_KEY || !query) return null;
  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(
      query
    )}&per_page=1&orientation=landscape`;
    const res = await fetch(url, { headers: { Authorization: env.PEXELS_API_KEY } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.photos || !data.photos.length) return null;
    return data.photos[0].src.large || data.photos[0].src.original || null;
  } catch (_) {
    return null;
  }
}

/* categoría + título en inglés simplificado ayuda a que Pexels devuelva
   mejores resultados (su buscador funciona mejor en inglés) */
const CATEGORY_QUERY = {
  "Aerolíneas": "airline aircraft",
  "Aeropuertos": "airport terminal",
  "Turismo": "travel destination",
  "Análisis": "aviation business",
  "Entrevista": "aviation industry",
  "Actualidad": "commercial aviation",
};

async function autoPhotoForArticle(env, category, title) {
  const base = CATEGORY_QUERY[category] || "aviation";
  return (await findAutoPhoto(env, base)) || (await findAutoPhoto(env, "airplane sky"));
}

/* ---------------- newsletter ---------------- */

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function handleSubscribe(request, env) {
  let email = "";
  try {
    const body = await request.json();
    email = (body.email || "").trim().toLowerCase();
  } catch (_) {
    return jsonResponse({ error: "Solicitud inválida" }, 400);
  }

  if (!isValidEmail(email)) return jsonResponse({ error: "Ingresá un email válido" }, 400);

  const res = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      email,
      listIds: [Number(env.BREVO_LIST_ID)],
      updateEnabled: true,
    }),
  });

  if (res.ok || res.status === 204) return jsonResponse({ ok: true });

  const errData = await res.json().catch(() => ({}));
  /* ya suscripto: lo tratamos como éxito para el usuario */
  if (errData.code === "duplicate_parameter") return jsonResponse({ ok: true });

  return jsonResponse({ error: "No se pudo completar la suscripción. Probá de nuevo en unos minutos." }, 502);
}

/* ---------------- SEO: sitemap para Google News ---------------- */

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* Se arma en vivo desde D1, así nunca queda desfasado respecto de lo
   publicado. Las notas de menos de 48 h llevan además el bloque
   <news:news>, que es el que mira Google News. */
async function handleSitemap(env) {
  const { results } = await env.DB.prepare(
    "SELECT slug, title, created_at, updated_at FROM articles WHERE status = 'published' ORDER BY created_at DESC"
  ).all();

  const recentCutoff = Date.now() - 48 * 60 * 60 * 1000;
  const urls = [
    `  <url>\n    <loc>${SITE_ORIGIN}/</loc>\n    <changefreq>hourly</changefreq>\n    <priority>1.0</priority>\n  </url>`,
  ];

  for (const a of results) {
    const isRecent = new Date(a.created_at).getTime() > recentCutoff;
    urls.push(
      `  <url>\n` +
        `    <loc>${SITE_ORIGIN}/notas/${xmlEscape(a.slug)}.html</loc>\n` +
        `    <lastmod>${xmlEscape(a.updated_at || a.created_at)}</lastmod>\n` +
        (isRecent
          ? `    <news:news>\n` +
            `      <news:publication>\n` +
            `        <news:name>${xmlEscape(SITE_NAME)}</news:name>\n` +
            `        <news:language>es</news:language>\n` +
            `      </news:publication>\n` +
            `      <news:publication_date>${xmlEscape(a.created_at)}</news:publication_date>\n` +
            `      <news:title>${xmlEscape(a.title)}</news:title>\n` +
            `    </news:news>\n`
          : "") +
        `  </url>`
    );
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n` +
    `${urls.join("\n")}\n</urlset>\n`;

  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=600",
    },
  });
}

/* ---------------- configuración pública del panel ---------------- */

/* El panel pregunta qué hay habilitado. Si no cargaste el client id de
   Google, el botón de "Ingresar con Google" simplemente no aparece. */
function handleConfig(env) {
  return jsonResponse({ googleClientId: env.GOOGLE_CLIENT_ID || "" });
}

/* ---------------- acceso con Google ---------------- */

/* GOOGLE_ALLOWED_EMAILS acepta "mail@dominio.com" o, si querés que la
   sesión adopte un usuario existente del panel, "mail@dominio.com=usuario". */
function parseGoogleAllowlist(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [email, username] = entry.split("=").map((s) => (s || "").trim());
      return { email: email.toLowerCase(), username: username || null };
    });
}

async function handleGoogleLogin(request, env) {
  if (!env.GOOGLE_CLIENT_ID) {
    return jsonResponse({ error: "El acceso con Google no está configurado" }, 400);
  }

  const { credential } = await request.json();
  if (!credential) return jsonResponse({ error: "Falta el token de Google" }, 400);

  const res = await fetch(
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential)
  );
  if (!res.ok) return jsonResponse({ error: "Token de Google inválido" }, 401);
  const info = await res.json();

  if (info.aud !== env.GOOGLE_CLIENT_ID) {
    return jsonResponse({ error: "El token fue emitido para otra aplicación" }, 401);
  }
  if (String(info.email_verified) !== "true") {
    return jsonResponse({ error: "El mail de esa cuenta de Google no está verificado" }, 401);
  }
  if (Number(info.exp) * 1000 < Date.now()) {
    return jsonResponse({ error: "El token de Google expiró, probá de nuevo" }, 401);
  }

  const email = String(info.email || "").toLowerCase();
  const allowed = parseGoogleAllowlist(env.GOOGLE_ALLOWED_EMAILS).find((e) => e.email === email);
  if (!allowed) {
    return jsonResponse({ error: "Esa cuenta de Google no tiene acceso a la redacción" }, 403);
  }

  let user = null;
  if (allowed.username) {
    user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(allowed.username).first();
  }
  if (!user) {
    user = { username: email, display_name: info.name || email, role: "editor" };
  }

  const token = await createSession(env, user);
  return jsonResponse({ ok: true, displayName: user.display_name, role: user.role }, 200, {
    "Set-Cookie": setSessionCookie(token),
  });
}

/* ---------------- importar desde Google Docs ---------------- */

/* Lee un documento compartido por enlace y lo trae al editor. La primera
   línea con texto pasa a ser el título y el resto, el cuerpo. */
async function handleImportDoc(request, env) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const { url } = await request.json();
  const match = String(url || "").match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return jsonResponse({ error: "Pegá el enlace de un documento de Google Docs" }, 400);

  const res = await fetch(`https://docs.google.com/document/d/${match[1]}/export?format=txt`, {
    redirect: "follow",
  });
  const text = res.ok ? await res.text() : "";

  /* Un documento privado no da error: devuelve la pantalla de login. */
  if (!res.ok || /^\s*<!DOCTYPE html/i.test(text) || /accounts\.google\.com/i.test(text.slice(0, 500))) {
    return jsonResponse(
      { error: "No pude leer el documento. Compartilo como «Cualquier persona con el enlace»." },
      403
    );
  }

  const lines = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  const titleIndex = lines.findIndex((l) => l.trim());
  const title = titleIndex >= 0 ? lines[titleIndex].trim() : "";
  const body = lines
    .slice(titleIndex + 1)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return jsonResponse({ ok: true, title, body });
}

/* ---------------- router ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/sitemap.xml" && request.method === "GET") return await handleSitemap(env);
      if (path === "/api/config" && request.method === "GET") return handleConfig(env);

      if (path === "/api/login" && request.method === "POST") return await handleLogin(request, env);
      if (path === "/api/login/google" && request.method === "POST") return await handleGoogleLogin(request, env);
      if (path === "/api/import-doc" && request.method === "POST") return await handleImportDoc(request, env);
      if (path === "/api/logout" && request.method === "POST") return await handleLogout();
      if (path === "/api/me" && request.method === "GET") return await handleMe(request, env);
      if (path === "/api/change-password" && request.method === "POST") return await handleChangePassword(request, env);

      if (path === "/api/upload-image" && request.method === "POST") return await handleUploadImage(request, env);
      if (path === "/api/subscribe" && request.method === "POST") return await handleSubscribe(request, env);

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
