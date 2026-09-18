/* BotoAvatar: deterministic identity avatars, generated locally.

   This is a port of the Boring Avatars "beam" style (MIT, Hayk An /
   boringdesigners) alongside eight curated DiceBear-inspired offline
   character avatars for custom profile selection. The repo is offline-first
   on purpose: Lucide is vendored, the standalone build runs from file://
   with no server, the service worker precaches the shell, and the CSP sets
   font-src 'self'. A CDN avatar would break all four, so the generator
   lives here and emits inline SVG.

   Same input always gives the same face. When a user selects one of the 8
   curated characters (char-1 through char-8), it renders the crisp character
   vector in Impose's restrained dark palette.

   Public API:
     BotoAvatar.svg(seed, size)   -> SVG markup string
     BotoAvatar.dataUri(seed, sz) -> data: URI of the same
     BotoAvatar.initial(seed)     -> the letter used as the text fallback
     BotoAvatar.CHARACTERS        -> array of 8 DiceBear-style characters
     BotoAvatar.character(id)     -> character object or null
*/
(function () {
  "use strict";

  /* Desaturated, dark-UI friendly. Six colours keeps faces distinct
     without turning the feed into confetti. */
  var PALETTE = ["#5b7c99", "#7a9b76", "#a88055", "#8c6b8e", "#5f8a8b", "#9c6f62"];

  var SIZE = 36; /* internal viewBox; the element scales it */

  /* Counter for unique mask ids within a document. Not part of the face:
     the same seed always draws the same picture, only the internal id
     differs between instances. */
  var uidCounter = 0;

  /* Deterministic, order-dependent, and stable across engines. Not a
     security hash and never used as one: it only picks colours and
     offsets. */
  function hash(name) {
    var str = String(name == null ? "" : name);
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  function unit(value, max, allowNegative) {
    var v = value % max;
    return allowNegative && (value % 2) === 0 ? -v : v;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ---------- 8 DiceBear character avatars ----------
     Hand-crafted, self-contained SVG vectors in the Impose house palette.
     No network requests, zero layout shift, crisp at any display density. */
  var CHARACTERS = [
    {
      id: "char-1",
      name: "Astro",
      role: "Cosmonaut",
      bg: "#202a36",
      fg: "#5b7c99",
      accent: "#7dd3fc",
      draw: function (maskId, s) {
        return '<rect width="36" height="36" fill="#1e293b"/>' +
          '<circle cx="18" cy="18" r="14" fill="#334155"/>' +
          '<circle cx="18" cy="18" r="11" fill="#0f172a"/>' +
          '<path d="M11 17c0-4 3-7 7-7s7 3 7 7v1c0 4-3 7-7 7s-7-3-7-7v-1z" fill="#38bdf8" fill-opacity="0.85"/>' +
          '<path d="M14 13c3-2 6-1 8 1" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-opacity="0.7"/>' +
          '<rect x="13" y="27" width="10" height="4" rx="2" fill="#64748b"/>';
      }
    },
    {
      id: "char-2",
      name: "Nova",
      role: "Cyberpunk",
      bg: "#2b1f2e",
      fg: "#8c6b8e",
      accent: "#f472b6",
      draw: function (maskId, s) {
        return '<rect width="36" height="36" fill="#2d1a33"/>' +
          '<circle cx="18" cy="19" r="13" fill="#4a2556"/>' +
          '<path d="M9 16h18v6H9z" rx="2" fill="#f43f5e"/>' +
          '<line x1="11" y1="19" x2="25" y2="19" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>' +
          '<rect x="7" y="14" width="2" height="7" rx="1" fill="#fb7185"/>' +
          '<rect x="27" y="14" width="2" height="7" rx="1" fill="#fb7185"/>' +
          '<path d="M15 26c1.5 1 4.5 1 6 0" stroke="#fbcfe8" stroke-width="1.2" stroke-linecap="round"/>';
      }
    },
    {
      id: "char-3",
      name: "Pixel",
      role: "Bot",
      bg: "#1b2a24",
      fg: "#5f8a8b",
      accent: "#4ade80",
      draw: function (maskId, s) {
        return '<rect width="36" height="36" fill="#142823"/>' +
          '<line x1="18" y1="5" x2="18" y2="9" stroke="#34d399" stroke-width="2" stroke-linecap="round"/>' +
          '<circle cx="18" cy="4" r="2" fill="#34d399"/>' +
          '<rect x="9" y="9" width="18" height="18" rx="4" fill="#1f4239"/>' +
          '<rect x="12" y="13" width="4" height="4" rx="1" fill="#4ade80"/>' +
          '<rect x="20" y="13" width="4" height="4" rx="1" fill="#4ade80"/>' +
          '<path d="M14 21h8" stroke="#a7f3d0" stroke-width="1.5" stroke-linecap="round"/>';
      }
    },
    {
      id: "char-4",
      name: "Sage",
      role: "Wanderer",
      bg: "#2b261c",
      fg: "#a88055",
      accent: "#fbbf24",
      draw: function (maskId, s) {
        return '<rect width="36" height="36" fill="#2d2217"/>' +
          '<circle cx="18" cy="18" r="13" fill="#453424"/>' +
          '<path d="M8 15h20" stroke="#f59e0b" stroke-width="3" stroke-linecap="round"/>' +
          '<circle cx="18" cy="15" r="2" fill="#fef3c7"/>' +
          '<path d="M12 21c1-1 3-1 4 0" stroke="#fef3c7" stroke-width="1.5" stroke-linecap="round" fill="none"/>' +
          '<path d="M20 21c1-1 3-1 4 0" stroke="#fef3c7" stroke-width="1.5" stroke-linecap="round" fill="none"/>' +
          '<path d="M15 25c1.5 1 4.5 1 6 0" stroke="#fef3c7" stroke-width="1.2" stroke-linecap="round" fill="none"/>';
      }
    },
    {
      id: "char-5",
      name: "Echo",
      role: "Audio",
      bg: "#1c2833",
      fg: "#5b7c99",
      accent: "#818cf8",
      draw: function (maskId, s) {
        return '<rect width="36" height="36" fill="#182230"/>' +
          '<circle cx="18" cy="19" r="12" fill="#2c3e55"/>' +
          '<rect x="6" y="14" width="4" height="10" rx="2" fill="#6366f1"/>' +
          '<rect x="26" y="14" width="4" height="10" rx="2" fill="#6366f1"/>' +
          '<path d="M8 15c2-6 18-6 20 0" stroke="#6366f1" stroke-width="2" stroke-linecap="round" fill="none"/>' +
          '<circle cx="14" cy="19" r="1.5" fill="#e0e7ff"/>' +
          '<circle cx="22" cy="19" r="1.5" fill="#e0e7ff"/>' +
          '<path d="M15 24h6" stroke="#c7d2fe" stroke-width="1.5" stroke-linecap="round"/>';
      }
    },
    {
      id: "char-6",
      name: "Luna",
      role: "Nocturne",
      bg: "#231f32",
      fg: "#8c6b8e",
      accent: "#c084fc",
      draw: function (maskId, s) {
        return '<rect width="36" height="36" fill="#1f182f"/>' +
          '<path d="M10 11l4 4v11l-4-4V11zm16 0l-4 4v11l4-4V11z" fill="#6b21a8"/>' +
          '<circle cx="18" cy="19" r="11" fill="#4c1d95"/>' +
          '<circle cx="14" cy="19" r="2" fill="#c084fc"/>' +
          '<circle cx="22" cy="19" r="2" fill="#c084fc"/>' +
          '<path d="M18 11a4 4 0 0 1 0 6 4 4 0 0 0 0-6z" fill="#fde047"/>' +
          '<path d="M16 24c1 0.7 3 0.7 4 0" stroke="#e9d5ff" stroke-width="1.2" stroke-linecap="round" fill="none"/>';
      }
    },
    {
      id: "char-7",
      name: "Blaze",
      role: "Flame",
      bg: "#321d1b",
      fg: "#9c6f62",
      accent: "#fb923c",
      draw: function (maskId, s) {
        return '<rect width="36" height="36" fill="#301815"/>' +
          '<path d="M18 6c2 4 6 6 6 10s-3 8-6 8-6-4-6-8c0-3 3-6 6-10z" fill="#ea580c"/>' +
          '<path d="M18 12c1.5 2 4 4 4 6s-2 5-4 5-4-3-4-5c0-2 2-4 4-6z" fill="#fdba74"/>' +
          '<circle cx="15" cy="17" r="1.5" fill="#431407"/>' +
          '<circle cx="21" cy="17" r="1.5" fill="#431407"/>' +
          '<path d="M16 21c1 1 3 1 4 0" stroke="#431407" stroke-width="1.2" stroke-linecap="round" fill="none"/>';
      }
    },
    {
      id: "char-8",
      name: "Zen",
      role: "Minimalist",
      bg: "#1e2825",
      fg: "#7a9b76",
      accent: "#a7f3d0",
      draw: function (maskId, s) {
        return '<rect width="36" height="36" fill="#192621"/>' +
          '<circle cx="18" cy="18" r="13" fill="#2d3f38"/>' +
          '<circle cx="18" cy="18" r="8" fill="#141f1a"/>' +
          '<circle cx="18" cy="18" r="3.5" fill="#a7f3d0"/>' +
          '<path d="M10 18h4m8 0h4" stroke="#a7f3d0" stroke-width="1.5" stroke-linecap="round"/>';
      }
    }
  ];

  function getCharacter(id) {
    if (!id) return null;
    var norm = String(id).toLowerCase().trim();
    for (var i = 0; i < CHARACTERS.length; i++) {
      if (CHARACTERS[i].id === norm) return CHARACTERS[i];
    }
    return null;
  }

  /* The geometry of the "beam" face: a coloured tile, an offset backing
     square, two eyes and a mouth. Every value is derived from the hash, so
     the face is a pure function of the seed. */
  function parts(seed) {
    var h = hash(seed);
    var bg = PALETTE[h % PALETTE.length];
    var fg = PALETTE[(h + 1) % PALETTE.length];
    /* Guarantee the two tones differ, or the face disappears into its tile. */
    if (fg === bg) fg = PALETTE[(h + 3) % PALETTE.length];
    return {
      bg: bg,
      fg: fg,
      wrapperRotate: unit(h, 360),
      wrapperScale: 1 + unit(h, 3) / 10,
      wrapperX: unit(h, 10, true),
      wrapperY: unit(h, 10, true),
      faceRotate: unit(h, 10, true),
      faceX: unit(h, 7, true) / 2,
      faceY: unit(h, 7, true) / 2,
      eyeSpread: unit(h, 5),
      mouthSpread: unit(h, 5),
      isMouthOpen: (h % 2) === 0,
      isCircle: (h % 3) === 0
    };
  }

  /* Inline SVG so it needs no network, no CSP allowance, and inherits the
     page's own colours. role="img" with a label, because these stand in
     for a person and a screen reader should say whose face it is. */
  function svg(seed, size) {
    var s = size || SIZE;
    var label = "Avatar for " + String(seed == null ? "someone" : seed);

    /* SVG ids are document-global. Several avatars render on one page, so a
       fixed id="m" would make every face reuse the first one's mask. The id
       is derived from the seed and a counter, so it stays unique even when
       the same person appears twice on screen. */
    var maskId = "ba" + hash(seed).toString(36) + "-" + (uidCounter++).toString(36);

    /* Check if this is one of the 8 curated characters */
    var ch = getCharacter(seed);
    if (ch) {
      return '<svg viewBox="0 0 ' + SIZE + " " + SIZE + '" width="' + s + '" height="' + s + '"' +
        ' fill="none" role="img" aria-label="' + esc(label) + '"' +
        ' xmlns="http://www.w3.org/2000/svg">' +
        '<mask id="' + maskId + '" maskUnits="userSpaceOnUse" x="0" y="0" width="' + SIZE + '" height="' + SIZE + '">' +
          '<rect width="' + SIZE + '" height="' + SIZE + '" rx="' + (SIZE * 2) + '" fill="#FFF"/>' +
        '</mask>' +
        '<g mask="url(#' + maskId + ')">' +
          ch.draw(maskId, SIZE) +
        '</g>' +
        '</svg>';
    }

    var p = parts(seed);
    var eyeY = 14 + p.eyeSpread;
    var mouthY = 20 + p.mouthSpread;

    var mouth = p.isMouthOpen
      ? '<path d="M15 ' + (19 + p.mouthSpread) + 'c2 1 4 1 6 0" stroke="#000" fill="none" stroke-opacity="0.5" stroke-linecap="round"/>'
      : '<path d="M13 ' + mouthY + 'a5 3 0 0 0 10 0" fill="#000" fill-opacity="0.5"/>';

    return '<svg viewBox="0 0 ' + SIZE + " " + SIZE + '" width="' + s + '" height="' + s + '"' +
      ' fill="none" role="img" aria-label="' + esc(label) + '"' +
      ' xmlns="http://www.w3.org/2000/svg">' +
      '<mask id="' + maskId + '" maskUnits="userSpaceOnUse" x="0" y="0" width="' + SIZE + '" height="' + SIZE + '">' +
        '<rect width="' + SIZE + '" height="' + SIZE + '" rx="' + (SIZE * 2) + '" fill="#FFF"/>' +
      '</mask>' +
      '<g mask="url(#' + maskId + ')">' +
        '<rect width="' + SIZE + '" height="' + SIZE + '" fill="' + p.bg + '"/>' +
        '<rect x="0" y="0" width="' + SIZE + '" height="' + SIZE + '" fill="' + p.fg + '"' +
          ' transform="translate(' + p.wrapperX + " " + p.wrapperY + ") rotate(" + p.wrapperRotate +
          " " + (SIZE / 2) + " " + (SIZE / 2) + ") scale(" + p.wrapperScale + ')"' +
          ' rx="' + (p.isCircle ? SIZE : SIZE / 6) + '"/>' +
        '<g transform="translate(' + p.faceX + " " + p.faceY + ") rotate(" + p.faceRotate +
          " " + (SIZE / 2) + " " + (SIZE / 2) + ')">' +
          mouth +
          '<rect x="' + (14 - p.eyeSpread) + '" y="' + eyeY + '" width="1.5" height="2" rx="1" fill="#000" fill-opacity="0.5"/>' +
          '<rect x="' + (20 + p.eyeSpread) + '" y="' + eyeY + '" width="1.5" height="2" rx="1" fill="#000" fill-opacity="0.5"/>' +
        '</g>' +
      '</g>' +
      '</svg>';
  }

  function dataUri(seed, size) {
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg(seed, size));
  }

  function initial(seed) {
    var s = String(seed == null ? "" : seed).replace(/^@/, "");
    return s ? s.charAt(0).toUpperCase() : "?";
  }

  /* Pre-compute data URIs on character objects */
  CHARACTERS.forEach(function (c) {
    c.dataUri = dataUri(c.id, 48);
  });

  window.BotoAvatar = {
    svg: svg,
    dataUri: dataUri,
    initial: initial,
    palette: PALETTE,
    CHARACTERS: CHARACTERS,
    character: getCharacter
  };
})();
