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

    /* Active link (by href matching current page) */
    var path = location.pathname.split("/").pop() || "index.html";
    links.forEach(function (link) {
      var href = (link.getAttribute("href") || "").split("/").pop();
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

    /* Clone the track for seamless looping */
    var clone = track.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    track.parentElement.appendChild(clone);

    /* Pause on hover */
    var wrap = $1(".ticker-inner");
    if (!wrap) return;
    wrap.addEventListener("mouseenter", function () {
      track.style.animationPlayState = "paused";
      clone.style.animationPlayState = "paused";
    });
    wrap.addEventListener("mouseleave", function () {
      track.style.animationPlayState = "running";
      clone.style.animationPlayState = "running";
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
                  ? '<img src="' + escapeHtml(hero.image) + '" alt="" loading="eager">'
                  : '<div class="hero-sky" role="img" aria-label=""></div>') +
                '<span class="hero-category">' + escapeHtml(hero.category || "Reporte Aéreo") + '</span>' +
              '</div>' +
            '</a>' +
            '<div class="hero-content">' +
              '<p class="kicker">' + escapeHtml(hero.category || "") + '</p>' +
              '<h1 class="hero-headline">' + escapeHtml(hero.title) + '</h1>' +
              (hero.dek ? '<p class="hero-deck">' + escapeHtml(hero.dek) + '</p>' : '') +
              '<div class="hero-meta">' +
                '<span class="byline">Por <strong>' + escapeHtml(hero.author || "Redacción Reporte Aéreo") + '</strong></span>' +
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
                      ? '<img src="' + escapeHtml(item.image) + '" alt="" loading="lazy">'
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
          grid.innerHTML = catItems.slice(0, 4).map(function (item, i) {
            var big = i === 0 ? " news-card--featured" : "";
            return (
              '<article class="news-card' + big + '">' +
                '<div class="card-img-wrap">' +
                  (item.image
                    ? '<img src="' + escapeHtml(item.image) + '" alt="" loading="lazy">'
                    : '<div class="card-sky-' + ((i % 4) + 1) + '" role="img" aria-label=""></div>') +
                  '<span class="card-cat">' + escapeHtml(item.category || "") + '</span>' +
                '</div>' +
                '<h3 class="card-title' + (i === 0 ? " card-title--lg" : "") + '">' +
                  '<a href="' + escapeHtml(item.url) + '">' + escapeHtml(item.title) + '</a>' +
                '</h3>' +
                (i === 0 && item.dek ? '<p class="card-excerpt">' + escapeHtml(item.dek) + '</p>' : '') +
                '<div class="card-meta">' +
                  '<span class="byline-sm">' + escapeHtml(item.author || "Redacción Reporte Aéreo") + '</span>' +
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
    safe(renderHome,        "renderHome");
    safe(initStickyNav,     "initStickyNav");
    safe(initSplitText,     "initSplitText");

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
