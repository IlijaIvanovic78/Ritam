// Tema pre prvog crtanja (CSP ne dozvoljava inline skripte). Podrazumevano je tamna.
(function () {
  try {
    var t = localStorage.getItem('ritam.theme');
    var r = document.documentElement;
    if (t === 'light') r.setAttribute('data-theme', 'light');
    else if (t === 'system') r.removeAttribute('data-theme');
  } catch (e) {}
})();
