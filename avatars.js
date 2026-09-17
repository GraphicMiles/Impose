/* BotoAvatar: deterministic identity avatars, generated locally.

   This is a port of the Boring Avatars "beam" style (MIT, Hayk An /
   boringdesigners) rather than a call to their hosted service or to
   DiceBear. The repo is offline-first on purpose: Lucide is vendored, the
   standalone build runs from file:// with no server, the service worker
   precaches the shell, and the CSP sets font-src 'self'. A CDN avatar would
   break all four, so the generator lives here and emits inline SVG.

   Same input always gives the same face: the hash below is a plain
   character-code sum, so "@ada" renders identically in the feed, in a
   comment, in the new-posts pill, and on another device. No storage, no
   network, no per-user asset to keep in sync.

   The palette is drawn from the app's own surfaces rather than the stock
   Boring Avatars colours, which are bright pastels that would fight the
   dark, flat house design. These are desaturated to sit with the UI
   (taste-skill 9.A: keep saturation down, no neon).

   Public API:
     BotoAvatar.svg(seed, size)   -> SVG markup string
     BotoAvatar.dataUri(seed, sz) -> data: URI of the same
     BotoAvatar.initial(seed)     -> the letter used as the text fallback
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
    var p = parts(seed);
    var s = size || SIZE;
    var label = "Avatar for " + String(seed == null ? "someone" : seed);
    var eyeY = 14 + p.eyeSpread;
    var mouthY = 20 + p.mouthSpread;

    var mouth = p.isMouthOpen
      ? '<path d="M15 ' + (19 + p.mouthSpread) + 'c2 1 4 1 6 0" stroke="#000" fill="none" stroke-opacity="0.5" stroke-linecap="round"/>'
      : '<path d="M13 ' + mouthY + 'a5 3 0 0 0 10 0" fill="#000" fill-opacity="0.5"/>';

    /* SVG ids are document-global. Several avatars render on one page, so a
       fixed id="m" would make every face reuse the first one's mask. The id
       is derived from the seed and a counter, so it stays unique even when
       the same person appears twice on screen. */
    var maskId = "ba" + hash(seed).toString(36) + "-" + (uidCounter++).toString(36);

    return '<svg viewBox="0 0 ' + SIZE + " " + SIZE + '" width="' + s + '" height="' + s + '"' +
      ' fill="none" role="img" aria-label="' + esc(label) + '"' +
      ' xmlns="http://www.w3.org/2000/svg">' +
      '<mask id="' + maskId + '" maskUnits="userSpaceOnUse" x="0" y="0" width="' + SIZE + '" height="' + SIZE + '">' +
        '<rect width="' + SIZE + '" height="' + SIZE + '" rx="' + (SIZE * 2) + '" fill="#FFF"/>' +
      "</mask>" +
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
        "</g>" +
      "</g>" +
      "</svg>";
  }

  function dataUri(seed, size) {
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg(seed, size));
  }

  function initial(seed) {
    var s = String(seed == null ? "" : seed).replace(/^@/, "");
    return s ? s.charAt(0).toUpperCase() : "?";
  }

  window.BotoAvatar = { svg: svg, dataUri: dataUri, initial: initial, palette: PALETTE };
})();
