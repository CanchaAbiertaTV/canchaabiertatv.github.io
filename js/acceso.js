// Acceso privado (13-11): la portada y el buscador piden contraseña. Va en el <head> como script
// NORMAL (no módulo) para cortar antes de pintar. OJO: es una puerta de cortesía, no seguridad:
// la web es estática y el repo de Pages es público. Los widgets (directo/marcador/plantilla) y la
// página de marca de Google (canchaabiertatv/) NO llevan puerta: romperían emisiones y la verificación.
(function () {
  var HASH = '44407a4f06c0092b913c93ec9dbee9b560cfb9cabbb71841bbced079d3b6a465';
  var KEY = 'cancha-abierta:acceso';
  var ok = false;
  try { ok = localStorage.getItem(KEY) === HASH; } catch (e) { /* sin almacenamiento */ }
  if (!ok) { try { ok = sessionStorage.getItem(KEY) === HASH; } catch (e) { /* idem */ } }
  if (ok) return;
  document.documentElement.style.visibility = 'hidden';
  var vuelta = location.pathname.replace(/^\//, '') + location.search + location.hash;
  location.replace('acceso.html?v=' + encodeURIComponent(vuelta || 'index.html'));
})();
