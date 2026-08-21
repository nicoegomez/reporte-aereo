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

/* ---------------- contraseñas ----------------

   Formato guardado: pbkdf2$sha256$<iteraciones>$<sal_b64>$<hash_b64>

   Las iteraciones viajan DENTRO del hash: cada contraseña se verifica
   con el número con el que fue creada. Por eso este valor se puede
   cambiar cuando se quiera sin invalidar ninguna cuenta existente.

   Está en 25.000 para entrar cómodo en el límite de 10 ms de CPU del
   plan gratuito de Workers (medido: ~4 ms). Es menos de lo que
   recomienda OWASP; si el sitio está en el plan pago, subilo a 200000
   y las contraseñas viejas siguen andando igual. Aun así, con sal
   aleatoria por cuenta, esto ya deja sin efecto las tablas
   precalculadas que rompían el SHA-256 pelado anterior.              */

const PBKDF2_ITERATIONS = 25000;

function bytesToB64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}

/* Comparación en tiempo constante: no filtra cuánto coincidió. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function isLegacyHash(stored) {
  return !!stored && !String(stored).startsWith("pbkdf2$");
}

async function verifyPassword(password, stored) {
  if (!stored) return false; // cuenta sin contraseña: ingresa con Google
  if (String(stored).startsWith("pbkdf2$")) {
    const parts = String(stored).split("$");
    if (parts.length !== 5) return false;
    const hash = await pbkdf2(password, b64ToBytes(parts[3]), Number(parts[2]));
    return timingSafeEqual(hash, b64ToBytes(parts[4]));
  }
  /* Formato viejo (SHA-256 sin sal): se acepta una vez y se re-hashea. */
  const legacy = await sha256Hex(password);
  const enc = new TextEncoder();
  return timingSafeEqual(enc.encode(legacy), enc.encode(String(stored)));
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

/* ---------------- roles ----------------

   Dos niveles. "director" es la dirección del medio: publica, edita y
   borra cualquier nota, ordena la portada y administra el equipo.
   Cualquier otro valor se trata como redactor: escribe, y edita o
   borra únicamente lo propio.                                        */

function isDirector(session) {
  return !!session && session.r === "director";
}

async function requireDirector(request, env) {
  const session = await requireSession(request, env);
  if (!session) return { error: jsonResponse({ error: "No autenticado" }, 401) };
  if (!isDirector(session)) {
    return { error: jsonResponse({ error: "Sólo la dirección puede hacer esto" }, 403) };
  }
  return { session };
}

/* ---------------- migración de esquema ----------------

   Corre una vez por isolate y es idempotente: agrega las columnas que
   falten sin tocar los datos. Evita tener que ejecutar SQL a mano.    */

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;

  async function columnsOf(table) {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    return results.map((r) => r.name);
  }

  const userCols = await columnsOf("users");
  const articleCols = await columnsOf("articles");
  const statements = [];

  if (!userCols.includes("active")) statements.push("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  if (!userCols.includes("created_at")) statements.push("ALTER TABLE users ADD COLUMN created_at TEXT");
  if (!userCols.includes("email")) statements.push("ALTER TABLE users ADD COLUMN email TEXT");
  if (!articleCols.includes("created_by")) statements.push("ALTER TABLE articles ADD COLUMN created_by TEXT");
  if (!articleCols.includes("updated_by")) statements.push("ALTER TABLE articles ADD COLUMN updated_by TEXT");

  for (const sql of statements) await env.DB.prepare(sql).run();

  /* Si todavía no hay dirección, la cuenta más antigua la asume: es la
     del dueño del medio, la única que existía antes de los roles. */
  const director = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'director'"
  ).first();
  if (!director || !director.n) {
    await env.DB.prepare(
      "UPDATE users SET role = 'director' WHERE rowid = (SELECT MIN(rowid) FROM users)"
    ).run();
  }

  schemaReady = true;
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

