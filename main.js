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
      btn.textContent = "¡Registrado!";
      btn.disabled    = true;
      btn.style.background = "#1a7a40";

      setTimeout(function () {
        btn.textContent   = orig;
        btn.disabled      = false;
        btn.style.background = "";
        input.value       = "";
      }, 3000);
    });
  }

  /* --------------------------------------------------------
     7b. Últimas notas — fetch assets/articles.json (panel admin)
  -------------------------------------------------------- */
  function initLatestNotes() {
    var list = $1("#ultimasNotasList");
    if (!list) return;

    fetch("assets/articles.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (items) {
        if (!items || !items.length) {
          list.innerHTML = '<p class="latest-notes-empty">Todavía no hay notas publicadas desde el panel.</p>';
          return;
        }
        list.innerHTML = items
          .slice(0, 6)
          .map(function (item) {
            var featClass = item.featured ? " is-featured" : "";
            var thumb = item.image
              ? '<img class="latest-note-thumb" src="' + escapeHtml(item.image) + '" alt="" loading="lazy">'
              : "";
            return (
              '<article class="latest-note-item reveal' + featClass + '">' +
              thumb +
              '<div>' +
              '<p class="kicker">' + escapeHtml(item.category || "") + "</p>" +
              '<h3><a href="' + escapeHtml(item.url) + '">' + escapeHtml(item.title) + "</a></h3>" +
              (item.dek ? '<p class="latest-note-dek">' + escapeHtml(item.dek) + "</p>" : "") +
              '<time class="pubdate-sm">' + escapeHtml(item.dateLabel || "") + "</time>" +
              "</div>" +
              "</article>"
            );
          })
          .join("");
      })
      .catch(function () {
        list.innerHTML = "";
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
     Boot
  -------------------------------------------------------- */
  function boot() {
    safe(initTopBarDate,    "initTopBarDate");
    safe(initNav,           "initNav");
    safe(initReveals,       "initReveals");
    safe(initMarquee,       "initMarquee");
    safe(initSmoothAnchors, "initSmoothAnchors");
    safe(initProgressBar,   "initProgressBar");
    safe(initNewsletter,    "initNewsletter");
    safe(initLatestNotes,   "initLatestNotes");

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
