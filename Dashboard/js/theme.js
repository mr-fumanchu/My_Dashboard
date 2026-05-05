(function () {
  function apply(t) {
    if (!t || t === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else if (t === 'system') {
      var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (dark) document.documentElement.setAttribute('data-theme', 'dark');
      else document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', t);
    }
  }
  var t = localStorage.getItem('dashboard_theme');
  apply(t);
  if (t === 'system' && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      apply('system');
    });
  }
}());