async function handleLogin(request, env, ctx) {
  const { username, password } = await request.json();
  if (!username || !password) return jsonResponse({ error: "Faltan credenciales" }, 400);

  const row = await env.DB.prepare("SELECT * FROM users WHERE lower(username) = lower(?)")
    .bind(String(username).trim())
    .first();
  if (!row) return jsonResponse({ error: "Usuario o contraseña incorrectos" }, 401);
  if (row.active === 0) return jsonResponse({ error: "Esta cuenta está desactivada" }, 403);
  if (!row.password_hash) {
    return jsonResponse({ error: "Esta cuenta ingresa con Google, no con contraseña" }, 401);
  }

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return jsonResponse({ error: "Usuario o contraseña incorrectos" }, 401);

  /* Hash viejo: se reemplaza por PBKDF2 fuera del camino de respuesta,
     para no gastar el presupuesto de CPU del login. */
  if (isLegacyHash(row.password_hash) && ctx && ctx.waitUntil) {
    ctx.waitUntil(
      hashPassword(password).then((upgraded) =>
        env.DB.prepare("UPDATE users SET password_hash = ? WHERE username = ?")
          .bind(upgraded, row.username)
          .run()
      )
    );
  }

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
  return jsonResponse({
    username: session.u,
    displayName: session.n,
    role: session.r,
    isDirector: isDirector(session),
  });
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
  if (!row) {
    return jsonResponse(
      { error: "Tu cuenta ingresa con Google, así que no tiene contraseña que cambiar" },
      400
    );
  }
  if (!row.password_hash) {
    return jsonResponse(
      { error: "Esta cuenta ingresa con Google. Pedile a la dirección que te asigne una contraseña si querés entrar sin Google." },
      400
    );
  }

  const ok = await verifyPassword(currentPassword, row.password_hash);
  if (!ok) return jsonResponse({ error: "Contraseña actual incorrecta" }, 401);

  const newHash = await hashPassword(newPassword);
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE username = ?").bind(newHash, session.u).run();

  return jsonResponse({ ok: true });
}

/* ---------------- equipo (sólo dirección) ---------------- */

const USERNAME_SHAPE = /^[a-z0-9._-]{3,32}$/;

function normalizeRole(role) {
  return role === "director" ? "director" : "redactor";
}

async function handleListUsers(request, env) {
  const guard = await requireDirector(request, env);
  if (guard.error) return guard.error;

  const { results } = await env.DB.prepare(
    `SELECT username, display_name, role, active, created_at, email,
            (password_hash IS NOT NULL AND password_hash != '') AS has_password
       FROM users
      ORDER BY (role = 'director') DESC, display_name`
  ).all();

  return jsonResponse({ users: results, me: guard.session.u });
}

async function handleCreateUser(request, env) {
  const guard = await requireDirector(request, env);
  if (guard.error) return guard.error;

  const { username, displayName, role, password, email } = await request.json();
  const user = String(username || "").trim().toLowerCase();
  const name = String(displayName || "").trim();
  const mail = String(email || "").trim().toLowerCase();

  if (!USERNAME_SHAPE.test(user)) {
    return jsonResponse(
      { error: "El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo" },
      400
    );
  }
  if (!name) return jsonResponse({ error: "Falta el nombre con el que va a firmar" }, 400);
  if (password && String(password).length < 8) {
    return jsonResponse({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);
  }
  if (!password && !mail) {
    return jsonResponse({ error: "Poné una contraseña, o un mail de Google para que entre por ahí" }, 400);
  }

  const exists = await env.DB.prepare("SELECT username FROM users WHERE lower(username) = ?").bind(user).first();
  if (exists) return jsonResponse({ error: "Ya existe una cuenta con ese usuario" }, 409);

  const hash = password ? await hashPassword(String(password)) : "";

  await env.DB.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, active, created_at, email)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(user, hash, name, normalizeRole(role), new Date().toISOString(), mail || null)
    .run();

  return jsonResponse({ ok: true, username: user });
}

