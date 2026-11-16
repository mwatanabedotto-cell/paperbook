// Copia la app web a desktop/www para empaquetarla.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'www');
fs.rmSync(out, { recursive: true, force: true });
for (const item of ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons', 'vendor']) {
  fs.cpSync(path.join(root, item), path.join(out, item), { recursive: true });
}
console.log('www listo');
