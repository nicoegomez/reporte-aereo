/* =============================================================
   REPORTE AÉREO — main.js
   Archetype 06: Magazine Multi-Page
   Desarrollado por Consultatia · consultatia.com.ar
   IIFE pattern — no import/export — classic <script defer>
   ============================================================= */
(function () {
  "use strict";

  /* --------------------------------------------------------
     Shared helpers
  -------------------------------------------------------- */
  var reduced   = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fineHover = matchMedia("(hover: hover) and (pointer: fine)").matches;

  function $1(sel, scope) { return (scope || document).querySelector(sel); }
  function $$(sel, scope) { return Array.from((scope || document).querySelectorAll(sel)); }

  function safe(fn, name) {
    try { fn(); }
    catch (e) { console.warn("[RA:" + name + "]", e); }
  }

  /* --------------------------------------------------------
     1. Navigation — sticky + hamburger mobile menu
  -------------------------------------------------------- */
  function initNav() {
    var nav     = $1(".main-nav");
    var burger  = $1(".nav-burger");
    var mobile  = $1(".nav-mobile");
    var links   = $$(".nav-link");

    if (!nav) return;

    /* Hamburger toggle */
    if (burger && mobile) {
      burger.addEventListener("click", function () {
        var open = mobile.classList.toggle("is-open");
        burger.setAttribute("aria-expanded", String(open));
      });
    }

    /* Active link (by href matching current page). El link de
       "Inicio" apunta a "/" — con eso, split("/").pop() da "" tanto
       para la home como para el propio "/", así que el fallback a
       "index.html" cubre los dos lados de la comparación. */
    var path = location.pathname.split("/").pop() || "index.html";
    links.forEach(function (link) {
      var href = (link.getAttribute("href") || "").split("/").pop() || "index.html";
      if (href === path) link.classList.add("is-active");
    });

    /* Close mobile menu on link click */
    if (mobile) {
      $$(".nav-link", mobile).forEach(function (link) {
        link.addEventListener("click", function () {
          mobile.classList.remove("is-open");
          if (burger) burger.setAttribute("aria-expanded", "false");
        });
      });
    }
  }

  /* --------------------------------------------------------
     2. Reveal animations — IntersectionObserver
        threshold ≤ 0.05 + 6s safety net
  -------------------------------------------------------- */
  function initReveals() {
    var els = $$(".reveal");
    if (!els.length) return;

    /* 6-second safety net: reveal everything still hidden */
    var safetyTimer = setTimeout(function () {
      els.forEach(function (el) {
        el.classList.add("is-visible");
      });
    }, 6000);

    if (reduced) {
      /* Respect reduced motion — instant reveal */
      clearTimeout(safetyTimer);
      els.forEach(function (el) { el.classList.add("is-visible"); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.04,
      rootMargin: "0px 0px -32px 0px"
    });

    els.forEach(function (el) { io.observe(el); });
  }

  /* --------------------------------------------------------
     3. Breaking news ticker — duplicate track for seamless loop
  -------------------------------------------------------- */
  function initMarquee() {
    var track = $1(".ticker-track");
    if (!track) return;

    var wrap = $1(".ticker-inner");
    if (!wrap) return;

    /* Clona el track para el loop continuo. Se vuelve a invocar cada
       vez que cambia el contenido (por ej. al llegar los titulares
       reales) para que la copia nunca quede desactualizada. */
    var clone = null;
    function mountClone() {
      if (clone) clone.remove();
      clone = track.cloneNode(true);
      clone.setAttribute("aria-hidden", "true");
      track.parentElement.appendChild(clone);
    }
    mountClone();

    /* Pause on hover */
    wrap.addEventListener("mouseenter", function () {
      track.style.animationPlayState = "paused";
      clone.style.animationPlayState = "paused";
    });
    wrap.addEventListener("mouseleave", function () {
      track.style.animationPlayState = "running";
      clone.style.animationPlayState = "running";
    });

    /* El texto de arriba es un placeholder de diseño: acá se
       reemplaza por los titulares reales de las últimas notas
       publicadas. Si falla el fetch o todavía no hay notas, queda
       el placeholder tal cual estaba en el HTML. */
    fetch("assets/articles.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (items) {
        items = Array.isArray(items) ? items : [];
        if (!items.length) return;
        track.innerHTML = items.slice(0, 8).map(function (item) {
          return '<span><a href="' + escapeHtml(item.url) + '">' + escapeHtml(item.title) + '</a></span>' +
                 '<span class="ticker-dot" aria-hidden="true">⬤</span>';
        }).join("");
        mountClone();
      })
      .catch(function () {
        /* si falla, queda el texto de espera hardcodeado en el HTML */
      });
  }

  /* --------------------------------------------------------
     4. Reading progress bar (article page only)
  -------------------------------------------------------- */
  function initProgressBar() {
    var bar     = $1(".progress-bar");
    var article = $1(".article-body");
    if (!bar || !article) return;

    function update() {
      var rect   = article.getBoundingClientRect();
      var total  = rect.height - window.innerHeight;
      var scrolled = -rect.top;
      var pct   = Math.max(0, Math.min(100, (scrolled / total) * 100));
      bar.style.width = pct + "%";
    }

    window.addEventListener("scroll", update, { passive: true });
    update();
  }

  /* --------------------------------------------------------
     5. Smooth scroll anchors
  -------------------------------------------------------- */
  function initSmoothAnchors() {
    $$("a[href^='#']").forEach(function (link) {
      link.addEventListener("click", function (e) {
        var id     = link.getAttribute("href").slice(1);
        var target = document.getElementById(id);
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
        target.focus({ preventScroll: true });
      });
    });
  }

  /* --------------------------------------------------------
     6. Parallax on hero image (GSAP-gated)
  -------------------------------------------------------- */
  function initParallax() {
    /* Guard — only if GSAP + ScrollTrigger loaded */
    if (!window.gsap || !window.ScrollTrigger) return;

    var heroImg = $1(".hero-image-wrap > div, .hero-image-wrap img");
    if (!heroImg) return;

    /* Gentle parallax: image moves at 40% speed of scroll */
    gsap.to(heroImg, {
      yPercent: 25,
      ease: "none",
      scrollTrigger: {
        trigger: $1(".hero-feature"),
        start: "top top",
        end: "bottom top",
        scrub: true
      }
    });

    /* Fade article header gradients */
    var articleHero = $1(".article-featured-img > div");
    if (articleHero) {
      gsap.to(articleHero, {
        yPercent: 20,
        ease: "none",
        scrollTrigger: {
          trigger: ".article-featured-img",
          start: "top center",
          end: "bottom top",
          scrub: 1.5
        }
      });
    }
  }

  /* --------------------------------------------------------
     7. Newsletter form — client-side feedback only
  -------------------------------------------------------- */
  function initNewsletter() {
    var form = $1(".newsletter-form");
    if (!form) return;

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = $1("input[type='email']", form);
      var btn   = $1(".btn", form);
      if (!input || !btn) return;

      var email = input.value.trim();
      if (!email) return;

      var orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Enviando…";

      fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email }),
      })
        .then(function (res) {
          return res.json().then(function (data) { return { ok: res.ok, data: data }; });
        })
        .then(function (result) {
          if (result.ok) {
            btn.textContent = "¡Registrado!";
            btn.style.background = "#1a7a40";
            input.value = "";
            track("newsletter_alta", { ubicacion: location.pathname });
          } else {
            btn.textContent = (result.data && result.data.error) || "Error, probá de nuevo";
            btn.style.background = "#b3261e";
          }
        })
        .catch(function () {
          btn.textContent = "Error de conexión";
          btn.style.background = "#b3261e";
        })
        .finally(function () {
          setTimeout(function () {
            btn.textContent = orig;
            btn.disabled = false;
            btn.style.background = "";
          }, 3000);
        });
    });
  }

  /* --------------------------------------------------------
     7b. Home dinámica — hero + laterales + secciones por
         categoría, todo desde assets/articles.json (portada).
         Las notas se agregan/editan desde el panel; acá sólo
         se leen. Si una categoría no tiene notas, la sección
         queda oculta en vez de mostrar contenido inventado.
  -------------------------------------------------------- */
  var HOME_CATEGORIES = ["Actualidad", "Aeropuertos", "Business", "Comercial", "Industria", "Turismo"];
  var HOME_CAT_LIMIT = 8; // notas por categoria en portada antes de "Ver mas"

  function renderHome() {
    var heroMain = $1("#heroMain");
    var heroSidebar = $1("#heroSidebar");
    if (!heroMain) return; /* no estamos en la portada */

    fetch("assets/articles.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (items) {
        items = Array.isArray(items) ? items : [];
        var hero = items[0] || null;
        var rest = hero ? items.slice(1) : items;

        if (hero) {
          heroMain.innerHTML =
            '<a href="' + escapeHtml(hero.url) + '" aria-label="Leer nota completa: ' + escapeHtml(hero.title) + '">' +
              '<div class="hero-image-wrap">' +
                (hero.image
                  ? '<img src="' + escapeHtml(hero.image) + '" alt="' + escapeHtml(hero.title || "") + '" loading="eager">'
                  : '<div class="hero-sky" role="img" aria-label=""></div>') +
                '<span class="hero-category">' + escapeHtml(hero.category || "Reporte Aéreo") + '</span>' +
              '</div>' +
            '</a>' +
            '<div class="hero-content">' +
              '<p class="kicker">' + escapeHtml(hero.category || "") + '</p>' +
              '<h1 class="hero-headline">' + escapeHtml(hero.title) + '</h1>' +
              (hero.dek ? '<p class="hero-deck">' + escapeHtml(hero.dek) + '</p>' : '') +
              '<div class="hero-meta">' +
                '<span class="byline">Por <strong><a class="author-link" href="' + authorUrl(hero.author) + '">' + escapeHtml(hero.author || "Redacción Reporte Aéreo") + '</a></strong></span>' +
                '<time class="pubdate">' + escapeHtml(hero.dateLabel || "") + '</time>' +
              '</div>' +
              '<a href="' + escapeHtml(hero.url) + '" class="read-more">Leer nota completa' +
                '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
              '</a>' +
            '</div>';
        }

        if (heroSidebar) {
          if (rest.length) {
            heroSidebar.innerHTML = rest.slice(0, 3).map(function (item, i) {
              return (
                '<article class="hero-side-article">' +
                  '<div class="side-img-wrap">' +
                    (item.image
                      ? '<img src="' + escapeHtml(item.image) + '" alt="' + escapeHtml(item.title || "") + '" loading="lazy">'
                      : '<div class="side-sky-' + ((i % 3) + 1) + '" role="img" aria-label=""></div>') +
                  '</div>' +
                  '<div>' +
                    '<p class="kicker">' + escapeHtml(item.category || "") + '</p>' +
                    '<h2><a href="' + escapeHtml(item.url) + '">' + escapeHtml(item.title) + '</a></h2>' +
                    '<time class="pubdate-sm">' + escapeHtml(item.dateLabel || "") + '</time>' +
                  '</div>' +
                '</article>'
              );
            }).join('<hr class="side-rule">');
          } else {
            heroSidebar.innerHTML = "";
          }
        }

        HOME_CATEGORIES.forEach(function (cat) {
          var slug = cat.toLowerCase();
          var section = document.getElementById(slug);
          var grid = document.getElementById("grid-" + slug);
          if (!section || !grid) return;

          var catItems = items.filter(function (a) {
            return a.category === cat && (!hero || a.id !== hero.id);
          });

          if (!catItems.length) {
            section.hidden = true;
            return;
          }
          section.hidden = false;

          var moreLink = document.getElementById("more-" + slug);
          if (moreLink) moreLink.hidden = catItems.length <= HOME_CAT_LIMIT;

          grid.innerHTML = catItems.slice(0, HOME_CAT_LIMIT).map(function (item, i) {
            var big = i === 0 ? " news-card--featured" : "";
            return (
              '<article class="news-card' + big + '">' +
                '<div class="card-img-wrap">' +
                  (item.image
                    ? '<img src="' + escapeHtml(item.image) + '" alt="' + escapeHtml(item.title || "") + '" loading="lazy">'
                    : '<div class="card-sky-' + ((i % 4) + 1) + '" role="img" aria-label=""></div>') +
                  '<span class="card-cat">' + escapeHtml(item.category || "") + '</span>' +
                '</div>' +
                '<h3 class="card-title' + (i === 0 ? " card-title--lg" : "") + '">' +
                  '<a href="' + escapeHtml(item.url) + '">' + escapeHtml(item.title) + '</a>' +
                '</h3>' +
                (i === 0 && item.dek ? '<p class="card-excerpt">' + escapeHtml(item.dek) + '</p>' : '') +
                '<div class="card-meta">' +
                  '<a class="byline-sm author-link" href="' + authorUrl(item.author) + '">' + escapeHtml(item.author || "Redacción Reporte Aéreo") + '</a>' +
                  '<time>' + escapeHtml(item.dateLabel || "") + '</time>' +
                '</div>' +
              '</article>'
            );
          }).join("");
        });
      })
      .catch(function () {
        /* Si falla el fetch, queda el texto de espera hardcodeado en el HTML */
      });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* --------------------------------------------------------
     7b-bis. Página de categoría — categoria.html?cat=Nombre
         Lista TODAS las notas de una categoría (a diferencia
         de la home, que sólo muestra las primeras 4). Así
         ninguna nota queda inaccesible.
  -------------------------------------------------------- */
  var PAGE_SIZE = 12;

  /* Firma como link: usada por newsCardHtml y por las tarjetas de la
     home. Cae en "Redacción Reporte Aéreo" si la nota no tiene autor
     propio (borradores viejos, notas anteriores a los roles). */
  function authorUrl(name) {
    return "autor.html?nombre=" + encodeURIComponent(name || "Redacción Reporte Aéreo");
  }

  /* Tarjeta de nota compartida por categoría, búsqueda y autor — antes
     cada página tenía su propia copia casi idéntica de este bloque. */
  function newsCardHtml(item, i, isFeatured) {
    var big = isFeatured ? " news-card--featured" : "";
    return (
      '<article class="news-card' + big + '">' +
        '<div class="card-img-wrap">' +
          (item.image
            ? '<img src="' + escapeHtml(item.image) + '" alt="' + escapeHtml(item.title || "") + '" loading="lazy">'
            : '<div class="card-sky-' + ((i % 4) + 1) + '" role="img" aria-label=""></div>') +
          '<span class="card-cat">' + escapeHtml(item.category || "") + '</span>' +
        '</div>' +
        '<h3 class="card-title' + (isFeatured ? " card-title--lg" : "") + '">' +
          '<a href="' + escapeHtml(item.url) + '">' + escapeHtml(item.title) + '</a>' +
        '</h3>' +
        (isFeatured && item.dek ? '<p class="card-excerpt">' + escapeHtml(item.dek) + '</p>' : '') +
        '<div class="card-meta">' +
          '<a class="byline-sm author-link" href="' + authorUrl(item.author) + '">' + escapeHtml(item.author || "Redacción Reporte Aéreo") + '</a>' +
          '<time>' + escapeHtml(item.dateLabel || "") + '</time>' +
        '</div>' +
      '</article>'
    );
  }

  function renderCategoryPage() {
    var grid = $1("#catGrid");
    if (!grid) return; /* no estamos en categoria.html */

    var titleEl = $1("#catTitle");
    var countEl = $1("#catCount");
    var emptyEl = $1("#catEmpty");
    var moreBtn = $1("#catMore");
    var params = new URLSearchParams(location.search);
    var requested = (params.get("cat") || "").trim();

    var known = ["Actualidad", "Aeropuertos", "Business", "Comercial", "Industria", "Turismo"];
    var match = known.filter(function (c) {
      return c.toLowerCase() === requested.toLowerCase();
    })[0] || requested;

    if (titleEl) titleEl.textContent = match || "Todas las notas";
    document.title = (match ? match + " — " : "") + "Reporte Aéreo";

    fetch("assets/articles.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (items) {
        items = Array.isArray(items) ? items : [];
        var catItems = match
          ? items.filter(function (a) { return (a.category || "").toLowerCase() === match.toLowerCase(); })
          : items;

        if (!catItems.length) {
          grid.innerHTML = "";
          if (countEl) countEl.textContent = "";
          if (emptyEl) emptyEl.hidden = false;
          if (moreBtn) moreBtn.hidden = true;
          return;
        }

        if (emptyEl) emptyEl.hidden = true;
        if (countEl) {
          countEl.textContent = catItems.length === 1
            ? "1 nota publicada"
            : catItems.length + " notas publicadas";
        }

        /* Todo ya está en memoria (un solo fetch): "Ver más" sólo
           revela la próxima tanda, sin pedir nada de nuevo a la red. */
        var shown = 0;
        function renderNextPage() {
          var next = catItems.slice(shown, shown + PAGE_SIZE);
          grid.insertAdjacentHTML("beforeend", next.map(function (item, i) {
            return newsCardHtml(item, shown + i, shown + i === 0);
          }).join(""));
          shown += next.length;
          if (moreBtn) moreBtn.hidden = shown >= catItems.length;
        }

        grid.innerHTML = "";
        renderNextPage();
        if (moreBtn) moreBtn.onclick = renderNextPage;
      })
      .catch(function () {
        if (emptyEl) emptyEl.hidden = false;
        if (moreBtn) moreBtn.hidden = true;
      });
  }

  /* --------------------------------------------------------
     7b-ter. Buscador — buscar.html?q=texto
         Filtra en memoria sobre el mismo articles.json: no hay
         backend de búsqueda, así que no pega contra la red de
         nuevo con cada letra que se tipea.
  -------------------------------------------------------- */
  function renderSearchPage() {
    var grid = $1("#searchGrid");
    if (!grid) return; /* no estamos en buscar.html */

    var input = $1("#searchInput");
    var countEl = $1("#searchCount");
    var emptyEl = $1("#searchEmpty");
    var promptEl = $1("#searchPrompt");
    var items = [];

    function norm(s) {
      return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    }

    function renderResults(query) {
      query = (query || "").trim();
      if (!query) {
        grid.innerHTML = "";
        if (countEl) countEl.textContent = "";
        if (emptyEl) emptyEl.hidden = true;
        if (promptEl) promptEl.hidden = false;
        return;
      }
      if (promptEl) promptEl.hidden = true;

      var nq = norm(query);
      var results = items.filter(function (a) {
        return norm(a.title).indexOf(nq) !== -1 || norm(a.dek).indexOf(nq) !== -1;
      });

      if (!results.length) {
        grid.innerHTML = "";
        if (countEl) countEl.textContent = "";
        if (emptyEl) emptyEl.hidden = false;
        return;
      }

      if (emptyEl) emptyEl.hidden = true;
      if (countEl) {
        countEl.textContent = results.length === 1
          ? "1 resultado para \u201c" + query + "\u201d"
          : results.length + " resultados para \u201c" + query + "\u201d";
      }
      grid.innerHTML = results.map(function (item, i) { return newsCardHtml(item, i, false); }).join("");
    }

    var params = new URLSearchParams(location.search);
    var initialQuery = params.get("q") || "";
    if (input) input.value = initialQuery;

    fetch("assets/articles.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (data) {
        items = Array.isArray(data) ? data : [];
        renderResults(initialQuery);
      })
      .catch(function () {
        if (promptEl) promptEl.hidden = true;
        if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = "No se pudo cargar la búsqueda. Probá de nuevo en un rato."; }
      });

    if (input) {
      input.addEventListener("input", function () {
        var q = input.value;
        var url = new URL(location.href);
        if (q) url.searchParams.set("q", q); else url.searchParams.delete("q");
        history.replaceState(null, "", url);
        renderResults(q);
      });
    }
  }

  /* --------------------------------------------------------
     7b-quater. Página de autor — autor.html?nombre=Firma
  -------------------------------------------------------- */
  function renderAuthorPage() {
    var grid = $1("#authorGrid");
    if (!grid) return; /* no estamos en autor.html */

    var titleEl = $1("#authorTitle");
    var countEl = $1("#authorCount");
    var emptyEl = $1("#authorEmpty");
    var params = new URLSearchParams(location.search);
    var requested = (params.get("nombre") || "").trim();

    if (titleEl) titleEl.textContent = requested || "Autor";
    document.title = (requested ? requested + " — " : "") + "Reporte Aéreo";

    fetch("assets/articles.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (items) {
        items = Array.isArray(items) ? items : [];
        var authorItems = items.filter(function (a) {
          return (a.author || "Redacción Reporte Aéreo").toLowerCase() === requested.toLowerCase();
        });

        if (!authorItems.length) {
          grid.innerHTML = "";
          if (countEl) countEl.textContent = "";
          if (emptyEl) emptyEl.hidden = false;
          return;
        }

        if (emptyEl) emptyEl.hidden = true;
        var canonicalName = authorItems[0].author || requested;
        if (titleEl) titleEl.textContent = canonicalName;
        document.title = canonicalName + " — Reporte Aéreo";
        if (countEl) {
          countEl.textContent = authorItems.length === 1
            ? "1 nota publicada"
            : authorItems.length + " notas publicadas";
        }

        grid.innerHTML = authorItems.map(function (item, i) {
          return newsCardHtml(item, i, i === 0);
        }).join("");
      })
      .catch(function () {
        if (emptyEl) emptyEl.hidden = false;
      });
  }

  /* --------------------------------------------------------
     7c. Nav sticky — se solidifica al bajar
  -------------------------------------------------------- */
  function initStickyNav() {
    var nav = $1(".main-nav");
    if (!nav) return;

    var threshold = 8;
    function update() {
      var top = nav.getBoundingClientRect().top;
      if (top <= threshold) nav.classList.add("is-stuck");
      else nav.classList.remove("is-stuck");
    }
    window.addEventListener("scroll", update, { passive: true });
    update();
  }

  /* --------------------------------------------------------
     7d. Split text — reveal por palabras del titular principal
         Preserva <br> y <em>. Nunca deja el texto invisible.
  -------------------------------------------------------- */
  function escHTML(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function splitWords(el) {
    el.setAttribute("aria-label", el.textContent.trim().replace(/\s+/g, " "));
    function wrapWords(text) {
      return text
        .split(/(\s+)/)
        .map(function (w) {
          return /^\s*$/.test(w)
            ? w
            : '<span class="split-word" aria-hidden="true">' + escHTML(w) + "</span>";
        })
        .join("");
    }
    var html = Array.prototype.map
      .call(el.childNodes, function (node) {
        if (node.nodeType === 3) return wrapWords(node.textContent);
        if (node.nodeName === "BR") return "<br>";
        if (node.nodeType === 1) {
          var tag = node.tagName.toLowerCase();
          return "<" + tag + ">" + wrapWords(node.textContent) + "</" + tag + ">";
        }
        return "";
      })
      .join("");
    el.innerHTML = html;
    return el.querySelectorAll(".split-word");
  }

  function initSplitText() {
    if (!window.gsap) return;
    $$("[data-split]").forEach(function (el) {
      var parts = splitWords(el);
      if (!parts.length) return;

      /* red de seguridad: si algo falla, el texto se muestra igual */
      var safety = setTimeout(function () {
        gsap.set(parts, { y: 0, opacity: 1 });
      }, 3000);

      gsap.set(parts, { y: 22, opacity: 0 });
      gsap.to(parts, {
        y: 0,
        opacity: 1,
        duration: 0.85,
        stagger: 0.035,
        ease: "expo.out",
        delay: 0.15,
        onComplete: function () { clearTimeout(safety); }
      });
    });
  }

  /* --------------------------------------------------------
     8. Date/time top bar — current date in Spanish
  -------------------------------------------------------- */
  function initTopBarDate() {
    var el = $1(".js-date");
    if (!el) return;

    var days   = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
    var months = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
    var now    = new Date();
    el.textContent =
      days[now.getDay()] + ", " +
      now.getDate() + " de " +
      months[now.getMonth()] + " de " +
      now.getFullYear();
  }

  /* --------------------------------------------------------
     9. Google Analytics 4 — se activa sólo si hay ID cargado
        en lib/manifest.js (__BRAND__.analyticsId).
  -------------------------------------------------------- */
  function initAnalytics() {
    var id = window.__BRAND__ && window.__BRAND__.analyticsId;
    if (!id) return;                                   /* sin ID, no se carga nada */
    if (document.querySelector('script[data-ra-ga]')) return;

    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
    s.setAttribute("data-ra-ga", "");
    document.head.appendChild(s);

    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag("js", new Date());
    gtag("config", id);
  }

  /* --------------------------------------------------------
     9b. Eventos de negocio -> dataLayer (GTM/GA4)
         Empuja los hechos que importan para vender y para
         entender el sitio: altas al newsletter, uso de los
         botones de compartir y clics comerciales. Si GTM no
         cargó (bloqueador), track() no rompe nada.
  -------------------------------------------------------- */
  function track(evento, datos) {
    try {
      window.dataLayer = window.dataLayer || [];
      var payload = { event: evento };
      if (datos) {
        for (var k in datos) {
          if (Object.prototype.hasOwnProperty.call(datos, k)) payload[k] = datos[k];
        }
      }
      window.dataLayer.push(payload);
    } catch (e) {}
  }

  function initEventTracking() {
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a") : null;
      if (!a) return;

      /* botones de compartir de la nota */
      if (a.classList.contains("article-share-link")) {
        var label = a.getAttribute("aria-label") || "";
        var red = label.replace(/^Compartir en\s*/i, "").trim() || "desconocida";
        track("compartir_nota", { red: red, nota: location.pathname });
        return;
      }

      var href = a.getAttribute("href") || "";

      /* contacto por mail */
      if (href.indexOf("mailto:") === 0) {
        var dir = href.slice(7).split("?")[0];
        track("clic_email", {
          destino: dir,
          tipo: dir.indexOf("publicidad@") === 0 ? "comercial" : "redaccion"
        });
        return;
      }

      /* páginas comerciales */
      if (/anunciate\.html/.test(href)) { track("clic_anunciate"); return; }
      if (/contacto\.html/.test(href))  { track("clic_contacto");  return; }

      /* LinkedIn de la marca */
      if (/linkedin\.com\/company/.test(href)) { track("clic_linkedin"); return; }
    });
  }

  /* --------------------------------------------------------
     10. Aviso de cookies — banner simple e informativo.
         No bloquea GTM/GA (Argentina no exige consentimiento
         previo como el RGPD), pero cumple con el requisito de
         "avisar sobre el uso de cookies" que piden la mayoría
         de las redes publicitarias antes de aprobar un sitio.
  -------------------------------------------------------- */
  function initCookieBanner() {
    var KEY = "ra_cookie_ack";
    try { if (localStorage.getItem(KEY)) return; } catch (e) { return; }
    if ($1(".cookie-banner")) return;

    var inNota = /\/notas\//.test(location.pathname);
    var privacyHref = (inNota ? "../" : "") + "privacidad.html";

    var bar = document.createElement("div");
    bar.className = "cookie-banner";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Aviso de cookies");
    bar.innerHTML =
      '<p>Usamos cookies propias y de terceros (Google Analytics) para medir el uso del sitio y mejorar tu experiencia. Más información en nuestra <a href="' +
      privacyHref +
      '">Política de Privacidad</a>.</p>' +
      '<button type="button">Entendido</button>';

    document.body.appendChild(bar);

    bar.querySelector("button").addEventListener("click", function () {
      try { localStorage.setItem(KEY, "1"); } catch (e) {}
      bar.remove();
    });
  }

  /* --------------------------------------------------------
     Boot
  -------------------------------------------------------- */
  function boot() {
    safe(initAnalytics,     "initAnalytics");
    safe(initTopBarDate,    "initTopBarDate");
    safe(initNav,           "initNav");
    safe(initReveals,       "initReveals");
    safe(initMarquee,       "initMarquee");
    safe(initSmoothAnchors, "initSmoothAnchors");
    safe(initProgressBar,   "initProgressBar");
    safe(initNewsletter,    "initNewsletter");
    safe(initEventTracking, "initEventTracking");
    safe(renderHome,        "renderHome");
    safe(renderCategoryPage, "renderCategoryPage");
    safe(renderSearchPage,  "renderSearchPage");
    safe(renderAuthorPage,  "renderAuthorPage");
    safe(initStickyNav,     "initStickyNav");
    safe(initSplitText,     "initSplitText");
    safe(initCookieBanner,  "initCookieBanner");

    if (window.gsap && window.ScrollTrigger) {
      try { gsap.registerPlugin(ScrollTrigger); } catch (_) {}
      safe(initParallax, "initParallax");
    }

    document.documentElement.classList.add("is-ready");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

})();