/* No dejar el medio sin dirección activa. */
async function wouldLeaveNoDirector(env, username) {
  const others = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'director' AND active = 1 AND username != ?"
  )
    .bind(username)
    .first();
  return !others || !others.n;
}

async function handleUpdateUser(request, env, username) {
  const guard = await requireDirector(request, env);
  if (guard.error) return guard.error;

  const target = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
  if (!target) return jsonResponse({ error: "Usuario no encontrado" }, 404);

  const { role, active, newPassword, displayName, email } = await request.json();

  const losesDirection =
    (role && normalizeRole(role) !== "director" && target.role === "director") ||
    (active === false && target.role === "director");
  if (losesDirection && (await wouldLeaveNoDirector(env, username))) {
    return jsonResponse({ error: "Tiene que quedar al menos una persona en la dirección" }, 400);
  }

  const sets = [];
  const vals = [];
  if (typeof displayName === "string" && displayName.trim()) {
    sets.push("display_name = ?");
    vals.push(displayName.trim());
  }
  if (typeof email === "string") {
    sets.push("email = ?");
    vals.push(email.trim().toLowerCase() || null);
  }
  if (role) {
    sets.push("role = ?");
    vals.push(normalizeRole(role));
  }
  if (typeof active === "boolean") {
    sets.push("active = ?");
    vals.push(active ? 1 : 0);
  }
  if (newPassword) {
    if (String(newPassword).length < 8) {
      return jsonResponse({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);
    }
    sets.push("password_hash = ?");
    vals.push(await hashPassword(String(newPassword)));
  }
  if (!sets.length) return jsonResponse({ ok: true });

  vals.push(username);
  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE username = ?`).bind(...vals).run();
  return jsonResponse({ ok: true });
}

async function handleDeleteUser(request, env, username) {
  const guard = await requireDirector(request, env);
  if (guard.error) return guard.error;

  if (guard.session.u === username) {
    return jsonResponse({ error: "No podés borrar tu propia cuenta" }, 400);
  }

  const target = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
  if (!target) return jsonResponse({ error: "Usuario no encontrado" }, 404);

  if (target.role === "director" && (await wouldLeaveNoDirector(env, username))) {
    return jsonResponse({ error: "Tiene que quedar al menos una persona en la dirección" }, 400);
  }

  await env.DB.prepare("DELETE FROM users WHERE username = ?").bind(username).run();
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
    "SELECT id, slug, title, category, author, cover_image_url, featured, sort_order, status, created_at, created_by FROM articles ORDER BY featured DESC, sort_order DESC, id DESC"
  ).all();
  /* La interfaz usa esto para mostrar sólo las acciones permitidas. */
  return jsonResponse({ articles: results, me: session.u, isDirector: isDirector(session) });
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
    `INSERT INTO articles (slug, title, dek, category, author, body, cover_image_url, featured, sort_order, status, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?)`
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
      now,
      session.u,
      session.u
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

  /* Un redactor sólo toca lo suyo. Las notas anteriores a los roles no
     tienen autor registrado: quedan reservadas a la dirección. */
  if (!isDirector(session) && existing.created_by !== session.u) {
    return jsonResponse({ error: "Sólo podés editar las notas que escribiste vos" }, 403);
  }

  const { title, category, dek, body, author, coverImageUrl, featured } = await request.json();
  if (!title || !body) return jsonResponse({ error: "Falta título o cuerpo de la nota" }, 400);

  let finalCover = coverImageUrl || existing.cover_image_url || null;
  if (!finalCover) finalCover = await autoPhotoForArticle(env, category, title);

  await env.DB.prepare(
    `UPDATE articles SET title=?, dek=?, category=?, author=?, body=?, cover_image_url=?, featured=?, updated_at=?, updated_by=? WHERE id=?`
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
      session.u,
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

  if (!isDirector(session) && existing.created_by !== session.u) {
    return jsonResponse({ error: "Sólo podés borrar las notas que escribiste vos" }, 403);
  }

  await env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
  await githubDeleteFile(env, `notas/${existing.slug}.html`, `Borrar nota: ${existing.title}`);
  await regenerateArticlesJson(env);

  return jsonResponse({ ok: true });
}

async function handleMoveArticle(request, env, id) {
  /* Ordenar la portada es una decisión editorial: sólo la dirección. */
  const guard = await requireDirector(request, env);
  if (guard.error) return guard.error;

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
  "Actualidad":  "commercial aviation",
  "Aeropuertos": "airport terminal",
  "Business":    "aviation business finance",
  "Comercial":   "airline aircraft",
  "Industria":   "aircraft manufacturing industry",
  "Turismo":     "travel destination",
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

  /* La cuenta vive siempre en la tabla de usuarios, así el rol se
     administra desde «Equipo» en un solo lugar. */
  let user = null;
  if (allowed.username) {
    user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(allowed.username).first();
  }
  if (!user) {
    user = await env.DB.prepare("SELECT * FROM users WHERE lower(email) = ? OR lower(username) = ?")
      .bind(email, email)
      .first();
  }

  if (!user) {
    /* Primer ingreso de alguien de la lista: se da de alta como redactor.
       Después la dirección puede subirlo de rol desde el panel. */
    const base = (email.split("@")[0] || "usuario").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 24);
    let username = base.length >= 3 ? base : "usuario";
    let n = 1;
    while (await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(username).first()) {
      username = `${base}${++n}`.slice(0, 32);
    }
    await env.DB.prepare(
      `INSERT INTO users (username, password_hash, display_name, role, active, created_at, email)
       VALUES (?, '', ?, 'redactor', 1, ?, ?)`
    )
      .bind(username, info.name || email, new Date().toISOString(), email)
      .run();
    user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
  }

  if (user.active === 0) return jsonResponse({ error: "Esta cuenta está desactivada" }, 403);

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

/* =============================================================
   BOT DE INGESTA — lee RSS de fuentes reales, redacta un
   resumen propio con atribución y lo guarda como borrador
   o publicado según la confianza de la fuente.

   Regla dura: el modelo sólo puede usar hechos presentes en
   el material de origen. No inventa datos.
   ============================================================= */

const BOT_AUTHOR = "Redacción Reporte Aéreo";
const BOT_MAX_ITEMS_PER_FEED = 3;
const BOT_MAX_AGE_HOURS = 48;

function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&amp;/g, "&");
}

function stripTags(s) {
  return decodeEntities(String(s || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function pickTag(xml, tag) {
  const m = xml.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + tag + ">", "i"));
  return m ? decodeEntities(m[1]).trim() : "";
}

function pickAttr(xml, tag, attr) {
  const m = xml.match(new RegExp("<" + tag + "[^>]*\\b" + attr + "=[\"']([^\"']+)[\"'][^>]*>", "i"));
  return m ? decodeEntities(m[1]).trim() : "";
}

/* Parser de RSS 2.0 y Atom sin DOMParser (no existe en Workers) */
function parseFeed(xml) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blocks = isAtom
    ? xml.match(/<entry[\s\S]*?<\/entry>/gi) || []
    : xml.match(/<item[\s\S]*?<\/item>/gi) || [];

  for (const raw of blocks) {
    const title = stripTags(pickTag(raw, "title"));
    let link = pickTag(raw, "link");
    if (isAtom && !link) link = pickAttr(raw, "link", "href");
    if (!link) link = pickTag(raw, "guid");

    const guid = pickTag(raw, "guid") || pickTag(raw, "id") || link;
    const desc = stripTags(
      pickTag(raw, "content:encoded") ||
      pickTag(raw, "description") ||
      pickTag(raw, "summary") ||
      pickTag(raw, "content")
    );
    const dateRaw =
      pickTag(raw, "pubDate") || pickTag(raw, "published") || pickTag(raw, "updated") || "";

    let image =
      pickAttr(raw, "media:content", "url") ||
      pickAttr(raw, "media:thumbnail", "url") ||
      pickAttr(raw, "enclosure", "url") ||
      "";
    if (!image) {
      const inline = raw.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (inline) image = inline[1];
    }

    if (title && link) {
      items.push({ title, link: link.trim(), guid: (guid || link).trim(), desc, dateRaw, image });
    }
  }
  return items;
}

function parseDateSafe(s) {
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}


/* Cuando el feed sólo trae un teaser, vamos a la nota original y
   extraemos el texto para tener material real con el que trabajar. */
async function fetchSourceText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "ReporteAereoBot/1.0 (+https://reporteaereo.com)",
        Accept: "text/html,application/xhtml+xml",
      },
      cf: { cacheTtl: 600 },
    });
    if (!res.ok) return "";
    const html = await res.text();

    /* preferimos la descripción declarada por el propio sitio */
    const og =
      (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || [])[1] ||
      (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || [])[1] ||
      "";

    /* y sumamos los primeros párrafos del cuerpo */
    let body = html;
    const artMatch = body.match(/<article[\s\S]*?<\/article>/i);
    if (artMatch) body = artMatch[0];

    const paras = (body.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [])
      .map((p) => stripTags(p))
      .filter((t) => t.length > 60)
      .slice(0, 6);

    const text = [decodeEntities(og), paras.join(" ")].join(" ").replace(/\s+/g, " ").trim();
    return text.slice(0, 3500);
  } catch (_) {
    return "";
  }
}

/* ---------------- redacción con IA ---------------- */

const BOT_SYSTEM_PROMPT = [
  "Sos redactor de Reporte Aéreo, un medio argentino de aviación comercial y turismo.",
  "Reescribís material de fuentes en una nota breve, en español rioplatense, con tono sobrio y periodístico.",
  "REGLAS ESTRICTAS:",
  "1. Usá ÚNICAMENTE hechos presentes en el material provisto. No agregues cifras, fechas, nombres, rutas ni declaraciones que no estén.",
  "2. Si el material es demasiado escaso para una nota, respondé exactamente: INSUFICIENTE",
  "3. No copies frases textuales largas: reescribí con tus palabras.",
  "4. No opines ni especules. No uses adjetivos promocionales.",
  "5. Nunca inventes citas.",
  "Devolvé SOLO un JSON válido con este formato, sin texto adicional:",
  '{"titulo":"...","bajada":"...","cuerpo":"..."}',
  "El titulo: máximo 90 caracteres, informativo, sin signos de exclamación.",
  "La bajada: una oración de 140 a 200 caracteres que resuma el hecho.",
  "El cuerpo: 2 a 4 párrafos separados por una línea en blanco. No incluyas el titulo dentro del cuerpo.",
].join("\n");

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

async function runAI(env, messages) {
  const models = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"];
  let lastErr = null;
  for (const model of models) {
    try {
      const res = await env.AI.run(model, { messages, max_tokens: 900, temperature: 0.2 });
      const text = res && (res.response || res.result || res.output_text);
      if (text) return text;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

async function draftFromItem(env, item, feed) {
  /* si el feed sólo trae un teaser, leemos la nota original */
  let material = item.desc || "";
  if (material.length < 400) {
    const full = await fetchSourceText(item.link);
    if (full.length > material.length) material = full;
  }

  if (material.length < 200) {
    return { skip: "material insuficiente (" + material.length + " car.)" };
  }

  const prompt = [
    "TITULO ORIGINAL: " + item.title,
    "FUENTE: " + feed.name,
    "MATERIAL DE LA FUENTE:\n" + material,
  ].join("\n\n");

  const text = await runAI(env, [
    { role: "system", content: BOT_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ]);

  if (!text) return { skip: "la IA no devolvió respuesta" };
  if (/INSUFICIENTE/i.test(text)) return { skip: "la IA marcó el material como insuficiente" };

  const data = extractJson(text);
  if (!data || !data.titulo || !data.cuerpo) {
    return { skip: "respuesta de la IA sin formato válido" };
  }

  const titulo = String(data.titulo).trim().slice(0, 140);
  const bajada = String(data.bajada || "").trim().slice(0, 220);
  let cuerpo = String(data.cuerpo).trim();

  if (titulo.length < 15 || cuerpo.length < 200) {
    return { skip: "texto demasiado corto (" + titulo.length + "/" + cuerpo.length + ")" };
  }

  /* pie de atribución obligatorio */
  cuerpo += "\n\nCon información de " + feed.name + ". Fuente original: " + item.link;

  return { titulo, bajada, cuerpo };
}

/* ---------------- ingesta ---------------- */


function summarizeReasons(reasons) {
  const counts = {};
  for (const r of reasons) counts[r] = (counts[r] || 0) + 1;
  return Object.keys(counts)
    .map((k) => k + " x" + counts[k])
    .join(" | ")
    .slice(0, 400);
}

async function ingestFeed(env, feed) {
  const stat = { feed: feed.name, seen: 0, created: 0, skipped: 0, error: null, reasons: [] };

  let xml;
  try {
    const res = await fetch(feed.url, {
      headers: {
        "User-Agent": "ReporteAereoBot/1.0 (+https://reporteaereo.com)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    xml = await res.text();
  } catch (e) {
    stat.error = String((e && e.message) || e);
    await env.DB.prepare("UPDATE feeds SET last_checked = ?, last_error = ? WHERE id = ?")
      .bind(new Date().toISOString(), stat.error, feed.id)
      .run();
    return stat;
  }

  const items = parseFeed(xml);
  stat.seen = items.length;

  const cutoff = Date.now() - BOT_MAX_AGE_HOURS * 3600 * 1000;
  let created = 0;

  for (const item of items) {
    if (created >= BOT_MAX_ITEMS_PER_FEED) break;

    const d = parseDateSafe(item.dateRaw);
    if (d && d.getTime() < cutoff) {
      stat.reasons.push("muy antigua");
      stat.skipped++;
      continue;
    }

    /* deduplicación por guid */
    const dup = await env.DB.prepare("SELECT id FROM articles WHERE source_guid = ?")
      .bind(item.guid)
      .first();
    if (dup) {
      stat.reasons.push("ya existe (duplicado)");
      stat.skipped++;
      continue;
    }

    let draft = null;
    try {
      draft = await draftFromItem(env, item, feed);
    } catch (e) {
      const msg = String((e && e.message) || e);
      stat.reasons.push("error IA: " + msg);
      stat.skipped++;
      continue;
    }
    if (!draft || draft.skip) {
      stat.reasons.push(draft && draft.skip ? draft.skip : "descartado");
      stat.skipped++;
      continue;
    }

    const now = new Date().toISOString();
    const base = slugify(draft.titulo) || "nota";
    const slug = base + "-" + now.slice(0, 10) + "-" + Math.random().toString(36).slice(2, 6);

    /* fuentes oficiales publican directo; medios quedan en borrador */
    const status = feed.trust === "official" ? "published" : "draft";

    let cover = item.image || null;
    if (!cover) cover = await autoPhotoForArticle(env, feed.category, draft.titulo);

    const maxOrder = await env.DB.prepare("SELECT MAX(sort_order) as m FROM articles").first();
    const sortOrder = (maxOrder && maxOrder.m ? maxOrder.m : 0) + 1;

    const ins = await env.DB.prepare(
      `INSERT INTO articles
         (slug, title, dek, category, author, body, cover_image_url, featured, sort_order,
          status, created_at, updated_at, created_by, updated_by,
          source_url, source_name, source_guid, is_auto)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'bot', 'bot', ?, ?, ?, 1)`
    )
      .bind(
        slug, draft.titulo, draft.bajada, feed.category, BOT_AUTHOR, draft.cuerpo,
        cover, sortOrder, status, now, now,
        item.link, feed.name, item.guid
      )
      .run();

    /* sólo se escribe el HTML si sale publicado */
    if (status === "published") {
      const article = await env.DB.prepare("SELECT * FROM articles WHERE id = ?")
        .bind(ins.meta.last_row_id)
        .first();
      await regenerateArticleFile(env, article);
    }

    created++;
  }

  stat.created = created;

  await env.DB.prepare("UPDATE feeds SET last_checked = ?, last_error = ? WHERE id = ?")
    .bind(new Date().toISOString(), stat.error, feed.id)
    .run();

  await env.DB.prepare(
    "INSERT INTO bot_log (feed_name, items_seen, items_created, detail) VALUES (?, ?, ?, ?)"
  )
    .bind(
      feed.name,
      stat.seen,
      stat.created,
      stat.error || (stat.skipped + " omitidos" + (stat.reasons.length ? ": " + summarizeReasons(stat.reasons) : ""))
    )
    .run();

  return stat;
}

async function runBot(env) {
  const { results: feeds } = await env.DB.prepare(
    "SELECT * FROM feeds WHERE active = 1 ORDER BY id"
  ).all();

  const stats = [];
  let anyPublished = false;

  for (const feed of feeds) {
    const s = await ingestFeed(env, feed);
    stats.push(s);
    if (s.created > 0 && feed.trust === "official") anyPublished = true;
  }

  if (anyPublished) await regenerateArticlesJson(env);

  return stats;
}

/* ---------------- endpoints del bot y de fuentes ---------------- */

async function handleListFeeds(request, env) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);
  const { results } = await env.DB.prepare("SELECT * FROM feeds ORDER BY name").all();
  return jsonResponse({ feeds: results });
}

async function handleTestFeed(request, env) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const { url } = await request.json();
  if (!url) return jsonResponse({ error: "Falta la URL" }, 400);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "ReporteAereoBot/1.0 (+https://reporteaereo.com)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });
    if (!res.ok) return jsonResponse({ ok: false, error: "El servidor respondió " + res.status }, 200);

    const xml = await res.text();
    const items = parseFeed(xml);
    if (!items.length) {
      return jsonResponse({ ok: false, error: "La URL responde pero no contiene items RSS/Atom válidos." }, 200);
    }
    const feedTitle = stripTags(pickTag(xml.slice(0, 4000), "title"));
    return jsonResponse({
      ok: true,
      feedTitle,
      count: items.length,
      sample: items.slice(0, 3).map((i) => ({ title: i.title, link: i.link, date: i.dateRaw })),
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: String((e && e.message) || e) }, 200);
  }
}

async function handleCreateFeed(request, env) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const { name, url, category, trust } = await request.json();
  if (!name || !url) return jsonResponse({ error: "Faltan nombre o URL" }, 400);

  try {
    await env.DB.prepare(
      "INSERT INTO feeds (name, url, category, trust, active) VALUES (?, ?, ?, ?, 1)"
    )
      .bind(name.trim(), url.trim(), category || "Actualidad", trust === "official" ? "official" : "media")
      .run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return jsonResponse({ error: "Esa URL ya está cargada" }, 409);
    throw e;
  }
  return jsonResponse({ ok: true });
}

async function handleUpdateFeed(request, env, id) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const { name, category, trust, active } = await request.json();
  await env.DB.prepare(
    "UPDATE feeds SET name = COALESCE(?, name), category = COALESCE(?, category), trust = COALESCE(?, trust), active = COALESCE(?, active) WHERE id = ?"
  )
    .bind(
      name || null,
      category || null,
      trust || null,
      typeof active === "boolean" ? (active ? 1 : 0) : null,
      id
    )
    .run();
  return jsonResponse({ ok: true });
}

async function handleDeleteFeed(request, env, id) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);
  await env.DB.prepare("DELETE FROM feeds WHERE id = ?").bind(id).run();
  return jsonResponse({ ok: true });
}

async function handleRunBot(request, env, ctx) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);
  /* Con varias fuentes, revisar todo (RSS + lectura de la nota original +
     IA) puede tardar más de lo que un clic puede esperar sin que Cloudflare
     corte la conexión. Lo largamos en segundo plano y el panel consulta
     el resultado en /api/bot/log un rato después. */
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(runBot(env).catch((e) => console.error("[bot manual]", e)));
    return jsonResponse({ ok: true, started: true });
  }
  const stats = await runBot(env);
  return jsonResponse({ ok: true, stats });
}

async function handleBotLog(request, env) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);
  const { results } = await env.DB.prepare(
    "SELECT * FROM bot_log ORDER BY id DESC LIMIT 40"
  ).all();
  return jsonResponse({ log: results });
}

/* aprobar un borrador -> lo publica */
async function handleApproveArticle(request, env, id) {
  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ error: "No autenticado" }, 401);

  const article = await env.DB.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first();
  if (!article) return jsonResponse({ error: "No encontrada" }, 404);

  await env.DB.prepare(
    "UPDATE articles SET status = 'published', updated_at = ?, updated_by = ? WHERE id = ?"
  )
    .bind(new Date().toISOString(), session.u, id)
    .run();

  const fresh = await env.DB.prepare("SELECT * FROM articles WHERE id = ?").bind(id).first();
  await regenerateArticleFile(env, fresh);
  await regenerateArticlesJson(env);

  return jsonResponse({ ok: true, url: "/notas/" + fresh.slug + ".html" });
}

/* ---------------- router ---------------- */

export default {
  /* disparador programado: corre el bot solo */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runBot(env).catch((e) => console.error("[bot]", e))
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      /* Las columnas de roles y autoría se agregan solas la primera vez
         que el worker toca la base después de desplegar. */
      if (path.startsWith("/api/") || path === "/sitemap.xml") await ensureSchema(env);

      if (path === "/sitemap.xml" && request.method === "GET") return await handleSitemap(env);
      if (path === "/api/config" && request.method === "GET") return handleConfig(env);

      const userMatch = path.match(/^\/api\/users\/([a-z0-9._-]{3,32})$/);
      if (path === "/api/users" && request.method === "GET") return await handleListUsers(request, env);
      if (path === "/api/users" && request.method === "POST") return await handleCreateUser(request, env);
      if (userMatch && request.method === "PUT") return await handleUpdateUser(request, env, userMatch[1]);
      if (userMatch && request.method === "DELETE") return await handleDeleteUser(request, env, userMatch[1]);

      if (path === "/api/login" && request.method === "POST") return await handleLogin(request, env, ctx);
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

      /* --- bot y fuentes --- */
      if (path === "/api/feeds" && request.method === "GET") return await handleListFeeds(request, env);
      if (path === "/api/feeds" && request.method === "POST") return await handleCreateFeed(request, env);
      if (path === "/api/feeds/test" && request.method === "POST") return await handleTestFeed(request, env);

      const feedMatch = path.match(/^\/api\/feeds\/(\d+)$/);
      if (feedMatch && request.method === "PUT") return await handleUpdateFeed(request, env, feedMatch[1]);
      if (feedMatch && request.method === "DELETE") return await handleDeleteFeed(request, env, feedMatch[1]);

      if (path === "/api/bot/run" && request.method === "POST") return await handleRunBot(request, env, ctx);
      if (path === "/api/bot/log" && request.method === "GET") return await handleBotLog(request, env);

      const approveMatch = path.match(/^\/api\/articles\/(\d+)\/approve$/);
      if (approveMatch && request.method === "POST") return await handleApproveArticle(request, env, approveMatch[1]);

      const moveMatch = path.match(/^\/api\/articles\/(\d+)\/move$/);
      if (moveMatch && request.method === "POST") return await handleMoveArticle(request, env, moveMatch[1]);
    } catch (e) {
      return jsonResponse({ error: String((e && e.message) || e) }, 500);
    }

    /* todo lo demás: servir assets estáticos */
    return env.ASSETS.fetch(request);
  },
};
