// 1. AUMENTA IL NUMERO DI VERSIONE per forzare l'aggiornamento
const CACHE_NAME = 'cassa-pwa-v110';

const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './jsbarcode.js',
    './manifest.json',
    // Aggiungi qui tutte le icone che usi per farle funzionare offline!
    './icone/esci.png',
    './icone/whatsapp.png',
    './icone/telegram.png',
    './icone/dropbox.png',
    './icone/statistiche.png',
    './icone/preferiti.png',
    './icone/clienti.png',
    './icone/riconoscimento.png',
    './icone/calendario.png',
    './icone/contabilita.png',
    './icone/calcolatrice.png',
    './icone/cestino.png',
    './icone/dipendente.png',
    './icone/macchinetta.png',
    './icone/archivio.png',
    './icone/pos.png',
    './icone/note.png'
];

// Installazione e salvataggio in cache
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

// Attivazione e pulizia vecchie cache
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
});

// Intercetta le richieste e risponde con la cache se siamo offline
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );

});









